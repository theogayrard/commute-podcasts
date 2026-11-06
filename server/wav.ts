export const SAMPLE_RATE = 24_000;
export function pcmFromWav(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a WAV audio file.');
  let formatOk = false; let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4); const size = wav.readUInt32LE(offset + 4); const start = offset + 8;
    if (start + size > wav.length) throw new Error('The WAV audio file is incomplete.');
    if (kind === 'fmt ' && size >= 16) formatOk = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === SAMPLE_RATE && wav.readUInt16LE(start + 14) === 16;
    if (kind === 'data') pcm = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!formatOk || !pcm?.length || pcm.length % 2) throw new Error('Expected nonempty 24 kHz mono, 16-bit PCM audio.');
  return pcm;
}
export function wavFromPcm(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}
