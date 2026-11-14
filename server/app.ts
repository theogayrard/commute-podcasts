import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { HOSTS, configSchema, scriptSchema, type Podcast, type Episode, type AppStatus } from '../shared/types.ts';
import { Store, dataDir } from './store.ts';
import { inspectCodex } from './codex.ts';
import { TTS_MODEL, synthesize } from './audio.ts';
import { available, publicError } from './process.ts';
import { fileSource, urlSource } from './sources.ts';
import { JobQueue } from './queue.ts';
import { parseTranscript, scriptMetrics, scriptToText } from './writer.ts';
import { accessControl, type RemoteAccess } from './remote-access.ts';
import { SOUND_LIBRARY, soundClip } from '../shared/sound-library.ts';
import { soundPath } from './sound-mix.ts';
import { editSoundtrack, soundtrackHash } from './soundtrack.ts';
import { prepareMp3Download } from './mp3.ts';
import { snapshotContinuity } from './follow-up.ts';

export async function createApp(store = new Store(), remoteAccess?: RemoteAccess) {
  const app = express(); const port = Number(process.env.PORT || 4310);
  let key = process.env.GEMINI_API_KEY || '';
  const keyPath = path.join(dataDir, 'settings.json');
  try { const settings = JSON.parse(await readFile(keyPath, 'utf8')); key = settings.geminiApiKey || key; } catch { /* New installation. */ }
  let statusCache: AppStatus | undefined; let statusAt = 0; let statusPending: Promise<AppStatus> | undefined;
  async function status(force = false): Promise<AppStatus> {
    if (!force && statusCache && Date.now() - statusAt < 60_000) return { ...statusCache, gemini: { configured: !!key, model: TTS_MODEL } };
    if (statusPending) return statusPending;
    statusPending = (async () => {
      const [codex, ffmpeg, youtube] = await Promise.all([inspectCodex(), available(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']), available(process.env.YTDLP_BIN || 'yt-dlp')]);
      statusCache = { codex, ffmpeg, youtube, gemini: { configured: !!key, model: TTS_MODEL } }; statusAt = Date.now(); return statusCache;
    })();
    try { return await statusPending; } finally { statusPending = undefined; }
  }
  const queue = new JobQueue(store, () => key, () => statusCache?.ffmpeg ?? false);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  app.disable('x-powered-by');
  app.use(accessControl(port, remoteAccess));
  app.use(express.json({ limit: '2mb' }));
  const id = (input: string | string[]) => z.string().uuid().parse(input);
  const podcast = (input: string | string[]) => { const result = store.podcast(id(input)); if (!result) throw Object.assign(new Error('Podcast not found.'), { status: 404 }); return result; };
  const episode = (input: string | string[]) => { const result = store.episode(id(input)); if (!result) throw Object.assign(new Error('Episode not found.'), { status: 404 }); return result; };
  const idle = (podcastId: string) => { if (queue.isBusy(podcastId)) throw Object.assign(new Error('Wait for this podcast’s generation to finish, or stop it first. If you just stopped it, try again in a moment.'), { status: 409 }); };
  async function writerReady(model: string) { const s = await status(); if (!s.codex.connected) throw new Error(s.codex.error || 'Connect your ChatGPT account first.'); if (!s.codex.models.some(m => m.id === model)) throw new Error('This model is no longer available. Create a new podcast with an available model.'); }

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/status', async (req, res) => res.json(await status(req.query.refresh === '1')));
  app.get('/api/library', (_req, res) => res.json(store.library()));
  app.get('/api/hosts', (_req, res) => res.json(HOSTS));
  app.get('/api/sounds', (_req, res) => res.json(SOUND_LIBRARY));
  app.get('/api/sounds/:id/audio', (req, res) => {
    const clip = soundClip(String(req.params.id));
    if (!clip) return res.status(404).json({ error: 'Sound not found.' });
    res.sendFile(soundPath(clip.id));
  });
  app.post('/api/settings', async (req, res) => {
    const { geminiApiKey } = z.object({ geminiApiKey: z.string().trim().min(10).max(500) }).parse(req.body);
    await writeFile(keyPath + '.tmp', JSON.stringify({ geminiApiKey }), { mode: 0o600 }); await rename(keyPath + '.tmp', keyPath); key = geminiApiKey;
    res.json({ configured: true });
  });
  app.post('/api/sources/file', upload.single('file'), async (req, res) => {
    if (!req.file) throw new Error('Choose a file to upload.');
    const source = await fileSource(req.file.buffer, req.file.originalname); store.put('source', source); const { text, ...info } = source; res.status(201).json(info);
  });
  app.post('/api/sources/url', async (req, res) => {
    const { url } = z.object({ url: z.string().url().max(2000) }).parse(req.body);
    const source = await urlSource(url); store.put('source', source); const { text, ...info } = source; res.status(201).json(info);
  });
  function createPodcast(input: unknown, followUpToEpisodeId?: string): Podcast {
    const config = configSchema.parse(input);
    if (config.sourceIds.some(id => !store.source(id))) throw new Error('One of your sources could not be found. Please add it again.');
    const item: Podcast = { id: randomUUID(), title: config.topic.slice(0, 100), config, createdAt: new Date().toISOString() };
    const parent = followUpToEpisodeId ? episode(followUpToEpisodeId) : undefined;
    if (parent && config.episodeCount !== 1) throw new Error('Create one follow-up episode at a time. You can continue it with another follow-up.');
    const continuity = parent ? snapshotContinuity(store, item.id, parent) : undefined;
    if (parent) {
      item.followUp = { episodeId: parent.id, title: parent.title };
      item.soundThemeId = store.podcast(parent.podcastId)?.soundThemeId;
    }
    store.transaction(() => {
      store.put('podcast', item);
      if (continuity) store.put('continuity', continuity);
      for (let n = 1; n <= config.episodeCount; n++) store.put<Episode>('episode', { id: randomUUID(), podcastId: item.id, number: n, title: config.episodeCount === 1 ? item.title : `Episode ${n}`, focus: '', status: 'planned', createdAt: item.createdAt });
    });
    return item;
  }
  app.post('/api/podcasts', (req, res) => res.status(201).json(createPodcast(req.body)));
  app.post('/api/episodes/:id/follow-up', (req, res) => res.status(201).json(createPodcast(req.body, id(req.params.id))));
  app.post('/api/podcasts/:id/write', async (req, res) => { const p = podcast(req.params.id); await writerReady(p.config.model); res.status(202).json(queue.add('write', p.id)); });
  app.post('/api/podcasts/:id/audio', async (req, res) => {
    const p = podcast(req.params.id); idle(p.id);
    const episodes = store.all<Episode>('episode').filter(e => e.podcastId === p.id && e.status !== 'ready').sort((a, b) => a.number - b.number);
    if (!episodes.length) throw new Error('Every episode is already recorded.');
    if (episodes.some(e => !e.script || !['review', 'failed'].includes(e.status) || (p.outline && e.script.chapters.length !== p.outline.episodes[e.number - 1].chapters.length))) throw new Error('Finish writing every episode before recording the series.');
    if (!key) throw new Error('Add your Gemini API key in Settings first.'); await status();
    res.status(202).json(queue.addSeriesAudio(p.id, episodes.map(e => e.id)));
  });
  app.post('/api/episodes/:id/write', async (req, res) => { const e = episode(req.params.id); const p = podcast(e.podcastId); await writerReady(p.config.model); res.status(202).json(queue.add('write', p.id, e.id)); });
  app.post('/api/episodes/:id/audio', async (req, res) => {
    const e = episode(req.params.id); if (!e.script || !['review', 'failed'].includes(e.status)) throw new Error('Finish and review the script first.');
    const p = podcast(e.podcastId);
    if (p.outline && e.script.chapters.length !== p.outline.episodes[e.number - 1].chapters.length) throw new Error('The script is incomplete. Resume writing before recording.');
    if (!key) throw new Error('Add your Gemini API key in Settings first.'); await status();
    res.status(202).json(queue.add('audio', e.podcastId, e.id));
  });
  app.post('/api/jobs/:id/cancel', (req, res) => { queue.cancel(id(req.params.id)); res.json({ ok: true }); });
  app.post('/api/episodes/:id/soundtrack/plan', async (req, res) => {
    const e = episode(req.params.id); const p = podcast(e.podcastId); idle(p.id);
    if (!e.script || !['review', 'ready', 'failed'].includes(e.status)) throw new Error('Finish the script before choosing sounds.');
    if (p.outline && e.script.chapters.length !== p.outline.episodes[e.number - 1].chapters.length) throw new Error('Finish the script before choosing sounds.');
    await writerReady(p.config.model);
    res.status(202).json(queue.add('soundtrack', p.id, e.id));
  });
  app.put('/api/episodes/:id/soundtrack', (req, res) => {
    const e = episode(req.params.id); idle(e.podcastId);
    if (!e.script) throw new Error('Add a script before choosing sounds.');
    const soundtrack = editSoundtrack(req.body, e.script);
    const p = podcast(e.podcastId);
    store.put('podcast', { ...p, soundThemeId: soundtrack.themeId });
    res.json(store.put('episode', { ...e, soundtrack, soundtrackDirty: e.mixedSoundtrackHash !== soundtrackHash(soundtrack) }));
  });
  app.post('/api/episodes/:id/soundtrack/mix', async (req, res) => {
    const e = episode(req.params.id); idle(e.podcastId);
    if (!e.script || !e.audioFile || e.status !== 'ready') throw new Error('Record the narration before applying a soundtrack.');
    if (!e.soundtrack) throw new Error('Choose a soundtrack first.');
    await status();
    res.status(202).json(queue.add('mix', e.podcastId, e.id));
  });
  app.post('/api/podcasts/:id/cancel', (req, res) => { const p = podcast(req.params.id); queue.cancelPodcast(p.id); res.json({ ok: true }); });
  app.delete('/api/episodes/:id', (req, res) => {
    const episodeId = id(req.params.id); const e = episode(episodeId); idle(e.podcastId);
    const audioRoot = path.resolve(dataDir, 'audio'); const directory = path.resolve(audioRoot, episodeId);
    if (path.dirname(directory) !== audioRoot) throw new Error('Invalid episode audio directory.');
    // Keep cleanup and record deletion in one synchronous turn so generation cannot start between them.
    rmSync(directory, { recursive: true, force: true });
    store.deleteEpisode(episodeId);
    res.json(store.library());
  });
  app.put('/api/episodes/:id/script', (req, res) => {
    const e = episode(req.params.id); idle(e.podcastId); const p = podcast(e.podcastId);
    const body = z.object({ text: z.string().min(20).max(300_000) }).parse(req.body);
    const script = scriptSchema.parse(parseTranscript(body.text, e.script ?? { title: e.title, summary: e.focus, chapters: [], references: [] }, p.config.hostIds.map(id => HOSTS.find(h => h.id === id)!.name)));
    if (p.outline && script.chapters.length !== p.outline.episodes[e.number - 1].chapters.length) throw new Error('Keep the planned chapter headings when editing this script.');
    // Existing recordings remain on disk; the edited episode needs a new recording.
    const result = store.put('episode', { ...e, script, status: 'review', audioFile: undefined, durationSeconds: undefined, error: undefined, soundtrack: undefined, soundtrackDirty: undefined, audioRevision: undefined, mixedSoundtrackHash: undefined, renderedCues: undefined, mixNote: undefined, narrationTiming: undefined, ...scriptMetrics(script, p) }); res.json(result);
  });
  app.get('/api/episodes/:id/script.txt', (req, res) => { const e = episode(req.params.id); if (!e.script) return res.status(404).end(); res.type('text/plain').attachment(`commute-episode-${e.number}.txt`).send(`${e.title}\n\n${scriptToText(e.script)}\n\nSources\n${e.script.references.map(r => `${r.title}${r.url ? ': ' + r.url : ''}`).join('\n')}`); });
  app.get('/api/episodes/:id/audio', async (req, res) => {
    const e = episode(req.params.id); if (!e.audioFile || e.status !== 'ready') return res.status(404).json({ error: 'Audio is not ready.' });
    const directory = path.join(dataDir, 'audio', e.id);
    let file = path.join(directory, path.basename(e.audioFile));
    // A player already reading an older mix must finish reading that same file.
    if (req.query.v && req.query.v !== (e.audioRevision || 'original')) {
      const revision = z.union([z.literal('original'), z.string().regex(/^[a-f0-9]{24}$/)]).parse(req.query.v);
      const basename = revision === 'original' ? 'episode' : `episode-${revision}`;
      const previous = ['.mp3', '.wav'].map(ext => path.join(directory, basename + ext)).find(candidate => existsSync(candidate));
      if (!previous) return res.status(404).json({ error: 'This audio version is no longer available.' });
      file = previous;
    }
    if (req.query.download === '1') {
      if (path.extname(file).toLowerCase() === '.mp3') file = await prepareMp3Download(file, e.title);
      res.attachment(`commute-episode-${e.number}${path.extname(file)}`);
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file, { dotfiles: 'allow' });
  });
  app.post('/api/hosts/:hostId/preview', async (req, res) => {
    const host = HOSTS.find(h => h.id === req.params.hostId); if (!host) return res.status(404).end();
    const directory = path.join(dataDir, 'voices'); await mkdir(directory, { recursive: true }); const file = path.join(directory, `${host.id}.wav`);
    try { await access(file); } catch {
      if (!key) throw new Error('Add your Gemini key in Settings to hear a voice sample.');
      const config = configSchema.parse({ topic: 'Host preview', hostIds: [host.id], model: 'preview' });
      const audio = await synthesize([{ speaker: host.name, text: `Hi, I'm ${host.name}. Every good journey starts with a little curiosity. Let's take an idea, look a little closer, and see where it takes us.` }], config, key);
      await writeFile(file, audio);
    }
    res.json({ url: `/api/hosts/${host.id}/preview.wav` });
  });
  app.get('/api/hosts/:hostId/preview.wav', (req, res) => { const host = HOSTS.find(h => h.id === req.params.hostId); if (!host) return res.status(404).end(); res.sendFile(path.join(dataDir, 'voices', `${host.id}.wav`), { dotfiles: 'allow' }); });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const error = err instanceof z.ZodError ? err.issues.map(i => i.message).join(' ') : err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 15 MB or smaller.' : publicError(err);
    res.status(err.status && Number.isInteger(err.status) ? err.status : 400).json({ error });
  });
  return { app, store, queue };
}
