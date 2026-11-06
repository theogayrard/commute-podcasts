import { readFile } from 'node:fs/promises';
import type { RequestHandler } from 'express';
import { z } from 'zod';

export const remoteAccessSchema = z.object({
  origin: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)
      && !url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }, 'Use the HTTPS device address supplied by Tailscale Serve.').transform(value => new URL(value).origin),
  login: z.string().trim().min(1).max(320).regex(/^[\x21-\x7e]+$/, 'Use your Tailscale account login.'),
});
export type RemoteAccess = z.infer<typeof remoteAccessSchema>;

export async function readRemoteAccess(file: string): Promise<RemoteAccess | undefined> {
  try { return remoteAccessSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Invalid remote-access configuration. Run npm run remote:setup again.', { cause: error });
  }
}

export function accessControl(port: number, remote?: RemoteAccess): RequestHandler {
  const localOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const remoteHost = remote && new URL(remote.origin).hostname;
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const host = req.get('host')?.toLowerCase();
    const isRemote = !!remoteHost && (host === remoteHost || host === `${remoteHost}:443`);
    // Only a loopback listener behind Tailscale Serve may trust its identity header.
    // Never enable Express trust-proxy or bind this service to a LAN/public address.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
      return res.status(403).json({ error: 'Access must use localhost or the private Tailscale address.' });
    }
    if (isRemote) {
      if (req.get('tailscale-user-login') !== remote!.login) {
        return res.status(403).json({ error: 'Connect Tailscale on your phone using the same account as this PC.' });
      }
    } else if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)
      || ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'].some(header => req.get(header) !== undefined)) {
      return res.status(403).json({ error: 'Use localhost or your configured private Tailscale address.' });
    }
    if (req.path.startsWith('/api') && !['GET', 'HEAD'].includes(req.method)) {
      if (req.get('x-commute-client') !== '1') return res.status(403).json({ error: 'Request must come from the Commute app.' });
      const origin = req.get('origin');
      const allowedOrigins = isRemote ? [remote!.origin] : localOrigins;
      if (origin && !allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    next();
  };
}
