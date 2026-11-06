import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.ts';
import { Store, dataDir } from '../server/store.ts';
import { configSchema, type Episode, type Podcast } from '../shared/types.ts';
import { wavFromPcm } from '../server/audio.ts';

test('HTTP workflow validates inputs, persists drafts, imports scripts and serves seekable audio from the private data directory', async () => {
  const store = new Store(':memory:'); const { app, queue } = await createApp(store);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number }; const root = `http://127.0.0.1:${address.port}`;
  const headers = { 'content-type': 'application/json', 'x-commute-client': '1' };
  const request = (url: string, body: unknown, method = 'POST') => fetch(root + url, { method, headers, body: JSON.stringify(body) });
  const audioId = randomUUID(); const audioDir = path.join(dataDir, 'audio', audioId);
  try {
    assert.equal((await fetch(root + '/api/health')).status, 200);
    const untrustedHostStatus = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(root + '/api/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(untrustedHostStatus, 403);
    const config = configSchema.parse({ topic: 'A series about bicycles', hostIds: ['maya', 'leo'], model: 'test-model', episodeCount: 3 });
    assert.equal((await fetch(root + '/api/podcasts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })).status, 403);
    assert.equal((await fetch(root + '/api/podcasts', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify(config) })).status, 403);
    assert.equal((await request('/api/podcasts', { ...config, sourceIds: [randomUUID()] })).status, 400);
    const created = await request('/api/podcasts', config); assert.equal(created.status, 201); const podcast = await created.json() as Podcast;
    const episodes = store.all<Episode>('episode').filter(e => e.podcastId === podcast.id); assert.equal(episodes.length, 3);
    const episode = episodes[0];
    const edit = await request(`/api/episodes/${episode.id}/script`, { text: '## The story\n\nMaya: How do bicycles work?\n\nLeo: They convert the motion of your legs into forward motion.' }, 'PUT'); assert.equal(edit.status, 200);
    assert.equal(store.episode(episode.id)?.status, 'review');
    assert.equal((await request(`/api/episodes/${episode.id}/script`, { text: '## Invalid\n\nStranger: I was not selected for this podcast.' }, 'PUT')).status, 400);
    const text = await fetch(root + `/api/episodes/${episode.id}/script.txt`); assert.equal(text.status, 200); assert.match(await text.text(), /Maya:/);
    const form = new FormData(); form.append('file', new Blob(['This is public test source material about the science of cycling. '.repeat(8)]), 'test.txt');
    const upload = await fetch(root + '/api/sources/file', { method: 'POST', headers: { 'x-commute-client': '1' }, body: form }); assert.equal(upload.status, 201); assert.ok((await upload.json() as { id: string }).id);
    assert.equal((await request('/api/sources/url', { url: 'http://127.0.0.1/private' })).status, 400);
    assert.equal((await fetch(root + '/api/episodes/not-a-uuid/audio')).status, 400);
    store.put<Episode>('episode', { ...episode, id: audioId, status: 'ready', audioFile: 'episode.wav' });
    await mkdir(audioDir, { recursive: true }); await writeFile(path.join(audioDir, 'episode.wav'), wavFromPcm(Buffer.alloc(48_000)));
    const audio = await fetch(root + `/api/episodes/${audioId}/audio`, { headers: { range: 'bytes=0-99' } });
    assert.equal(audio.status, 206); assert.equal(audio.headers.get('content-range'), 'bytes 0-99/48044'); assert.equal((await audio.arrayBuffer()).byteLength, 100);
    const download = await fetch(root + `/api/episodes/${audioId}/audio?download=1`, { method: 'HEAD' }); assert.match(download.headers.get('content-disposition')!, /attachment/);
    // The audio route is explicit; private settings and database files are never exposed.
    assert.equal((await fetch(root + '/.data/settings.json')).status, 404);
  } finally {
    queue.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    assert.equal(path.dirname(path.resolve(audioDir)), path.join(dataDir, 'audio')); assert.equal(path.basename(audioDir), audioId); await rm(audioDir, { recursive: true, force: true });
  }
});
