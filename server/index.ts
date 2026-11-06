import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRemoteAccess } from './remote-access.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const { createApp } = await import('./app.ts');
const { dataDir } = await import('./store.ts');
const production = process.argv.includes('--production');
const remoteAccess = production ? await readRemoteAccess(path.join(dataDir, 'remote-access.json')) : undefined;
const { app, store, queue } = await createApp(undefined, remoteAccess);
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (production) {
  const express = (await import('express')).default;
  app.use(express.static(path.resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
} else {
  vite = await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: { port: Number(process.env.PORT || 4310) + 1 } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 4310);
const server = app.listen(port, '127.0.0.1', () => console.log(`\n  Commute is ready at http://localhost:${port}${remoteAccess ? `\n  Phone (Tailscale connected): ${remoteAccess.origin}` : ''}\n  Press Ctrl+C to stop.\n`));
server.on('error', error => { console.error(error.message); process.exit(1); });
const close = async () => { queue.stop(); server.close(); await vite?.close(); store.close(); process.exit(0); };
process.once('SIGINT', close); process.once('SIGTERM', close);
