import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Episode, Job, Podcast, Source } from '../shared/types.ts';

export const dataDir = path.resolve(process.env.DATA_DIR || '.data');
mkdirSync(dataDir, { recursive: true });
export class Store {
  private db: DatabaseSync;
  constructor(filename = path.join(dataDir, 'commute.sqlite')) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id))');
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  all<T>(kind: string): T[] { return (this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY rowid DESC').all(kind) as { payload: string }[]).map(r => JSON.parse(r.payload)); }
  put<T extends { id: string }>(kind: string, item: T): T { this.db.prepare('INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, item.id, JSON.stringify(item)); return item; }
  remove(kind: string, id: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  deleteEpisode(id: string) {
    const episode = this.episode(id); if (!episode) return;
    this.transaction(() => {
      this.remove('episode', id);
      const lastEpisode = !this.all<Episode>('episode').some(e => e.podcastId === episode.podcastId);
      for (const job of this.all<Job>('job').filter(j => j.episodeId === id || (lastEpisode && j.podcastId === episode.podcastId))) this.remove('job', job.id);
      if (lastEpisode) { this.remove('podcast', episode.podcastId); this.remove('continuity', episode.podcastId); }
      // Keep the original numbering and outline so remaining scripts still match their plans.
      // Sources can be shared by other podcasts or the current creation form.
    });
  }
  transaction(fn: () => void) { this.db.exec('BEGIN IMMEDIATE'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  podcast(id: string) { return this.get<Podcast>('podcast', id); }
  episode(id: string) { return this.get<Episode>('episode', id); }
  source(id: string) { return this.get<Source>('source', id); }
  job(id: string) { return this.get<Job>('job', id); }
  library() { return { podcasts: this.all<Podcast>('podcast'), episodes: this.all<Episode>('episode').sort((a, b) => a.number - b.number), jobs: this.all<Job>('job') }; }
  close() { this.db.close(); }
}
