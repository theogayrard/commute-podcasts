import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createApp } from '../server/app.ts';
import { Store, dataDir } from '../server/store.ts';
import { JobQueue } from '../server/queue.ts';
import { writePodcast } from '../server/writer.ts';
import { configSchema, type Episode, type Job, type Library, type Podcast, type Source } from '../shared/types.ts';

function seed(store: Store, count = 1, sourceIds: string[] = []) {
  const podcast = store.put<Podcast>('podcast', {
    id: randomUUID(), title: 'Cycling', createdAt: new Date().toISOString(),
    config: configSchema.parse({ topic: 'The science of cycling', hostIds: ['maya'], model: 'test', minutes: 5, tolerance: 1, episodeCount: count, sourceIds }),
    outline: { title: 'Cycling', summary: '', episodes: Array.from({ length: count }, (_, i) => ({ title: `Episode ${i + 1}`, focus: `Focus ${i + 1}`, chapters: [`Chapter ${i + 1}`] })) },
  });
  const episodes = Array.from({ length: count }, (_, i) => store.put<Episode>('episode', { id: randomUUID(), podcastId: podcast.id, number: i + 1, title: `Episode ${i + 1}`, focus: '', status: 'planned', createdAt: podcast.createdAt }));
  return { podcast, episodes };
}
function jobFor(podcastId: string, episodeId?: string, state: Job['state'] = 'done'): Job {
  return { id: randomUUID(), podcastId, ...(episodeId ? { episodeId } : {}), kind: episodeId ? 'audio' : 'write', state, progress: 0, message: '', createdAt: new Date().toISOString() };
}
async function serverFor(t: TestContext) {
  const store = new Store(':memory:'); const { app, queue } = await createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { queue.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const remove = (id: string, headers: Record<string, string> = { 'x-commute-client': '1' }) => fetch(`${root}/api/episodes/${id}`, { method: 'DELETE', headers });
  return { store, queue, root, remove };
}
async function audioDirectory(t: TestContext, id: string) {
  const directory = path.resolve(dataDir, 'audio', id);
  assert.equal(path.dirname(directory), path.resolve(dataDir, 'audio'));
  assert.match(path.basename(directory), /^[0-9a-f-]{36}$/);
  await mkdir(path.join(directory, 'chunks'), { recursive: true });
  await writeFile(path.join(directory, 'episode.wav'), 'test recording');
  await writeFile(path.join(directory, 'chunks', 'cached.wav'), 'cached section');
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(dataDir, 'audio')); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('deleting an episode removes its script, cached audio and jobs, preserving siblings and shared sources', async t => {
  const { store, queue, root, remove } = await serverFor(t);
  const source = store.put<Source>('source', { id: randomUUID(), kind: 'file', title: 'Notes', text: 'Shared notes', characters: 12, truncated: false, createdAt: new Date().toISOString() });
  const { podcast, episodes: [first, second] } = seed(store, 2, [source.id]);
  store.put<Episode>('episode', { ...first, status: 'ready', audioFile: 'episode.wav', script: { title: first.title, summary: '', chapters: [{ title: 'Chapter 1', turns: [{ speaker: 'Maya', text: 'A complete transcript.' }] }], references: [] } });
  const unrelated = seed(store, 1, [source.id]);
  const directory = await audioDirectory(t, first.id); const siblingDirectory = await audioDirectory(t, second.id);
  const deletedJobs = (['done', 'failed', 'cancelled'] as const).map(state => store.put('job', jobFor(podcast.id, first.id, state)));
  const siblingJob = store.put('job', jobFor(podcast.id, second.id)); const seriesJob = store.put('job', jobFor(podcast.id));
  const unrelatedJob = store.put('job', jobFor(unrelated.podcast.id, unrelated.episodes[0].id, 'queued'));

  const response = await remove(first.id); assert.equal(response.status, 200);
  const library = await response.json() as Library;
  assert.ok(!library.episodes.some(e => e.id === first.id));
  assert.equal(store.episode(first.id), undefined); await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(siblingDirectory, 'episode.wav'), 'utf8'), 'test recording');
  assert.deepEqual(store.episode(second.id), second); assert.deepEqual(store.podcast(podcast.id), podcast);
  for (const job of deletedJobs) assert.equal(store.job(job.id), undefined);
  assert.deepEqual(store.job(siblingJob.id), siblingJob); assert.deepEqual(store.job(seriesJob.id), seriesJob);
  assert.deepEqual(store.source(source.id), source); assert.deepEqual(store.job(unrelatedJob.id), unrelatedJob);
  assert.equal((await fetch(`${root}/api/episodes/${first.id}/audio`)).status, 404);
  assert.equal((await fetch(`${root}/api/episodes/${first.id}/script.txt`)).status, 404);
  assert.equal((await remove(first.id)).status, 404);
  // A generation request that was waiting on provider status cannot queue a deleted target.
  const jobsBefore = store.library().jobs;
  assert.throws(() => queue.add('audio', podcast.id, first.id), /Episode not found/);
  assert.throws(() => queue.addSeriesAudio(podcast.id, [second.id, first.id]), /Episode not found/);
  assert.deepEqual(store.library().jobs, jobsBefore);

  assert.equal((await remove(second.id)).status, 200);
  assert.equal(store.podcast(podcast.id), undefined); assert.equal(store.job(seriesJob.id), undefined); assert.equal(store.job(siblingJob.id), undefined);
  assert.deepEqual(store.source(source.id), source); assert.deepEqual(store.podcast(unrelated.podcast.id), unrelated.podcast);
  await assert.rejects(stat(siblingDirectory), { code: 'ENOENT' });
  assert.throws(() => queue.add('write', podcast.id), /Podcast not found/);
  const reloaded = await (await fetch(`${root}/api/library`)).json() as Library;
  assert.deepEqual(reloaded.episodes, unrelated.episodes); assert.deepEqual(reloaded.jobs, [unrelatedJob]);
});

test('deletion validates access and IDs and rejects queued or running work anywhere in the same series', async t => {
  const { store, remove } = await serverFor(t); const { podcast, episodes: [first, second] } = seed(store, 2);
  const directory = await audioDirectory(t, first.id);
  assert.equal((await remove(first.id, {})).status, 403);
  assert.equal((await remove(first.id, { 'x-commute-client': '1', origin: 'https://evil.example' })).status, 403);
  assert.equal((await remove('not-a-uuid')).status, 400); assert.equal((await remove(randomUUID())).status, 404);
  for (const state of ['queued', 'running'] as const) {
    for (const episodeId of [undefined, first.id, second.id]) {
      const job = store.put('job', jobFor(podcast.id, episodeId, state));
      const response = await remove(first.id); assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /generation to finish/);
      assert.deepEqual(store.episode(first.id), first); assert.deepEqual(store.job(job.id), job);
      assert.equal(await readFile(path.join(directory, 'episode.wav'), 'utf8'), 'test recording');
      store.remove('job', job.id);
    }
  }
  // A draft without an audio directory can also be removed.
  assert.equal((await remove(second.id)).status, 200);
});

test('a cancelled worker stays busy until it exits, preventing deletion or restart while it can still write', async t => {
  const store = new Store(':memory:'); const { podcast, episodes: [episode] } = seed(store);
  store.put<Episode>('episode', { ...episode, status: 'review', script: { title: 'Cycling', summary: '', chapters: [{ title: 'Chapter 1', turns: [{ speaker: 'Maya', text: 'A test conversation.' }] }], references: [] } });
  await audioDirectory(t, episode.id);
  const queue = new JobQueue(store, () => 'unused-test-key', () => false);
  const job = queue.add('audio', podcast.id, episode.id);
  // renderAudio is still awaiting mkdir; abort before any provider request can start.
  queue.cancel(job.id);
  assert.equal(store.job(job.id)?.state, 'cancelled'); assert.equal(queue.isBusy(podcast.id), true);
  assert.throws(() => queue.add('audio', podcast.id, episode.id), /generation in progress/);
  for (let attempt = 0; queue.isBusy(podcast.id) && attempt < 100; attempt++) await delay(10);
  assert.equal(queue.isBusy(podcast.id), false);
  store.deleteEpisode(episode.id); assert.equal(store.episode(episode.id), undefined); store.close();
});

test('writing the remaining series uses the original chapter plans without recreating deleted episodes', async () => {
  const store = new Store(':memory:'); const { podcast, episodes } = seed(store, 3); let calls = 0;
  try {
    store.deleteEpisode(episodes[1].id);
    await writePodcast(store, jobFor(podcast.id), () => {}, new AbortController().signal, async () => {
      calls++; return { turns: [{ speaker: 'Maya', text: 'word '.repeat(725).trim() }], references: [] };
    });
    assert.equal(calls, 2); assert.equal(store.episode(episodes[1].id), undefined);
    assert.equal(store.episode(episodes[0].id)?.script?.chapters[0].title, 'Chapter 1');
    assert.equal(store.episode(episodes[2].id)?.script?.chapters[0].title, 'Chapter 3');
    assert.deepEqual(store.library().episodes.map(e => [e.number, e.status]), [[1, 'review'], [3, 'review']]);
  } finally { store.close(); }
});
