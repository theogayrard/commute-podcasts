// Rebuild the shipped CC0 excerpts. Run explicitly with `npm run sounds:prepare`.
// Episode generation never downloads audio or contacts these sites.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUND_LIBRARY } from '../shared/sound-library.ts';
import { run } from '../server/process.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const downloads = path.join(root, '.qa', 'sound-sources');
const output = path.join(root, 'assets', 'sounds');
await mkdir(downloads, { recursive: true }); await mkdir(output, { recursive: true });
const sources = [
  { id: 'warm-piano', url: 'https://opengameart.org/sites/default/files/003_Vaporware_1.mp3', start: 12, bridge: 'piano-bridge', bridgeStart: 28 },
  { id: 'quiet-discovery', url: 'https://opengameart.org/sites/default/files/exploration_theme.ogg', start: 8, bridge: 'discovery-bridge', bridgeStart: 24 },
  { id: 'bright-ideas', url: 'https://opengameart.org/sites/default/files/piano1.4_0.ogg', start: 8, bridge: 'bright-bridge', bridgeStart: 24 },
  { id: 'forest', url: 'https://cdn.freesound.org/previews/687/687053_11532701-hq.mp3', start: 5 },
  { id: 'rain', url: 'https://cdn.freesound.org/previews/416/416227_5438412-hq.mp3', start: 5 },
  { id: 'ocean', url: 'https://cdn.freesound.org/previews/578/578524_5487341-hq.mp3', start: 3 },
  { id: 'fire', url: '', start: 5 },
];
const provenance: object[] = [];
for (const source of sources) {
  const clip = SOUND_LIBRARY.find(c => c.id === source.id)!;
  const page = await fetch(clip.sourceUrl, { signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error(`Could not verify source: ${clip.sourceUrl}`);
  const html = await page.text();
  if (!html.includes('creativecommons.org/publicdomain/zero/1.0')) throw new Error(`CC0 license not found for ${clip.id}`);
  if (!source.url) source.url = html.match(/https:\/\/cdn\.freesound\.org\/previews\/[^"'<>\s]+-hq\.mp3/)?.[0] || '';
  if (!source.url) throw new Error(`Missing download for ${source.id}`);
  const original = path.join(downloads, source.id + path.extname(new URL(source.url).pathname));
  let bytes: Buffer;
  try { bytes = await readFile(original); }
  catch {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`Download failed for ${source.id}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer()); await writeFile(original, bytes);
  }
  for (const edit of [{ id: source.id, start: source.start, seconds: 24 }, ...(source.bridge ? [{ id: source.bridge, start: source.bridgeStart!, seconds: 4 }] : [])]) {
    const filename = path.join(output, `${edit.id}.wav`);
    await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(edit.start), '-i', original, '-t', String(edit.seconds), '-af', `highpass=f=65,loudnorm=I=-20:TP=-3:LRA=7,afade=t=in:d=0.12,afade=t=out:st=${edit.seconds - .3}:d=0.3`, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', filename], { timeout: 120_000 });
    const asset = await readFile(filename);
    provenance.push({ ...SOUND_LIBRARY.find(c => c.id === edit.id), downloadUrl: source.url, licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', retrievedAt: new Date().toISOString(), sourceSha256: createHash('sha256').update(bytes).digest('hex'), assetSha256: createHash('sha256').update(asset).digest('hex'), excerptStartSeconds: edit.start, processing: 'Excerpt; 65 Hz high-pass; -20 LUFS normalization, -3 dBTP ceiling; short edge fades; 24 kHz mono 16-bit PCM.' });
    console.log(`${edit.id}: ${asset.length} bytes`);
  }
}
await writeFile(path.join(output, 'SOURCES.json'), JSON.stringify(provenance, null, 2) + '\n');
await writeFile(path.join(output, 'CREDITS.md'), '# Commute sound library\n\nThese ten excerpts are adapted from seven recordings released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Credits are preserved here and in the app. Original creators do not endorse Commute.\n\n' + sources.map(s => { const c = SOUND_LIBRARY.find(c => c.id === s.id)!; return `- **${c.originalTitle}** — ${c.artist}. [Source and license](${c.sourceUrl}).`; }).join('\n') + '\n\nSOURCES.json records the exact downloads, excerpt positions, processing and SHA-256 hashes. Freesound sources use the publicly available high-quality MP3 previews. Rebuild with `npm run sounds:prepare`; normal playback and mixing are entirely local.\n');
