import { z } from 'zod';
import { soundClip } from './sound-library.ts';

export const cueSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  kind: z.enum(['intro', 'outro', 'transition', 'ambience']),
  clipId: z.string().max(60),
  chapterIndex: z.number().int().min(0).max(29),
  durationSeconds: z.number().min(1).max(24),
  volumeDb: z.number().min(-30).max(-8),
  reason: z.string().trim().max(300),
});
export type SoundCue = z.infer<typeof cueSchema>;
export const soundtrackEditSchema = z.object({
  enabled: z.boolean(),
  themeId: z.string().max(60).refine(id => soundClip(id)?.kind === 'music', 'Choose a theme from the sound library.'),
  cues: z.array(cueSchema).max(6),
});
export type SoundtrackEdit = z.infer<typeof soundtrackEditSchema>;
export interface Soundtrack extends SoundtrackEdit {
  scriptHash: string;
  source: 'automatic' | 'basic' | 'manual';
  note?: string;
}
export interface RenderedCue { id: string; clipId: string; startSeconds: number; durationSeconds: number }

export function bookendCues(chapterCount: number, themeId: string): SoundCue[] {
  return [
    { id: 'opening', kind: 'intro', clipId: themeId, chapterIndex: 0, durationSeconds: 8, volumeDb: -10, reason: 'A brief opening theme that fades beneath the hosts.' },
    { id: 'closing', kind: 'outro', clipId: themeId, chapterIndex: chapterCount - 1, durationSeconds: 10, volumeDb: -10, reason: 'The opening theme returns for the goodbye.' },
  ];
}

export function validateCues(plan: SoundtrackEdit, chapterCount: number) {
  const ids = new Set<string>(); const anchors = new Set<string>();
  for (const cue of plan.cues) {
    const clip = soundClip(cue.clipId);
    const kind = cue.kind === 'intro' || cue.kind === 'outro' ? 'music' : cue.kind;
    if (!clip || clip.kind !== kind) throw new Error('Choose a compatible clip from the sound library.');
    if (cue.durationSeconds > clip.seconds || (cue.kind === 'transition' && cue.durationSeconds > 4)) throw new Error('This cue is longer than its clip.');
    if (cue.chapterIndex >= chapterCount) throw new Error('This sound refers to a chapter that no longer exists.');
    if (cue.kind === 'intro' && cue.chapterIndex !== 0) throw new Error('Opening music belongs at the start.');
    if (cue.kind === 'outro' && cue.chapterIndex !== chapterCount - 1) throw new Error('Closing music belongs at the end.');
    if (cue.kind === 'transition' && cue.chapterIndex === 0) throw new Error('Transitions belong between chapters.');
    const anchor = cue.kind === 'intro' || cue.kind === 'outro' ? cue.kind : `chapter-${cue.chapterIndex}`;
    if (ids.has(cue.id) || anchors.has(anchor)) throw new Error('Use one cue at each location.');
    ids.add(cue.id); anchors.add(anchor);
  }
}
