import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { HOSTS, type PodcastConfig, type Script, type Turn } from '../shared/types.ts';
import { run } from './process.ts';
import { pcmFromWav, wavFromPcm, SAMPLE_RATE } from './wav.ts';
import { mixSoundtrack, type NarrationTiming } from './sound-mix.ts';
import { scriptHash, soundtrackHash } from './soundtrack.ts';
import { validateCues, type Soundtrack } from '../shared/soundtrack.ts';
export { pcmFromWav, wavFromPcm } from './wav.ts';
export const TTS_MODEL = 'gemini-3.8-flash-tts';

export function splitTurns(turns: Turn[], maxChars = 6500): Turn[][] {
  const chunks: Turn[][] = []; let current: Turn[] = []; let length = 0;
  for (const turn of turns) {
    // Script validation caps a turn at 5,000 characters; avoid breaking speech mid-sentence.
    if (current.length && length + turn.text.length > maxChars) { chunks.push(current); current = []; length = 0; }
    current.push(turn); length += turn.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
export function ttsPayload(turns: Turn[], config: PodcastConfig) {
  const hosts = config.hostIds.map(id => HOSTS.find(h => h.id === id)!);
  return {
    model: TTS_MODEL,
    input: [{ type: 'user_input', content: turns.map(t => ({ type: 'text', text: t.text, annotations: [{ type: 'speech_metadata', ...(hosts.length > 1 ? { speaker: t.speaker } : {}), style: hosts.find(h => h.name === t.speaker)?.style ?? '' }] })) }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: hosts.length === 1 ? [{ voice: hosts[0].voice }] : { speakers: hosts.map(h => ({ speaker: h.name, voice: h.voice })) } },
  };
}
export type Synthesize = (turns: Turn[], config: PodcastConfig, key: string, signal?: AbortSignal) => Promise<Buffer>;
export const synthesize: Synthesize = async (turns, config, key, signal) => {
  const combinedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10 * 60_000)]);
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', signal: combinedSignal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(ttsPayload(turns, config)) });
  if (!response.ok) {
    const status = response.status; await response.body?.cancel();
    throw new Error(status === 429 ? 'Gemini rate limit reached. Wait a little, then retry; completed audio sections are saved.' : status === 401 || status === 403 ? 'Gemini rejected the API key or model access. Check Settings and your Google AI Studio project.' : `Gemini returned HTTP ${status}. Retry to resume from the last completed section.`);
  }
  const body = await response.json() as any;
  const blocks = (body.steps ?? []).filter((s: any) => s.type === 'model_output').flatMap((s: any) => s.content ?? []).filter((b: any) => b.type === 'audio' && b.data);
  if (!blocks.length && body.output_audio?.data) blocks.push(body.output_audio);
  if (blocks.length !== 1) throw new Error('Gemini did not return one complete audio block. Please retry this section.');
  const audio = Buffer.from(blocks[0].data, 'base64'); pcmFromWav(audio); return audio;
};

interface NarrationManifest extends NarrationTiming { fingerprint: string; pcmHash: string }
const pcmHash = (pcm: Buffer) => createHash('sha256').update(pcm).digest('hex');
const speechFingerprint = (script: Script, config: PodcastConfig) => createHash('sha256').update(JSON.stringify(script.chapters.map(c => splitTurns(c.turns).map(turns => ttsPayload(turns, config))))).digest('hex');
async function saveNarration(directory: string, pcm: Buffer, manifest: NarrationManifest) {
  await writeFile(path.join(directory, 'narration.wav.tmp'), wavFromPcm(pcm));
  await rename(path.join(directory, 'narration.wav.tmp'), path.join(directory, 'narration.wav'));
  await writeFile(path.join(directory, 'narration.json.tmp'), JSON.stringify(manifest));
  await rename(path.join(directory, 'narration.json.tmp'), path.join(directory, 'narration.json'));
}

interface MixOptions { script: Script; config: PodcastConfig; directory: string; soundtrack?: Soundtrack; signal?: AbortSignal; mp3?: boolean }
async function finishAudio(pcm: Buffer, manifest: NarrationManifest, options: MixOptions) {
  if (options.soundtrack) {
    if (options.soundtrack.scriptHash !== scriptHash(options.script)) throw new Error('The script changed. Choose sounds again before mixing.');
    validateCues(options.soundtrack, options.script.chapters.length);
  }
  options.signal?.throwIfAborted();
  const mixedSoundtrackHash = soundtrackHash(options.soundtrack);
  const audioRevision = createHash('sha256').update(JSON.stringify({ pcmHash: manifest.pcmHash, mixedSoundtrackHash, chapterStarts: manifest.chapterStarts, timing: manifest.timing, version: 1 })).digest('hex').slice(0, 24);
  const { pcm: mixed, renderedCues, mixNote } = await mixSoundtrack(pcm, manifest, options.soundtrack, options.signal);
  const filename = `episode-${audioRevision}`;
  const wavPath = path.join(options.directory, filename + '.wav');
  await writeFile(wavPath + '.tmp', wavFromPcm(mixed));
  options.signal?.throwIfAborted();
  await rename(wavPath + '.tmp', wavPath);
  let audioFile = filename + '.wav';
  if (options.mp3) {
    const mp3Path = path.join(options.directory, filename + '.mp3');
    await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', mp3Path + '.tmp'], { timeout: 180_000, signal: options.signal });
    options.signal?.throwIfAborted();
    await rename(mp3Path + '.tmp', mp3Path); audioFile = filename + '.mp3';
    // The unprocessed narration is retained separately for future remixes.
    await rm(wavPath, { force: true });
  }
  return { audioFile, durationSeconds: mixed.length / (SAMPLE_RATE * 2), audioRevision, mixedSoundtrackHash, renderedCues, mixNote, narrationTiming: manifest.timing, soundtrackDirty: false };
}

export async function renderAudio(options: MixOptions & { key: string; onProgress: (done: number, total: number) => void; synthesize?: Synthesize }) {
  const { script, config, directory, key, signal, onProgress } = options;
  await mkdir(directory, { recursive: true });
  const chunks = script.chapters.flatMap((c, chapterIndex) => splitTurns(c.turns).map(turns => ({ turns, chapterIndex }))); const audio: Buffer[] = [];
  const chapterStarts: number[] = []; let seconds = 0;
  for (let i = 0; i < chunks.length; i++) {
    signal?.throwIfAborted();
    const { turns, chapterIndex } = chunks[i];
    if (chapterStarts[chapterIndex] === undefined) chapterStarts[chapterIndex] = seconds;
    const hash = createHash('sha256').update(JSON.stringify(ttsPayload(turns, config))).digest('hex').slice(0, 24);
    const filename = path.join(directory, `${hash}.wav`);
    const expected = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0) / 145 * 60;
    const validate = (wav: Buffer) => {
      const pcm = pcmFromWav(wav); const duration = pcm.length / (SAMPLE_RATE * 2);
      if (pcm.length < 24_000) throw new Error('Gemini returned audio that is too short. Please retry.');
      if (expected > 20 && (duration < expected * 0.45 || duration > expected * 2.5)) throw new Error('An audio section has an unexpected duration. Review the script before retrying.');
      return pcm;
    };
    let wav: Buffer;
    try { wav = await readFile(filename); validate(wav); }
    catch { wav = await (options.synthesize ?? synthesize)(turns, config, key, signal); validate(wav); await writeFile(filename + '.tmp', wav); await rename(filename + '.tmp', filename); }
    const pcm = validate(wav);
    audio.push(pcm); seconds += pcm.length / (SAMPLE_RATE * 2); onProgress(i + 1, chunks.length);
  }
  signal?.throwIfAborted();
  const pcm = Buffer.concat(audio);
  const manifest: NarrationManifest = { fingerprint: speechFingerprint(script, config), pcmHash: pcmHash(pcm), chapterStarts, durationSeconds: seconds, timing: 'chapters' };
  await saveNarration(directory, pcm, manifest);
  return finishAudio(pcm, manifest, options);
}

// A separate path with no synthesis function or API key: soundtrack edits cannot
// accidentally trigger a paid voice request, even when a cache file is missing.
export async function remixAudio(options: MixOptions & { existingAudioFile?: string; previouslyMixed?: boolean }) {
  const fingerprint = speechFingerprint(options.script, options.config);
  let pcm: Buffer | undefined; let manifest: NarrationManifest | undefined;
  try {
    const candidate = JSON.parse(await readFile(path.join(options.directory, 'narration.json'), 'utf8')) as NarrationManifest;
    if (candidate.fingerprint !== fingerprint) throw new Error('Stale narration');
    const bytes = pcmFromWav(await readFile(path.join(options.directory, 'narration.wav')));
    if (!['chapters', 'episode'].includes(candidate.timing) || candidate.pcmHash !== pcmHash(bytes) || candidate.durationSeconds !== bytes.length / (SAMPLE_RATE * 2) || !Array.isArray(candidate.chapterStarts) || candidate.chapterStarts.length !== (candidate.timing === 'chapters' ? options.script.chapters.length : 1) || candidate.chapterStarts[0] !== 0 || candidate.chapterStarts.some((t, i, a) => !Number.isFinite(t) || t < 0 || t >= candidate.durationSeconds || (i > 0 && t <= a[i - 1]))) throw new Error('Invalid narration manifest');
    pcm = bytes; manifest = candidate;
  } catch { /* Try existing section caches from recordings made before this feature. */ }
  if (!pcm || !manifest) {
    try {
      const parts: Buffer[] = []; const chapterStarts: number[] = []; let seconds = 0;
      for (const chapter of options.script.chapters) {
        chapterStarts.push(seconds);
        for (const turns of splitTurns(chapter.turns)) {
          options.signal?.throwIfAborted();
          const hash = createHash('sha256').update(JSON.stringify(ttsPayload(turns, options.config))).digest('hex').slice(0, 24);
          const part = pcmFromWav(await readFile(path.join(options.directory, `${hash}.wav`)));
          parts.push(part); seconds += part.length / (SAMPLE_RATE * 2);
        }
      }
      pcm = Buffer.concat(parts); manifest = { fingerprint, pcmHash: pcmHash(pcm), chapterStarts, durationSeconds: seconds, timing: 'chapters' };
    } catch {
      options.signal?.throwIfAborted();
      if (!options.existingAudioFile || options.previouslyMixed) throw new Error('The original narration could not be found. Restore its audio files before remixing; no new speech was generated.');
      // Imported, speech-only recordings support bookends without inventing timings.
      const original = path.join(options.directory, path.basename(options.existingAudioFile));
      try { pcm = pcmFromWav(await readFile(original)); }
      catch {
        if (!options.mp3) throw new Error('FFmpeg is needed to add music to this imported recording.');
        const decoded = path.join(options.directory, 'imported-narration.wav.tmp');
        await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', original, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', decoded], { timeout: 180_000, signal: options.signal });
        pcm = pcmFromWav(await readFile(decoded));
      }
      manifest = { fingerprint, pcmHash: pcmHash(pcm), chapterStarts: [0], durationSeconds: pcm.length / (SAMPLE_RATE * 2), timing: 'episode' };
    }
    options.signal?.throwIfAborted(); await saveNarration(options.directory, pcm, manifest);
  }
  return finishAudio(pcm, manifest, options);
}
