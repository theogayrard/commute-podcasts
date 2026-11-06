import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { activeJob, durationRange, type Episode, type Job } from '../shared/types.ts';
import { Store, dataDir } from './store.ts';
import { publicError } from './process.ts';
import { writePodcast } from './writer.ts';
import { renderAudio, remixAudio } from './audio.ts';
import { planSoundtrack, soundtrackHash } from './soundtrack.ts';

export class JobQueue {
  private running = false;
  private controller?: AbortController;
  private currentId?: string;
  isBusy(podcastId: string) {
    // A cancelled worker may still be finishing an awaited write before it exits.
    return this.store.job(this.currentId || '')?.podcastId === podcastId || this.store.all<Job>('job').some(j => activeJob(j) && j.podcastId === podcastId);
  }
  private validateTarget(podcastId: string, episodeId?: string) {
    if (!this.store.podcast(podcastId)) throw Object.assign(new Error('Podcast not found.'), { status: 404 });
    if (episodeId && this.store.episode(episodeId)?.podcastId !== podcastId) throw Object.assign(new Error('Episode not found.'), { status: 404 });
    if (this.isBusy(podcastId)) throw new Error('This podcast already has a generation in progress.');
  }
  constructor(private store: Store, private getKey: () => string, private hasFfmpeg: () => boolean) {
    // Never silently re-spend API quota after a restart.
    for (const job of store.all<Job>('job').filter(activeJob)) {
      store.put('job', { ...job, state: 'failed', error: 'The app stopped during generation. Retry to continue from saved work.', message: 'Interrupted' });
      this.markInterrupted(job, 'Generation was interrupted. Retry to continue.');
    }
  }
  add(kind: Job['kind'], podcastId: string, episodeId?: string) {
    this.validateTarget(podcastId, episodeId);
    const job: Job = { id: randomUUID(), kind, podcastId, episodeId, state: 'queued', progress: 0, message: 'In the queue', createdAt: new Date().toISOString() };
    this.store.put('job', job); void this.drain(); return job;
  }
  addSeriesAudio(podcastId: string, episodeIds: string[]) {
    this.validateTarget(podcastId);
    for (const episodeId of episodeIds) this.validateTarget(podcastId, episodeId);
    const jobs = episodeIds.map(episodeId => ({ id: randomUUID(), kind: 'audio', podcastId, episodeId, state: 'queued', progress: 0, message: 'In the queue', createdAt: new Date().toISOString() } satisfies Job));
    this.store.transaction(() => { for (const job of jobs) this.store.put('job', job); });
    void this.drain(); return jobs;
  }
  cancel(id: string) {
    const job = this.store.job(id); if (!job || !activeJob(job)) return;
    this.store.put('job', { ...job, state: 'cancelled', message: 'Stopped. Completed sections are saved.' });
    this.markInterrupted(job, 'Generation stopped. Retry to continue from saved sections.');
    if (this.currentId === id) this.controller?.abort();
  }
  cancelPodcast(podcastId: string) {
    for (const job of this.store.all<Job>('job').filter(j => j.podcastId === podcastId && activeJob(j))) this.cancel(job.id);
  }
  private markInterrupted(job: Job, message: string) {
    for (const episode of this.store.all<Episode>('episode').filter(e => e.podcastId === job.podcastId && ['writing', 'rendering'].includes(e.status))) this.store.put('episode', { ...episode, status: 'failed', error: message });
  }
  private async drain() {
    if (this.running) return; this.running = true;
    try {
      for (;;) {
        const job = this.store.all<Job>('job').reverse().find(j => j.state === 'queued'); if (!job) break;
        this.currentId = job.id; this.controller = new AbortController(); const signal = this.controller.signal;
        this.store.put('job', { ...job, state: 'running' });
        const update = (progress: number, message: string) => { const current = this.store.job(job.id)!; if (current.state === 'running') this.store.put('job', { ...current, progress, message }); };
        try {
          if (job.kind === 'write') await writePodcast(this.store, job, update, signal);
          else {
            const episode = this.store.episode(job.episodeId!)!; const podcast = this.store.podcast(job.podcastId)!;
            if (!episode.script) throw new Error('Generate or import a script first.');
            if (job.kind === 'soundtrack' || (job.kind === 'audio' && podcast.config.soundDesign === 'subtle' && !episode.soundtrack)) {
              update(3, 'Choosing music and ambience from your script…');
              episode.soundtrack = await planSoundtrack(episode.script, podcast.config.model, podcast.soundThemeId, signal, undefined, episode.narrationTiming === 'episode');
              signal.throwIfAborted();
              episode.soundtrackDirty = episode.mixedSoundtrackHash !== soundtrackHash(episode.soundtrack);
              podcast.soundThemeId = episode.soundtrack.themeId;
              this.store.put('podcast', podcast); this.store.put('episode', episode);
            }
            if (job.kind !== 'soundtrack') {
              const options = { script: episode.script, config: podcast.config, directory: path.join(dataDir, 'audio', episode.id), soundtrack: episode.soundtrack, signal, mp3: this.hasFfmpeg() };
              let result: Awaited<ReturnType<typeof renderAudio>>;
              if (job.kind === 'mix') {
                update(15, 'Mixing your soundtrack with the saved narration…');
                result = await remixAudio({ ...options, existingAudioFile: episode.audioFile, previouslyMixed: !!episode.audioRevision });
              } else {
                const key = this.getKey(); if (!key) throw new Error('Add your Gemini API key in Settings first.');
                this.store.put('episode', { ...episode, status: 'rendering', error: undefined });
                update(5, 'Preparing the recording…');
                result = await renderAudio({ ...options, key, onProgress: (done, total) => update(Math.round(5 + done / total * 89), done === total ? 'Mixing and finishing your episode…' : `Recording section ${done} of ${total}`) });
              }
              signal.throwIfAborted();
              const { min, max } = durationRange(podcast.config); const minutes = result.durationSeconds / 60;
              this.store.put('episode', { ...episode, ...result, status: 'ready', error: undefined, warning: minutes < min || minutes > max ? `Finished at ${Math.round(minutes * 10) / 10} minutes, outside the ${min}–${max} minute target. The conversation was kept at its natural pace.` : undefined });
            }
          }
          signal.throwIfAborted();
          this.store.put('job', { ...this.store.job(job.id)!, state: 'done', progress: 100, message: job.kind === 'write' ? 'Script ready' : job.kind === 'soundtrack' ? 'Soundtrack ready to review' : 'Ready for the road' });
        } catch (error) {
          if (!signal.aborted) {
            const message = publicError(error);
            this.store.put('job', { ...this.store.job(job.id)!, state: 'failed', error: message, message: 'Generation needs attention' });
            this.markInterrupted(job, message);
          }
        }
      }
    } finally { this.running = false; this.currentId = undefined; this.controller = undefined; }
  }
  stop() { if (this.currentId) this.cancel(this.currentId); }
}
