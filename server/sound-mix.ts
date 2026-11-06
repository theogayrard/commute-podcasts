import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { soundClip } from '../shared/sound-library.ts';
import type { RenderedCue, Soundtrack } from '../shared/soundtrack.ts';
import { pcmFromWav, SAMPLE_RATE } from './wav.ts';

export function soundPath(id: string) {
  if (!soundClip(id)) throw new Error('Sound not found.');
  return fileURLToPath(new URL(`../assets/sounds/${id}.wav`, import.meta.url));
}
export interface NarrationTiming { chapterStarts: number[]; durationSeconds: number; timing: 'chapters' | 'episode' }

// Work in PCM so music also works without FFmpeg. The optional MP3 step normalizes
// the completed mix. Every voice sample is copied intact, with no time stretching.
export async function mixSoundtrack(narration: Buffer, timing: NarrationTiming, plan?: Soundtrack, signal?: AbortSignal) {
  const enabled = plan?.enabled ? plan.cues : [];
  const skipped = timing.timing === 'episode' && enabled.some(c => c.kind === 'transition' || c.kind === 'ambience');
  const candidates = enabled.filter(c => timing.timing === 'chapters' || c.kind === 'intro' || c.kind === 'outro');
  const lead = candidates.some(c => c.kind === 'intro') ? 1.2 : 0;
  const tail = candidates.some(c => c.kind === 'outro') ? 2 : 0;
  const gaps = new Map<number, number>();
  for (const cue of candidates) if (cue.kind === 'transition' && timing.chapterStarts[cue.chapterIndex] !== undefined) gaps.set(cue.chapterIndex, .65);
  const chapterStarts: number[] = []; let extra = lead;
  timing.chapterStarts.forEach((start, i) => { extra += gaps.get(i) || 0; chapterStarts[i] = start + extra; });
  const samples = Math.round((timing.durationSeconds + extra + tail) * SAMPLE_RATE);
  if (!enabled.length) return { pcm: narration, renderedCues: [] as RenderedCue[], mixNote: undefined };
  if (samples > SAMPLE_RATE * 3 * 60 * 60) throw new Error('This recording is too long to mix.');
  const voice = new Float32Array(samples);
  for (let chapter = 0; chapter < timing.chapterStarts.length; chapter++) {
    const from = Math.round(timing.chapterStarts[chapter] * SAMPLE_RATE);
    const to = Math.min(narration.length / 2, Math.round((timing.chapterStarts[chapter + 1] ?? timing.durationSeconds) * SAMPLE_RATE));
    const destination = Math.round(chapterStarts[chapter] * SAMPLE_RATE);
    for (let i = from; i < to; i++) voice[destination + i - from] = narration.readInt16LE(i * 2) / 32768;
  }
  const duration = samples / SAMPLE_RATE;
  const renderedCues: RenderedCue[] = [];
  const selected = candidates.map(cue => {
    const chapterStart = chapterStarts[cue.chapterIndex];
    let start = cue.kind === 'intro' ? 0 : cue.kind === 'outro' ? Math.max(lead, duration - cue.durationSeconds) : chapterStart - (cue.kind === 'transition' ? .65 : 0);
    if (!Number.isFinite(start)) return undefined;
    const chapterEnd = chapterStarts[cue.chapterIndex + 1] ?? duration - tail;
    const end = cue.kind === 'intro' ? Math.min(duration - tail, cue.durationSeconds) : cue.kind === 'outro' ? duration : Math.min(chapterEnd, start + cue.durationSeconds);
    return { ...cue, start, end };
  }).filter((cue): cue is NonNullable<typeof cue> => !!cue).sort((a, b) => a.start - b.start);
  const mixed = new Float32Array(voice);
  let previousEnd = -1;
  for (const cue of selected) {
    signal?.throwIfAborted();
    // Trim an earlier cue at the next cue; very short passages never stack music.
    const next = selected.find(c => c.start > cue.start && c.start < cue.end);
    const end = Math.min(cue.end, next?.start ?? cue.end);
    const offset = Math.round(cue.start * SAMPLE_RATE);
    const endSample = Math.round(end * SAMPLE_RATE);
    if (offset < previousEnd || endSample - offset < SAMPLE_RATE / 2) continue;
    const asset = pcmFromWav(await readFile(soundPath(cue.clipId)));
    const length = Math.min(endSample - offset, asset.length / 2);
    const baseGain = 10 ** (cue.volumeDb / 20);
    const fadeIn = Math.min(length / 3, SAMPLE_RATE * (cue.kind === 'transition' ? .25 : 1));
    const fadeOut = Math.min(length / 2, SAMPLE_RATE * (cue.kind === 'transition' ? .8 : 2.5));
    let envelope = 0;
    for (let i = 0; i < length && offset + i < mixed.length; i++) {
      const level = Math.abs(voice[offset + i]);
      // Fast attack, gentle release: reduce the bed a further 6 dB under speech.
      envelope += (level - envelope) * (level > envelope ? .004 : .0001);
      const duck = 1 - .5 * Math.min(1, envelope / .025);
      const fade = Math.min(1, i / fadeIn) * Math.min(1, (length - 1 - i) / fadeOut);
      mixed[offset + i] += asset.readInt16LE(i * 2) / 32768 * baseGain * duck * Math.max(0, fade);
    }
    renderedCues.push({ id: cue.id, clipId: cue.clipId, startSeconds: offset / SAMPLE_RATE, durationSeconds: length / SAMPLE_RATE });
    previousEnd = offset + length;
  }
  signal?.throwIfAborted();
  let peak = 0; for (const value of mixed) peak = Math.max(peak, Math.abs(value));
  const gain = peak > .97 ? .97 / peak : 1;
  const pcm = Buffer.alloc(mixed.length * 2);
  for (let i = 0; i < mixed.length; i++) pcm.writeInt16LE(Math.round(mixed[i] * gain * 32767), i * 2);
  return { pcm, renderedCues, mixNote: skipped ? 'This imported recording has no chapter timings. Only opening and closing cues were applied.' : undefined };
}
