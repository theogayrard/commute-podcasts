import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configSchema, type Episode, type Job, type Outline, type Podcast } from '../shared/types.ts';
import type { GenerateJson } from '../server/codex.ts';
import { Store } from '../server/store.ts';
import { writePodcast } from '../server/writer.ts';

function draft(episodeCount = 1) {
  const store = new Store(':memory:');
  const podcast: Podcast = { id: randomUUID(), title: 'How AI agents work', createdAt: new Date().toISOString(), config: configSchema.parse({ topic: 'How AI agents work', hostIds: ['leo', 'atlas'], model: 'test-model', minutes: 30, episodeCount }) };
  store.put('podcast', podcast);
  const episodes = Array.from({ length: episodeCount }, (_, index) => store.put<Episode>('episode', { id: randomUUID(), podcastId: podcast.id, number: index + 1, title: podcast.title, focus: '', status: 'planned', createdAt: podcast.createdAt }));
  const job: Job = { id: randomUUID(), podcastId: podcast.id, kind: 'write', state: 'running', progress: 0, message: '', createdAt: podcast.createdAt };
  return { store, podcast, episodes, job };
}
function outline(episodeCount = 1, chapterCount = 6): Outline {
  return { title: 'Understanding agents', summary: 'An explanation of AI agents', episodes: Array.from({ length: episodeCount }, (_, i) => ({ title: `Episode ${i + 1}`, focus: `Focus ${i + 1}`, chapters: Array.from({ length: chapterCount }, (_, j) => `Episode ${i + 1} chapter ${j + 1}`) })) };
}
const chapter = { turns: [{ speaker: 'Leo', text: 'word '.repeat(725).trim() }], references: [] };

for (const episodeCount of [1, 2]) test(`repairs an incomplete ${episodeCount === 1 ? 'single episode' : 'series'} plan before saving or writing chapters`, async () => {
  const { store, podcast, episodes, job } = draft(episodeCount);
  const messages: string[] = []; let planningCalls = 0; let chapterCalls = 0;
  const generate: GenerateJson = async (prompt, schema, model, research) => {
    const json = schema as any;
    if (json.properties.episodes) {
      planningCalls++;
      assert.equal(model, 'test-model');
      assert.equal(json.properties.episodes.minItems, episodeCount);
      assert.equal(json.properties.episodes.maxItems, episodeCount);
      assert.equal(json.properties.episodes.items.properties.chapters.minItems, 6);
      assert.equal(json.properties.episodes.items.properties.chapters.maxItems, 6);
      assert.equal(store.podcast(podcast.id)?.outline, undefined);
      assert.equal(store.podcast(podcast.id)?.title, podcast.title);
      assert.ok(episodes.every(e => !store.episode(e.id)?.script));
      if (planningCalls === 1) { assert.equal(research, true); return episodeCount === 1 ? outline(1, 5) : outline(1, 6); }
      assert.match(prompt, /previous plan did not match/);
      assert.match(prompt, /entire complete plan/);
      assert.equal(research, false);
      return outline(episodeCount);
    }
    chapterCalls++; return chapter;
  };
  try {
    await writePodcast(store, job, (_progress, message) => messages.push(message), new AbortController().signal, generate);
    assert.equal(planningCalls, 2); assert.equal(chapterCalls, episodeCount * 6);
    assert.equal(store.podcast(podcast.id)?.outline?.episodes.length, episodeCount);
    assert.ok(messages.some(message => message.includes('attempt 2 of 3')));
    for (const episode of episodes) {
      const result = store.episode(episode.id)!;
      assert.equal(result.status, 'review'); assert.equal(result.script?.chapters.length, 6);
      assert.equal(result.wordCount, 4350); assert.equal(result.estimatedMinutes, 30);
    }
  } finally { store.close(); }
});

test('invalid plans stop after three attempts and never persist partial planning data', async () => {
  const { store, podcast, episodes, job } = draft(); let calls = 0;
  try {
    await assert.rejects(writePodcast(store, job, () => {}, new AbortController().signal, async () => { calls++; return outline(1, 5); }), /episode plan after 3 attempts\. Expected 1 episode with 6 chapters/);
    assert.equal(calls, 3); assert.equal(store.podcast(podcast.id)?.outline, undefined);
    assert.equal(store.podcast(podcast.id)?.title, podcast.title);
    assert.equal(store.episode(episodes[0].id)?.status, 'planned'); assert.equal(store.episode(episodes[0].id)?.script, undefined);
  } finally { store.close(); }
});

test('cancelling during planning does not trigger a repair request or save the plan', async () => {
  const { store, podcast, job } = draft(); const controller = new AbortController(); let calls = 0;
  try {
    await assert.rejects(writePodcast(store, job, () => {}, controller.signal, async () => { calls++; controller.abort(); return outline(); }), { name: 'AbortError' });
    assert.equal(calls, 1); assert.equal(store.podcast(podcast.id)?.outline, undefined);
  } finally { store.close(); }
});

test('provider failures are not treated as malformed plans and retried', async () => {
  const { store, podcast, job } = draft(); let calls = 0;
  try {
    await assert.rejects(writePodcast(store, job, () => {}, new AbortController().signal, async () => { calls++; throw new Error('Subscription limit reached'); }), /Subscription limit reached/);
    assert.equal(calls, 1); assert.equal(store.podcast(podcast.id)?.outline, undefined);
  } finally { store.close(); }
});
