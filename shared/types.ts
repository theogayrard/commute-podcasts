import { z } from 'zod';
import type { RenderedCue, Soundtrack } from './soundtrack.ts';

export const HOSTS = [
  { id: 'maya', name: 'Maya', voice: 'Kore', role: 'The curious one', description: 'Warm questions, thoughtful reactions, a little wonder.', style: 'warm, curious, conversational', color: '#e6c49d' },
  { id: 'leo', name: 'Leo', voice: 'Puck', role: 'The explainer', description: 'Relaxed clarity. Makes the complicated feel familiar.', style: 'thoughtful, relaxed, conversational', color: '#b5c9ae' },
  { id: 'june', name: 'June', voice: 'Sulafat', role: 'The storyteller', description: 'An inviting voice with a knack for a good story.', style: 'warm, expressive, natural', color: '#c3bcda' },
  { id: 'atlas', name: 'Atlas', voice: 'Charon', role: 'The deep thinker', description: 'Measured, informative, and quietly engaging.', style: 'calm, thoughtful, conversational', color: '#b2c9d9' },
  { id: 'iris', name: 'Iris', voice: 'Aoede', role: 'The fresh perspective', description: 'Light, breezy delivery and a playful curiosity.', style: 'breezy, friendly, conversational', color: '#e2bcba' },
  { id: 'kai', name: 'Kai', voice: 'Fenrir', role: 'The enthusiast', description: 'Bright energy for ideas worth getting excited about.', style: 'engaged, friendly, conversational', color: '#d6d3a2' },
] as const;
export type Host = (typeof HOSTS)[number];

export const configSchema = z.object({
  topic: z.string().trim().min(5, 'Tell us a little more about your topic.').max(4000),
  minutes: z.number().int().min(5).max(60).default(30),
  tolerance: z.number().int().min(1).max(10).default(3),
  hostIds: z.array(z.enum(['maya', 'leo', 'june', 'atlas', 'iris', 'kai'])).min(1).max(2).refine(a => new Set(a).size === a.length, 'Choose different hosts.'),
  episodeCount: z.number().int().min(1).max(12).default(1),
  model: z.string().trim().min(1).max(100),
  language: z.enum(['English', 'French']).default('English'),
  sourceMode: z.enum(['supplement', 'provided']).default('supplement'),
  sourceIds: z.array(z.string().uuid()).max(12).default([]),
  soundDesign: z.enum(['off', 'subtle']).optional(),
}).refine(c => c.tolerance < c.minutes, 'Tolerance must be less than the episode length.')
  .refine(c => c.sourceMode !== 'provided' || c.sourceIds.length > 0, 'Add a source or allow research.');
export type PodcastConfig = z.infer<typeof configSchema>;

export const turnSchema = z.object({ speaker: z.string().min(1).max(40), text: z.string().min(1).max(5000) });
export const scriptSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(2000),
  chapters: z.array(z.object({ title: z.string().min(1).max(200), turns: z.array(turnSchema).min(1).max(150) })).min(1).max(30),
  references: z.array(z.object({ title: z.string().max(500), url: z.string().max(2000) })).max(60),
});
export type Script = z.infer<typeof scriptSchema>;
export type Turn = z.infer<typeof turnSchema>;
export interface Outline { title: string; summary: string; episodes: { title: string; focus: string; chapters: string[] }[] }
export interface Source { id: string; kind: 'file' | 'url' | 'youtube'; title: string; url?: string; text: string; characters: number; truncated: boolean; createdAt: string }
export type EpisodeStatus = 'planned' | 'writing' | 'review' | 'rendering' | 'ready' | 'failed';
export interface Episode {
  id: string; podcastId: string; number: number; title: string; focus: string; status: EpisodeStatus;
  script?: Script; audioFile?: string; durationSeconds?: number; error?: string;
  wordCount?: number; estimatedMinutes?: number; warning?: string; createdAt: string;
  soundtrack?: Soundtrack; audioRevision?: string; mixedSoundtrackHash?: string;
  renderedCues?: RenderedCue[]; mixNote?: string; narrationTiming?: 'chapters' | 'episode';
  soundtrackDirty?: boolean;
}
export interface FollowUpLink { episodeId: string; title: string }
export interface Podcast { id: string; title: string; config: PodcastConfig; createdAt: string; outline?: Outline; sample?: boolean; soundThemeId?: string; followUp?: FollowUpLink }
export interface Job { id: string; podcastId: string; episodeId?: string; kind: 'write' | 'audio' | 'soundtrack' | 'mix'; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; message: string; error?: string; createdAt: string }
export interface Model { id: string; name: string; description?: string; isDefault?: boolean }
export interface AppStatus { codex: { connected: boolean; authType?: string; error?: string; models: Model[] }; gemini: { configured: boolean; model: string }; ffmpeg: boolean; youtube: boolean }
export interface Library { podcasts: Podcast[]; episodes: Episode[]; jobs: Job[] }
export const activeJob = (j: Job) => j.state === 'queued' || j.state === 'running';
export function hasCompleteScript(episode: Episode, podcast: Podcast): boolean {
  const script = episode.script;
  return !!script?.chapters.length && !['planned', 'writing'].includes(episode.status)
    && script.chapters.every(c => c.turns.length > 0)
    && (!podcast.outline || script.chapters.length === podcast.outline.episodes[episode.number - 1]?.chapters.length);
}
export function countWords(script: Script): number { return script.chapters.flatMap(c => c.turns).reduce((n, t) => n + t.text.replace(/<[^>]+>/g, '').trim().split(/\s+/u).filter(Boolean).length, 0); }
export function durationRange(config: Pick<PodcastConfig, 'minutes' | 'tolerance'>) { return { min: config.minutes - config.tolerance, max: config.minutes + config.tolerance }; }
