import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import mammoth from 'mammoth';
import { run } from './process.ts';
import type { Source } from '../shared/types.ts';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 60_000;
export function isPublicAddress(address: string) { try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; } }
export function validateSourceUrl(input: string) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public http or https link without a password or custom port.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.local') || (ipaddr.isValid(hostname) && !isPublicAddress(hostname))) throw new Error('Sources must be on the public internet. Local network addresses are not allowed.');
  return url;
}
// Validate at connection time too, so DNS changes and redirects cannot reach local services.
const dispatcher = new Agent({ connect: { lookup: ((hostname: string, options: any, callback: any) => {
  lookup(hostname, { all: true }).then(addresses => {
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return callback(new Error('This source resolves to a private or reserved address.'));
    if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
  }, error => callback(error));
}) as any } });

export async function fetchPublic(input: string): Promise<{ buffer: Buffer; contentType: string; url: string }> {
  let url = validateSourceUrl(input);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const res = await request(url, { dispatcher, signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'CommutePodcasts/0.1 (personal source reader)', accept: 'text/html,text/plain,application/pdf' } });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.body.destroy(); url = validateSourceUrl(new URL(String(res.headers.location), url).href); continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) { res.body.destroy(); throw new Error(`The source returned HTTP ${res.statusCode}. Try uploading its text instead.`); }
    if (Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.body.destroy(); throw new Error('This source exceeds the 15 MB limit.'); }
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of res.body) { const b = Buffer.from(chunk); total += b.length; if (total > MAX_BYTES) { res.body.destroy(); throw new Error('This source exceeds the 15 MB limit.'); } chunks.push(b); }
    return { buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || ''), url: url.href };
  }
  throw new Error('Too many redirects in this source.');
}

export async function extractFile(buffer: Buffer, filename: string) {
  if (buffer.length > MAX_BYTES) throw new Error('Files must be 15 MB or smaller.');
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
    const doc = await task.promise;
    try {
      let text = '';
      for (let i = 1; i <= Math.min(doc.numPages, 300) && text.length <= MAX_TEXT; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        text += content.items.map(item => 'str' in item ? item.str : '').join(' ') + '\n';
      }
      if (!text.trim()) throw new Error('This PDF has no selectable text. Upload an OCR version or a transcript.');
      return text;
    } finally { await task.destroy(); }
  }
  if (extension === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (['.txt', '.md', '.csv', '.srt', '.vtt'].includes(extension)) return buffer.toString('utf8');
  throw new Error('Supported files: PDF, DOCX, TXT, Markdown, CSV, SRT and VTT.');
}
function source(kind: Source['kind'], title: string, text: string, url?: string): Source {
  text = text.replace(/\u0000/g, '').trim();
  if (text.length < 80) throw new Error('There is too little readable text in this source. Upload a transcript or a text version.');
  return { id: randomUUID(), kind, title: title.slice(0, 300), url, text: text.slice(0, MAX_TEXT), characters: Math.min(text.length, MAX_TEXT), truncated: text.length > MAX_TEXT, createdAt: new Date().toISOString() };
}
export async function fileSource(buffer: Buffer, filename: string) { return source('file', path.basename(filename), await extractFile(buffer, filename)); }
export function youtubeId(url: URL): string | undefined {
  let id: string | undefined;
  if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) id = url.pathname.split('/')[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) id = url.searchParams.get('v') || (/^\/(shorts|embed|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : undefined);
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
}
async function youtubeSource(id: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'commute-captions-'));
  const url = `https://www.youtube.com/watch?v=${id}`;
  try {
    await run(process.env.YTDLP_BIN || 'yt-dlp', ['--ignore-config', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en,fr', '--sub-format', 'json3', '--write-info-json', '--no-warnings', '--socket-timeout', '15', '--retries', '1', '--paths', dir, '-o', '%(id)s.%(ext)s', '--', url], { timeout: 90_000, maxOutput: 100_000 });
    const files = await readdir(dir);
    const captions = files.find(f => f.endsWith('.en.json3')) || files.find(f => f.endsWith('.fr.json3'));
    if (!captions) throw new Error('This video has no accessible English or French captions. Upload its transcript instead.');
    const json = JSON.parse(await readFile(path.join(dir, captions), 'utf8'));
    const lines: string[] = [];
    for (const event of json.events ?? []) { const text = (event.segs ?? []).map((s: any) => s.utf8 ?? '').join('').trim(); if (text && text !== lines.at(-1)) lines.push(text); }
    const metadata = JSON.parse(await readFile(path.join(dir, `${id}.info.json`), 'utf8'));
    return source('youtube', metadata.title || 'YouTube video', lines.join('\n'), url);
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (message.includes('no accessible')) throw e;
    throw new Error('Could not read this video’s captions. Check that yt-dlp is installed and updated, or upload the transcript. Private, restricted, or uncaptioned videos may not work.');
  } finally { if (path.dirname(path.resolve(dir)) === path.resolve(tmpdir()) && path.basename(dir).startsWith('commute-captions-')) await rm(dir, { recursive: true, force: true }); }
}
export async function urlSource(input: string): Promise<Source> {
  const url = validateSourceUrl(input); const id = youtubeId(url);
  if (id) return youtubeSource(id);
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) throw new Error('Use a link to a specific YouTube video.');
  const response = await fetchPublic(url.href);
  if (response.contentType.includes('pdf')) return source('url', decodeURIComponent(url.pathname.split('/').pop() || 'PDF source'), await extractFile(response.buffer, 'source.pdf'), response.url);
  if (response.contentType.includes('text/plain') || response.contentType.includes('markdown')) return source('url', url.hostname, response.buffer.toString('utf8'), response.url);
  if (!response.contentType.includes('html')) throw new Error('Use a web article or PDF link, or upload the source file.');
  const dom = new JSDOM(response.buffer.toString('utf8'), { url: response.url });
  try { const article = new Readability(dom.window.document).parse(); if (!article) throw new Error('Could not extract the article. Upload its text instead.'); return source('url', article.title || url.hostname, article.textContent || '', response.url); }
  finally { dom.window.close(); }
}
