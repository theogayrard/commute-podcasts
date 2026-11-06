import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOUND_LIBRARY } from '../shared/sound-library.ts';
import { validateCues } from '../shared/soundtrack.ts';
import { configSchema, type Script, type Podcast, type Episode, type Job } from '../shared/types.ts';
import { basicSoundtrack, editSoundtrack, planSoundtrack, scriptHash, soundtrackHash } from '../server/soundtrack.ts';
import { mixSoundtrack, soundPath } from '../server/sound-mix.ts';
import { renderAudio, remixAudio, wavFromPcm, pcmFromWav } from '../server/audio.ts';
import { Store, dataDir } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { writePodcast } from '../server/writer.ts';
import { available, run } from '../server/process.ts';

const config = configSchema.parse({ topic: 'How forests shape the world', hostIds: ['maya'], model: 'test-model' });
const script: Script = { title: 'A walk in the woods', summary: 'Explore a forest.', references: [], chapters: [
  { title: 'The invitation', turns: [{ speaker: 'Maya', text: 'Come along as we explore the forest.' }] },
  { title: 'Among the trees', turns: [{ speaker: 'Maya', text: 'Imagine walking beneath tall trees and hearing birds overhead.' }] },
  { title: 'Taking it home', turns: [{ speaker: 'Maya', text: 'Thank you for joining us. Until next time.' }] },
] };
function tone(seconds: number, amplitude = .1, frequency = 220) {
  const pcm = Buffer.alloc(Math.round(seconds * 24_000) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / 24_000) * amplitude * 32767), i * 2);
  return pcm;
}
async function temporary(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'commute-sound-test-'));
  try { await fn(directory); }
  finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('commute-sound-test-')); await rm(directory, { recursive: true, force: true }); }
}

test('every shipped clip has intact, audible PCM, exact duration and recorded CC0 provenance', async () => {
  const provenance = JSON.parse(await readFile(new URL('../assets/sounds/SOURCES.json', import.meta.url), 'utf8'));
  assert.equal(SOUND_LIBRARY.length, 10);
  for (const clip of SOUND_LIBRARY) {
    const wav = await readFile(soundPath(clip.id)); const pcm = pcmFromWav(wav);
    assert.ok(Math.abs(pcm.length / 48000 - clip.seconds) < .02, clip.id);
    let square = 0; let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) { const sample = pcm.readInt16LE(i) / 32768; square += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
    assert.ok(Math.sqrt(square / (pcm.length / 2)) > .01, `${clip.id} is audible`);
    assert.ok(peak < .9, `${clip.id} leaves headroom`);
    const source = provenance.find((p: any) => p.id === clip.id);
    assert.equal(source.license, 'CC0-1.0'); assert.equal(source.sourceUrl, clip.sourceUrl);
    assert.equal(source.assetSha256, createHash('sha256').update(wav).digest('hex'));
  }
  assert.throws(() => soundPath('../../.env'), /not found/);
});

test('cue edits reject unknown clips, invalid gains, long transitions, missing chapters and duplicate locations', () => {
  const plan = basicSoundtrack(script);
  assert.doesNotThrow(() => editSoundtrack(plan, script));
  for (const change of [{ clipId: '../../.env' }, { clipId: 'forest' }, { volumeDb: 4 }, { durationSeconds: 60 }, { chapterIndex: 8 }, { chapterIndex: 1 }]) {
    assert.throws(() => editSoundtrack({ ...plan, cues: [{ ...plan.cues[0], ...change }] }, script));
  }
  assert.throws(() => editSoundtrack({ ...plan, cues: [plan.cues[0], { ...plan.cues[0], id: 'duplicate' }] }, script), /one cue/);
  assert.throws(() => editSoundtrack({ ...plan, cues: [{ ...plan.cues[0], id: 'bridge', kind: 'transition', clipId: 'piano-bridge', chapterIndex: 1, durationSeconds: 6 }] }, script), /longer/);
});

test('automatic direction reads the script, keeps the series theme and selects a literal scene at a chapter boundary', async () => {
  const long: Script = { ...script, chapters: script.chapters.map(c => ({ ...c, turns: [{ ...c.turns[0], text: c.turns[0].text + ' words'.repeat(450) }] })) };
  const plan = await planSoundtrack(long, config.model, 'quiet-discovery', new AbortController().signal, async (prompt, _schema, model, research) => {
    assert.match(prompt, /Imagine walking beneath tall trees/); assert.match(prompt, /START of their chapter/); assert.match(prompt, /metaphors/);
    assert.equal(model, config.model); assert.equal(research, false);
    return { themeId: 'warm-piano', moments: [{ chapterIndex: 1, kind: 'ambience', clipId: 'forest', durationSeconds: 12, reason: 'Birds and trees set the woodland scene.' }] };
  });
  assert.equal(plan.source, 'automatic'); assert.equal(plan.themeId, 'quiet-discovery');
  assert.deepEqual(plan.cues.map(c => c.clipId), ['quiet-discovery', 'forest', 'quiet-discovery']);
});

test('failed or invalid direction falls back explicitly to bookends; cancellation never becomes a fallback', async () => {
  const fallback = await planSoundtrack(script, config.model, undefined, new AbortController().signal, async () => { throw new Error('limit'); });
  assert.equal(fallback.source, 'basic'); assert.equal(fallback.cues.length, 2); assert.match(fallback.note!, /unavailable/);
  const invalid = await planSoundtrack(script, config.model, undefined, new AbortController().signal, async () => ({ themeId: 'unknown', moments: [] }));
  assert.equal(invalid.source, 'basic');
  const controller = new AbortController();
  await assert.rejects(planSoundtrack(script, config.model, undefined, controller.signal, async () => { controller.abort(); return {}; }), { name: 'AbortError' });
});

test('mixing preserves narration in quiet passages, inserts chapter transitions at measured times and cannot clip', async () => {
  const voice = tone(60); const plan = basicSoundtrack(script);
  plan.cues.splice(1, 0, { id: 'bridge', kind: 'transition', clipId: 'piano-bridge', chapterIndex: 1, durationSeconds: 3, volumeDb: -12, reason: 'A new idea.' });
  const mixed = await mixSoundtrack(voice, { chapterStarts: [0, 20, 40], durationSeconds: 60, timing: 'chapters' }, plan);
  assert.equal(mixed.pcm.length / 48000, 63.85);
  assert.equal(mixed.renderedCues.find(c => c.id === 'bridge')!.startSeconds, 21.2);
  // The original speech at 10 seconds survives unchanged apart from integer rounding.
  for (let i = 0; i < 24000; i++) assert.ok(Math.abs(mixed.pcm.readInt16LE((Math.round(11.2 * 24000) + i) * 2) - voice.readInt16LE((240000 + i) * 2)) <= 1);
  const hot = await mixSoundtrack(tone(60, .999), { chapterStarts: [0, 20, 40], durationSeconds: 60, timing: 'chapters' }, plan);
  for (let i = 0; i < hot.pcm.length; i += 2) assert.ok(Math.abs(hot.pcm.readInt16LE(i)) <= 31785);
});

test('voice-only output is byte-identical and short recordings do not stack overlapping cues', async () => {
  const voice = tone(2); const plan = basicSoundtrack(script);
  const off = await mixSoundtrack(voice, { chapterStarts: [0], durationSeconds: 2, timing: 'episode' }, { ...plan, enabled: false });
  assert.deepEqual(off.pcm, voice);
  const short = await mixSoundtrack(voice, { chapterStarts: [0], durationSeconds: 2, timing: 'episode' }, plan);
  for (let i = 1; i < short.renderedCues.length; i++) assert.ok(short.renderedCues[i].startSeconds >= short.renderedCues[i - 1].startSeconds + short.renderedCues[i - 1].durationSeconds);
});

test('render, repeated remix, removing music and recovering old section caches never resynthesize narration', async () => temporary(async directory => {
  let calls = 0; const synthesize = async () => { calls++; return wavFromPcm(tone(12)); };
  const options = { script, config, directory, key: 'fixture', onProgress: () => {}, synthesize };
  const initial = await renderAudio(options); assert.equal(calls, 3);
  const dry = await readFile(path.join(directory, 'narration.wav'));
  const plan = basicSoundtrack(script);
  const mixed = await remixAudio({ script, config, directory, soundtrack: plan });
  assert.equal(calls, 3); assert.notEqual(mixed.audioFile, initial.audioFile); assert.equal(mixed.narrationTiming, 'chapters');
  const repeat = await remixAudio({ script, config, directory, soundtrack: { ...plan, cues: plan.cues.map(c => ({ ...c, volumeDb: -20 })) } });
  assert.notEqual(repeat.audioRevision, mixed.audioRevision); assert.equal(calls, 3);
  assert.deepEqual(await readFile(path.join(directory, 'narration.wav')), dry);
  const off = await remixAudio({ script, config, directory, soundtrack: { ...plan, enabled: false } });
  assert.deepEqual(pcmFromWav(await readFile(path.join(directory, off.audioFile))), pcmFromWav(dry));
  // Only these two exact generated files are removed to simulate a pre-feature recording.
  await rm(path.join(directory, 'narration.json')); await rm(path.join(directory, 'narration.wav'));
  const recovered = await remixAudio({ script, config, directory, soundtrack: plan, existingAudioFile: initial.audioFile });
  assert.equal(recovered.narrationTiming, 'chapters'); assert.equal(recovered.durationSeconds, mixed.durationSeconds); assert.equal(calls, 3);
  const rerecorded = await renderAudio({ ...options, soundtrack: plan }); assert.equal(calls, 3); assert.equal(rerecorded.audioRevision, mixed.audioRevision);
}));

test('imported speech supports bookends and discloses skipped chapter cues', async () => temporary(async directory => {
  await writeFile(path.join(directory, 'old.wav'), wavFromPcm(tone(30)));
  const plan = basicSoundtrack(script);
  plan.cues.splice(1, 0, { id: 'forest-scene', kind: 'ambience', clipId: 'forest', chapterIndex: 1, durationSeconds: 12, volumeDb: -16, reason: 'The trees.' });
  const result = await remixAudio({ script, config, directory, soundtrack: plan, existingAudioFile: 'old.wav' });
  assert.equal(result.narrationTiming, 'episode'); assert.match(result.mixNote!, /no chapter timings/);
  assert.deepEqual(result.renderedCues.map(c => c.id), ['opening', 'closing']);
}));

test('missing dry audio, stale cues and cancellation leave previously completed outputs intact', async () => temporary(async directory => {
  await writeFile(path.join(directory, 'old.wav'), wavFromPcm(tone(2)));
  const old = await readFile(path.join(directory, 'old.wav'));
  await assert.rejects(remixAudio({ script, config, directory, existingAudioFile: 'old.wav', previouslyMixed: true }), /no new speech/);
  await assert.rejects(remixAudio({ script, config, directory, existingAudioFile: 'old.wav', soundtrack: { ...basicSoundtrack(script), scriptHash: 'stale' } }), /script changed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(remixAudio({ script, config, directory, existingAudioFile: 'old.wav', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readFile(path.join(directory, 'old.wav')), old);
}));

test('writing a series adds sound direction after each complete script and keeps its selected theme', async () => {
  const store = new Store(':memory:');
  const podcast: Podcast = { id: randomUUID(), title: script.title, config: { ...config, minutes: 5, episodeCount: 2, soundDesign: 'subtle' }, createdAt: new Date().toISOString() };
  store.put('podcast', podcast);
  const episodes = [1, 2].map(number => store.put<Episode>('episode', { id: randomUUID(), podcastId: podcast.id, number, title: script.title, focus: '', status: 'planned', createdAt: podcast.createdAt }));
  const job: Job = { id: randomUUID(), podcastId: podcast.id, kind: 'write', state: 'running', progress: 0, message: '', createdAt: podcast.createdAt };
  let selections = 0;
  try {
    await writePodcast(store, job, () => {}, new AbortController().signal, async (prompt, schema) => {
      const properties = (schema as any).properties;
      if (properties.episodes) return { title: script.title, summary: 'Nature', episodes: episodes.map(e => ({ title: `Part ${e.number}`, focus: 'The forest', chapters: ['A walk'] })) };
      if (properties.themeId) { selections++; if (selections === 2) assert.match(prompt, /series theme exactly: quiet-discovery/); return { themeId: selections === 1 ? 'quiet-discovery' : 'warm-piano', moments: [] }; }
      return { turns: [{ speaker: 'Maya', text: 'word '.repeat(725).trim() }], references: [] };
    });
    assert.equal(selections, 2); assert.equal(store.podcast(podcast.id)?.soundThemeId, 'quiet-discovery');
    for (const e of episodes) { assert.equal(store.episode(e.id)?.status, 'review'); assert.equal(store.episode(e.id)?.soundtrack?.themeId, 'quiet-discovery'); }
  } finally { store.close(); }
});

test('sound HTTP routes validate edits, serve range previews and mix without any Gemini credential', async () => {
  const store = new Store(':memory:'); const { app, queue } = await createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'content-type': 'application/json', 'x-commute-client': '1' };
  const podcast: Podcast = { id: randomUUID(), title: script.title, config, createdAt: new Date().toISOString() };
  const episode: Episode = { id: randomUUID(), podcastId: podcast.id, number: 1, title: script.title, focus: '', status: 'ready', script, audioFile: 'episode.wav', durationSeconds: 6, createdAt: podcast.createdAt };
  const directory = path.join(dataDir, 'audio', episode.id);
  const put = (body: unknown) => fetch(`${root}/api/episodes/${episode.id}/soundtrack`, { method: 'PUT', headers, body: JSON.stringify(body) });
  try {
    store.put('podcast', podcast); store.put('episode', episode); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'episode.wav'), wavFromPcm(tone(6)));
    const original = await fetch(`${root}/api/episodes/${episode.id}/audio?v=original`); assert.equal(original.status, 200); await original.arrayBuffer();
    const catalogue = await fetch(`${root}/api/sounds`); assert.equal((await catalogue.json() as unknown[]).length, 10);
    const preview = await fetch(`${root}/api/sounds/forest/audio`, { headers: { range: 'bytes=0-99' } }); assert.equal(preview.status, 206); assert.equal((await preview.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${root}/api/sounds/unknown/audio`)).status, 404);
    const invalid = await put({ ...basicSoundtrack(script), cues: [{ ...basicSoundtrack(script).cues[0], clipId: 'unknown' }] }); assert.equal(invalid.status, 400);
    const edited = await put(basicSoundtrack(script)); assert.equal(edited.status, 200); assert.equal(store.episode(episode.id)?.soundtrackDirty, true);
    // Queueing directly avoids status discovery and proves the mix worker never asks for a key.
    const job = queue.add('mix', podcast.id, episode.id);
    for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(store.job(job.id)!.state); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(store.job(job.id)?.state, 'done', store.job(job.id)?.error);
    const result = store.episode(episode.id)!; assert.equal(result.soundtrackDirty, false); assert.equal(result.narrationTiming, 'episode');
    assert.equal(result.mixedSoundtrackHash, soundtrackHash(result.soundtrack)); await access(path.join(directory, result.audioFile!));
    const originalAfterMix = await fetch(`${root}/api/episodes/${episode.id}/audio?v=original`); assert.equal(originalAfterMix.status, 200); assert.deepEqual(Buffer.from(await originalAfterMix.arrayBuffer()), wavFromPcm(tone(6)));
    assert.equal((await fetch(`${root}/api/episodes/${episode.id}/audio?v=../../settings.json`)).status, 400);
    const updated = await put({ ...result.soundtrack, enabled: false }); assert.equal(updated.status, 200); assert.equal(store.episode(episode.id)?.soundtrackDirty, true);
    const edit = await fetch(`${root}/api/episodes/${episode.id}/script`, { method: 'PUT', headers, body: JSON.stringify({ text: '## New script\n\nMaya: This is a different conversation about trees.' }) });
    assert.equal(edit.status, 200); assert.equal(store.episode(episode.id)?.soundtrack, undefined); assert.equal(store.episode(episode.id)?.audioFile, undefined);
    assert.equal((await fetch(`${root}/api/episodes/${episode.id}/soundtrack/mix`, { method: 'POST', headers })).status, 400);
  } finally {
    queue.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.join(dataDir, 'audio')); assert.equal(path.basename(directory), episode.id); await rm(directory, { recursive: true, force: true });
  }
});

test('FFmpeg encodes an actual music mix as a playable MP3', async t => {
  if (!await available(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'])) { t.skip('FFmpeg not installed'); return; }
  await temporary(async directory => {
    const result = await renderAudio({ script, config, directory, key: 'fixture', synthesize: async () => wavFromPcm(tone(4)), onProgress: () => {}, soundtrack: basicSoundtrack(script), mp3: true });
    assert.match(result.audioFile, /\.mp3$/); assert.ok((await readFile(path.join(directory, result.audioFile))).length > 20_000);
    await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(directory, result.audioFile), '-f', 'null', '-']);
    assert.equal(result.renderedCues.length, 2); assert.ok(result.durationSeconds > 12);
  });
});
