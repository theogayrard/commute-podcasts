import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.ts';

const coverPath = fileURLToPath(new URL('../assets/commute-cover.png', import.meta.url));
const pending = new Map<string, Promise<string>>();

// Prepare a separate download so adding tags never changes a file being streamed.
// This also covers recordings made before metadata was supported.
export async function prepareMp3Download(sourceFile: string, title: string): Promise<string> {
  const [source, cover] = await Promise.all([stat(sourceFile), readFile(coverPath)]);
  const revision = createHash('sha256').update(JSON.stringify({
    version: 1, file: path.basename(sourceFile), size: source.size, modified: source.mtimeMs, title,
  })).update(cover).digest('hex').slice(0, 24);
  const output = path.join(path.dirname(sourceFile), `download-${revision}.mp3`);
  const current = pending.get(output);
  if (current) return current;

  const task = writeDownload(sourceFile, output, title);
  pending.set(output, task);
  try { return await task; }
  finally { pending.delete(output); }
}

async function writeDownload(sourceFile: string, output: string, title: string): Promise<string> {
  try { await access(output); return output; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await run(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourceFile, '-i', coverPath,
      '-map', '0:a:0', '-map', '1:v:0', '-c', 'copy', '-map_metadata', '0',
      // ID3v2.3 works with common desktop and mobile music players, including Unicode titles.
      '-id3v2_version', '3',
      '-metadata', `title=${title}`,
      '-metadata', 'artist=Commute', '-metadata', 'album_artist=Commute', '-metadata', 'author=Commute',
      '-metadata', 'genre=Podcast',
      '-metadata:s:v:0', 'title=Commute cover', '-metadata:s:v:0', 'comment=Cover (front)',
      '-disposition:v:0', 'attached_pic', '-f', 'mp3', temporary,
    ], { timeout: 180_000 });
    await rename(temporary, output);
    return output;
  } finally { await rm(temporary, { force: true }); }
}
