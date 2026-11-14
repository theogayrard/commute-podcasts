import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.ts';
import { renderAudio, wavFromPcm } from '../server/audio.ts';
import { available, run } from '../server/process.ts';
import { Store, dataDir } from '../server/store.ts';
import { configSchema, type Episode, type Podcast, type Script } from '../shared/types.ts';

const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFMPEG_BIN
  ? path.join(path.dirname(ffmpeg), `ffprobe${path.extname(ffmpeg)}`) : 'ffprobe';
const cover = new URL('../assets/commute-cover.png', import.meta.url);
const audioHash = (file: string) => run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-']);

async function checkMetadata(file: string, title: string) {
  const info = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  assert.equal(info.format.tags.title, title);
  assert.equal(info.format.tags.artist, 'Commute');
  assert.equal(info.format.tags.album_artist, 'Commute');
  assert.equal(info.format.tags.author, 'Commute');
  assert.equal(info.format.tags.genre, 'Podcast');
  assert.equal(info.streams.filter((s: any) => s.codec_type === 'audio').length, 1);
  const pictures = info.streams.filter((s: any) => s.codec_type === 'video');
  assert.equal(pictures.length, 1);
  assert.equal(pictures[0].codec_name, 'png');
  assert.equal(pictures[0].disposition.attached_pic, 1);
  assert.equal(pictures[0].tags.comment, 'Cover (front)');
  assert.equal(pictures[0].width, 1000); assert.equal(pictures[0].height, 1000);
}

test('MP3 downloads tag new and existing recordings, embed the cover and preserve audio and seeking', async t => {
  if (!await available(ffmpeg, ['-version']) || !await available(ffprobe, ['-version'])) {
    t.skip('FFmpeg and FFprobe are needed for the MP3 integration test'); return;
  }
  const store = new Store(':memory:'); const { app, queue } = await createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = configSchema.parse({ topic: 'Learning about forests', hostIds: ['maya'], model: 'test-model' });
  const podcast: Podcast = { id: randomUUID(), title: 'The forest series', config, createdAt: new Date().toISOString() };
  const episodeId = randomUUID(); const directory = path.join(dataDir, 'audio', episodeId);
  const title = 'Épisode 2 — Forêts, l’eau & curiosité';
  const script: Script = { title, summary: '', references: [], chapters: [{ title: 'The forest', turns: [{ speaker: 'Maya', text: 'Let us explore a forest.' }] }] };
  try {
    const pcm = Buffer.alloc(96_000);
    for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 24_000) * 3000), i * 2);
    const rendered = await renderAudio({ script, config, directory, key: 'fixture', synthesize: async () => wavFromPcm(pcm), onProgress: () => {}, mp3: true });
    const episode: Episode = { id: episodeId, podcastId: podcast.id, number: 2, title, focus: '', script, status: 'ready', createdAt: podcast.createdAt, ...rendered };
    store.put('podcast', podcast); store.put('episode', episode);
    const originalFile = path.join(directory, rendered.audioFile);
    const original = await readFile(originalFile); const originalHash = await audioHash(originalFile);
    const url = `${root}/api/episodes/${episodeId}/audio`;

    // Concurrent downloads share the same complete export, including on the first request.
    const responses = await Promise.all([fetch(`${url}?download=1`), fetch(`${url}?download=1`)]);
    for (const response of responses) {
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /audio\/mpeg/);
      assert.match(response.headers.get('content-disposition')!, /attachment; filename="?commute-episode-2\.mp3"?$/);
    }
    const downloads = await Promise.all(responses.map(async response => Buffer.from(await response.arrayBuffer())));
    assert.deepEqual(downloads[0], downloads[1]);
    assert.equal(downloads[0].toString('ascii', 0, 3), 'ID3'); assert.equal(downloads[0][3], 3);
    const downloadedFile = path.join(directory, 'downloaded.mp3'); await writeFile(downloadedFile, downloads[0]);
    await checkMetadata(downloadedFile, title);
    assert.equal(await audioHash(downloadedFile), originalHash);
    const extractedCover = path.join(directory, 'extracted-cover.png');
    await run(ffmpeg, ['-v', 'error', '-i', downloadedFile, '-map', '0:v:0', '-c:v', 'copy', '-frames:v', '1', extractedCover]);
    assert.deepEqual(await readFile(extractedCover), await readFile(cover));
    assert.equal((await readdir(directory)).filter(file => /^download-.*\.mp3$/.test(file)).length, 1);
    assert.ok(!(await readdir(directory)).some(file => file.endsWith('.tmp')));

    const range = await fetch(`${url}?download=1`, { headers: { range: 'bytes=0-99' } });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-99/${downloads[0].length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), downloads[0].subarray(0, 100));
    const head = await fetch(`${url}?download=1`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), downloads[0].length);
    assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), original);
    assert.deepEqual(await readFile(originalFile), original);

    // A title change cannot return a cached download with stale tags.
    const renamed = 'Une nouvelle découverte'; store.put('episode', { ...episode, title: renamed });
    const updated = await fetch(`${url}?download=1`); assert.equal(updated.status, 200);
    await writeFile(downloadedFile, Buffer.from(await updated.arrayBuffer())); await checkMetadata(downloadedFile, renamed);

    // Old recordings and pinned old revisions take the same metadata path.
    const legacyFile = path.join(directory, 'episode.mp3');
    await run(ffmpeg, ['-v', 'error', '-i', originalFile, '-c:a', 'copy', '-metadata', 'title=Old title', '-metadata', 'artist=Someone else', '-metadata', 'genre=Music', legacyFile]);
    const legacy = await readFile(legacyFile);
    const previous = await fetch(`${url}?v=original&download=1`); assert.equal(previous.status, 200);
    await writeFile(downloadedFile, Buffer.from(await previous.arrayBuffer())); await checkMetadata(downloadedFile, renamed);
    assert.equal(await audioHash(downloadedFile), originalHash); assert.deepEqual(await readFile(legacyFile), legacy);
    store.put('episode', { ...episode, audioFile: 'episode.mp3', audioRevision: undefined });
    const legacyDownload = await fetch(`${url}?download=1`); assert.equal(legacyDownload.status, 200);
    await writeFile(downloadedFile, Buffer.from(await legacyDownload.arrayBuffer())); await checkMetadata(downloadedFile, title);
  } finally {
    queue.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.join(dataDir, 'audio')); assert.equal(path.basename(directory), episodeId);
    await rm(directory, { recursive: true, force: true });
  }
});
