// Opt-in integration check. Uses the writer subscription once; never calls TTS.
// Reads a completed local episode and writes only to .qa/soundtrack-data.
import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSoundtrack } from '../server/soundtrack.ts';
import { remixAudio } from '../server/audio.ts';
import { available, run } from '../server/process.ts';
import type { Library } from '../shared/types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = path.join(root, '.qa', 'soundtrack-data');
process.env.DATA_DIR = dataRoot;
const { Store } = await import('../server/store.ts');
const response = await fetch('http://127.0.0.1:4310/api/library');
if (!response.ok) throw new Error('Run the local app first.');
const library = await response.json() as Library;
const episode = library.episodes.find(e => e.status === 'ready' && e.script && (!process.argv[2] || e.id === process.argv[2]));
if (!episode?.script || !episode.audioFile) throw new Error('No completed episode found.');
const podcast = library.podcasts.find(p => p.id === episode.podcastId)!;
const source = path.join(root, '.data', 'audio', episode.id);
const destination = path.join(dataRoot, 'audio', episode.id);
await mkdir(destination, { recursive: true });
const originalHash = createHash('sha256').update(await readFile(path.join(source, episode.audioFile))).digest('hex');
for (const name of await readdir(source)) {
  if (/^[a-f0-9]{24}\.wav$/.test(name) || name === path.basename(episode.audioFile)) await copyFile(path.join(source, name), path.join(destination, name));
}
console.log('Selecting sounds from the completed script…');
const plan = await planSoundtrack(episode.script, podcast.config.model, undefined, new AbortController().signal);
if (plan.source !== 'automatic') throw new Error(plan.note || 'Automatic direction did not complete.');
console.log(JSON.stringify({ theme: plan.themeId, cues: plan.cues.map(c => ({ kind: c.kind, clip: c.clipId, chapter: c.chapterIndex + 1, reason: c.reason })) }));
console.log('Mixing a copy of the recording without generating speech…');
const mp3 = await available(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']);
const started = Date.now();
const result = await remixAudio({ script: episode.script, config: podcast.config, directory: destination, soundtrack: plan, existingAudioFile: episode.audioFile, mp3 });
if (mp3) await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(destination, result.audioFile), '-f', 'null', '-'], { timeout: 180_000 });
const store = new Store(path.join(dataRoot, 'commute.sqlite'));
try {
  store.put('podcast', { ...podcast, title: 'Soundtrack check · ' + podcast.title, soundThemeId: plan.themeId });
  store.put('episode', { ...episode, ...result, soundtrack: plan });
} finally { store.close(); }
if (createHash('sha256').update(await readFile(path.join(source, episode.audioFile))).digest('hex') !== originalHash) throw new Error('Original audio changed.');
await writeFile(path.join(root, '.qa', 'soundtrack-smoke.json'), JSON.stringify({ ...result, plan, elapsedSeconds: (Date.now() - started) / 1000, originalAudioUnchanged: true }, null, 2));
console.log(JSON.stringify({ ...result, elapsedSeconds: (Date.now() - started) / 1000, originalAudioUnchanged: true }));
