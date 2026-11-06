import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configSchema, countWords, type Episode, type Job, type Podcast, type Script } from '../shared/types.ts';
import { splitTurns, ttsPayload, pcmFromWav, wavFromPcm, renderAudio } from '../server/audio.ts';
import { validateSourceUrl, isPublicAddress, youtubeId, fileSource } from '../server/sources.ts';
import { Store } from '../server/store.ts';
import { JobQueue } from '../server/queue.ts';
import { parseTranscript, scriptToText, writePodcast } from '../server/writer.ts';

const config = configSchema.parse({ topic: 'How does a bicycle stay upright?', hostIds: ['maya', 'leo'], model: 'test-model' });
const script: Script = { title: 'A good question', summary: 'A small test', chapters: [{ title: 'An opening', turns: [{ speaker: 'Maya', text: 'What keeps us moving?' }, { speaker: 'Leo', text: 'A little curiosity helps.' }] }], references: [] };
async function temporary<T>(fn: (directory: string) => Promise<T>) { const dir = await mkdtemp(path.join(tmpdir(), 'commute-test-')); try { return await fn(dir); } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('commute-test-')); await rm(dir, { recursive: true, force: true }); } }

test('defaults to a 30-minute commute with tolerance; rejects invalid hosts, duration, and source policy', () => {
  assert.equal(config.minutes, 30); assert.equal(config.tolerance, 3);
  for (const change of [{ hostIds: ['maya', 'maya'] }, { hostIds: ['maya', 'leo', 'june'] }, { minutes: 5, tolerance: 5 }, { minutes: 0 }, { episodeCount: 13 }, { sourceMode: 'provided' }]) assert.equal(configSchema.safeParse({ ...config, ...change }).success, false);
});
test('rejects local, mapped, encoded, and non-http source destinations', () => {
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://192.168.1.2', 'http://169.254.169.254', 'https://example.com:444', 'http://user:pass@example.com']) assert.throws(() => validateSourceUrl(url), Error, url);
  for (const ip of ['10.1.2.3', '172.16.0.1', '100.64.1.1', '192.168.2.3', '0.0.0.0', '::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(validateSourceUrl('https://example.com/article').hostname, 'example.com');
});
test('YouTube links are restricted to recognized public video forms', () => {
  assert.equal(youtubeId(new URL('https://youtu.be/abcdefghijk')), 'abcdefghijk');
  assert.equal(youtubeId(new URL('https://www.youtube.com/watch?v=abcdefghijk&t=2')), 'abcdefghijk');
  assert.equal(youtubeId(new URL('https://youtube.com/shorts/abcdefghijk')), 'abcdefghijk');
  assert.equal(youtubeId(new URL('https://youtube.com.evil.example/watch?v=abcdefghijk')), undefined);
  assert.equal(youtubeId(new URL('https://youtube.com/watch?v=../private')), undefined);
});
test('file ingestion reads real text, reports truncation, and rejects unsupported or empty files', async () => {
  const result = await fileSource(Buffer.from('Readable source material. '.repeat(4000)), 'notes.txt');
  assert.equal(result.text.length, 60_000); assert.equal(result.truncated, true); assert.equal(result.kind, 'file');
  await assert.rejects(fileSource(Buffer.from('tiny'), 'notes.txt'), /too little/);
  await assert.rejects(fileSource(Buffer.from('x'.repeat(100)), 'run.exe'), /Supported files/);
});
test('PDF ingestion extracts text from an actual PDF document', async () => {
  const text = 'This is a source about bicycles, balance, and the everyday science of getting to work. A bicycle is a useful way to explore motion.';
  const stream = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const source = await fileSource(Buffer.from(pdf), 'bicycles.pdf'); assert.match(source.text, /bicycles, balance/);
});
test('chunking preserves every turn and never crosses the target at a turn boundary', () => {
  const turns = Array.from({ length: 17 }, (_, i) => ({ speaker: i % 2 ? 'Leo' : 'Maya', text: `${i}: ` + 'a'.repeat(400) }));
  const chunks = splitTurns(turns, 1000);
  assert.deepEqual(chunks.flat(), turns); assert.ok(chunks.every(c => c.reduce((n, t) => n + t.text.length, 0) <= 1000));
});
test('Gemini request uses structured speech metadata and distinct solo/two-speaker configurations', () => {
  const duo = ttsPayload(script.chapters[0].turns, config); assert.deepEqual(duo.generation_config.speech_config, { speakers: [{ speaker: 'Maya', voice: 'Kore' }, { speaker: 'Leo', voice: 'Puck' }] });
  assert.equal(duo.input[0].content[0].annotations[0].speaker, 'Maya'); assert.equal(duo.input[0].content[0].text, 'What keeps us moving?');
  const solo = ttsPayload([script.chapters[0].turns[0]], { ...config, hostIds: ['maya'] }); assert.deepEqual(solo.generation_config.speech_config, [{ voice: 'Kore' }]); assert.equal('speaker' in solo.input[0].content[0].annotations[0], false);
});
test('WAV handling reads chunks rather than assuming a fixed header and rejects truncated/invalid formats', () => {
  const pcm = Buffer.alloc(48_000, 1); const wav = wavFromPcm(pcm); assert.deepEqual(pcmFromWav(wav), pcm);
  const junk = Buffer.from('JUNK\x04\x00\x00\x00abcd', 'binary'); const extra = Buffer.concat([wav.subarray(0, 36), junk, wav.subarray(36)]); extra.writeUInt32LE(extra.length - 8, 4); assert.deepEqual(pcmFromWav(extra), pcm);
  assert.throws(() => pcmFromWav(wav.subarray(0, wav.length - 1)), /incomplete/);
  const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22); assert.throws(() => pcmFromWav(stereo), /24 kHz mono/);
});
test('audio retry reuses completed sections; changing a voice invalidates the cache', async () => temporary(async directory => {
  const long: Script = { ...script, chapters: [{ title: 'One', turns: [script.chapters[0].turns[0]] }, { title: 'Two', turns: [script.chapters[0].turns[1]] }] };
  let calls = 0; let fail = true;
  const synthesize = async () => { calls++; if (fail && calls === 2) throw new Error('rate limit'); return wavFromPcm(Buffer.alloc(48_000)); };
  const options = { script: long, config, directory, key: 'test', onProgress: () => {}, synthesize };
  await assert.rejects(renderAudio(options), /rate limit/); fail = false;
  const result = await renderAudio(options); assert.equal(calls, 3); assert.equal(result.durationSeconds, 2); assert.equal(pcmFromWav(await readFile(path.join(directory, result.audioFile))).length, 96_000);
  await renderAudio({ ...options, config: { ...config, hostIds: ['maya', 'atlas'] } }); assert.equal(calls, 5);
}));
test('transcript edits preserve chapters, references and speaker labels; reject unknown speakers', () => {
  assert.deepEqual(parseTranscript(scriptToText(script), script, ['Maya', 'Leo']), script);
  assert.throws(() => parseTranscript('Stranger: Surprise!', script, ['Maya', 'Leo']), /Unknown speaker/);
  assert.equal(countWords({ ...script, chapters: [{ title: 'One', turns: [{ speaker: 'Maya', text: 'Hello <short pause> there.' }] }] }), 2);
});
test('database restart retains episodes and marks unfinished jobs for explicit retry', async () => temporary(async dir => {
  const filename = path.join(dir, 'test.sqlite'); let store = new Store(filename);
  const p: Podcast = { id: randomUUID(), title: 'Test', config, createdAt: new Date().toISOString() };
  const e: Episode = { id: randomUUID(), podcastId: p.id, number: 1, title: 'Test', focus: '', status: 'rendering', script, createdAt: p.createdAt };
  const job: Job = { id: randomUUID(), podcastId: p.id, episodeId: e.id, kind: 'audio', state: 'running', progress: 50, message: 'Halfway', createdAt: p.createdAt };
  store.put('podcast', p); store.put('episode', e); store.put('job', job); store.close();
  store = new Store(filename); new JobQueue(store, () => '', () => false);
  assert.equal(store.episode(e.id)?.status, 'failed'); assert.equal(store.job(job.id)?.state, 'failed'); assert.deepEqual(store.episode(e.id)?.script, script); store.close();
}));
test('series writing produces distinct episodes and resumes after a chapter failure', async () => temporary(async dir => {
  const store = new Store(path.join(dir, 'test.sqlite')); const p: Podcast = { id: randomUUID(), title: 'Science', config: { ...config, minutes: 10, episodeCount: 2 }, createdAt: new Date().toISOString() };
  store.put('podcast', p); const ids = [randomUUID(), randomUUID()]; ids.forEach((id, i) => store.put<Episode>('episode', { id, podcastId: p.id, number: i + 1, title: `Episode ${i + 1}`, focus: '', status: 'planned', createdAt: p.createdAt }));
  const job: Job = { id: randomUUID(), podcastId: p.id, kind: 'write', state: 'running', progress: 0, message: '', createdAt: p.createdAt };
  const chapter = { turns: [{ speaker: 'Maya', text: 'word '.repeat(700).trim() }], references: [] };
  let calls = 0; let fail = true;
  const generate = async () => { calls++; if (calls === 1) return { title: 'Science', summary: 'A series', episodes: [{ title: 'Foundations', focus: 'The basics', chapters: ['Opening', 'Closing'] }, { title: 'The next step', focus: 'Go deeper', chapters: ['Building', 'Future'] }] }; if (calls === 3 && fail) throw new Error('interrupted'); return chapter; };
  try {
    await assert.rejects(writePodcast(store, job, () => {}, new AbortController().signal, generate), /interrupted/);
    assert.equal(store.episode(ids[0])?.script?.chapters.length, 1); fail = false;
    await writePodcast(store, job, () => {}, new AbortController().signal, generate);
    assert.equal(calls, 6); assert.deepEqual(ids.map(id => store.episode(id)?.status), ['review', 'review']); assert.equal(store.episode(ids[1])?.title, 'The next step'); assert.equal(store.episode(ids[0])?.script?.chapters.length, 2);
  } finally { store.close(); }
}));
