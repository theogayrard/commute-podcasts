import { randomUUID } from 'node:crypto';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, dataDir } from '../server/store.ts';
import { configSchema, countWords, scriptSchema, type Episode, type Podcast } from '../shared/types.ts';

const [scriptPath, audioPath, metadataPath] = process.argv.slice(2);
if (!scriptPath || !audioPath || !metadataPath) throw new Error('Usage: npx tsx scripts/import-prototype.ts SCRIPT_JSON AUDIO_MP3 METADATA_JSON');
const raw = JSON.parse(await readFile(scriptPath, 'utf8'));
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const script = scriptSchema.parse({ title: 'Why AI can sound convincing and still be wrong', summary: 'The original two-host listening test: Maya and Leo explore why a confident answer is not always a correct one.', chapters: [{ title: 'The confidence trap', turns: raw.turns }], references: [
  { title: 'Google DeepMind · GopherCite', url: 'https://deepmind.google/blog/gophercite-teaching-language-models-to-support-answers-with-verified-quotes/' },
  { title: 'Google DeepMind · FACTS Grounding', url: 'https://deepmind.google/blog/facts-grounding-a-new-benchmark-for-evaluating-the-factuality-of-large-language-models/' },
] });
const store = new Store();
try {
  if (store.all<Podcast>('podcast').some(p => p.sample)) { console.log('Listening prototype is already in the library.'); }
  else {
    const podcast: Podcast = { id: randomUUID(), title: script.title, config: configSchema.parse({ topic: script.title, hostIds: ['maya', 'leo'], minutes: 5, tolerance: 1, model: 'ChatGPT listening prototype' }), createdAt: new Date('2026-11-06T00:45:00Z').toISOString(), sample: true };
    const episode: Episode = { id: randomUUID(), podcastId: podcast.id, number: 1, title: script.title, focus: script.summary, status: 'ready', script, audioFile: 'episode.mp3', durationSeconds: metadata.duration_seconds, wordCount: countWords(script), createdAt: podcast.createdAt };
    const directory = path.join(dataDir, 'audio', episode.id); await mkdir(directory, { recursive: true }); await copyFile(audioPath, path.join(directory, episode.audioFile!));
    store.transaction(() => { store.put('podcast', podcast); store.put('episode', episode); });
    console.log('Imported the original listening test.');
  }
} finally { store.close(); }
