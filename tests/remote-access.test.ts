import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { request } from 'node:http';
import { accessControl, remoteAccessSchema } from '../server/remote-access.ts';

const remote = { origin: 'https://commute.example-tailnet.ts.net', login: 'owner@example.com' };

test('private access requires the configured Tailscale identity for pages, APIs, and audio', async () => {
  const app = express();
  app.use(accessControl(4310, remote));
  app.use((_req, res) => res.status(200).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const check = (headers: Record<string, string>, url = '/', method = 'GET') => new Promise<number | undefined>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end();
  });
  const host = new URL(remote.origin).hostname;
  const trusted = { host, 'tailscale-user-login': remote.login, 'x-forwarded-for': '100.64.1.2', 'x-forwarded-proto': 'https' };
  try {
    for (const url of ['/', '/api/library', '/api/episodes/example/audio', '/assets/app.js']) {
      assert.equal(await check({ host }, url), 403, 'anonymous / Funnel access is denied');
      assert.equal(await check({ ...trusted, 'tailscale-user-login': 'another@example.com' }, url), 403);
      assert.equal(await check(trusted, url), 200);
    }
    assert.equal(await check({ ...trusted, host: `${host}:443` }), 200);
    assert.equal(await check({ ...trusted, host: `${host}:444` }), 403);
    assert.equal(await check({ ...trusted, host: 'attacker.ts.net' }), 403);
    assert.equal(await check({ ...trusted, host: 'localhost:4310' }), 403, 'proxy cannot fall back to local bypass');
    assert.equal(await check({ host: 'localhost:4310', 'x-forwarded-for': '100.64.1.2' }), 403);
    assert.equal(await check({ host: 'attacker.test', 'x-forwarded-host': host, 'tailscale-user-login': remote.login }), 403);
    assert.equal(await check({ host: 'localhost:4310' }), 200);
    assert.equal(await check({ host: '127.0.0.1:4310' }), 200);
    const write = { ...trusted, origin: remote.origin, 'x-commute-client': '1' };
    assert.equal(await check(write, '/api/podcasts', 'POST'), 200);
    assert.equal(await check({ ...write, origin: 'https://attacker.test' }, '/api/podcasts', 'POST'), 403);
    assert.equal(await check({ ...write, origin: 'http://localhost:4310' }, '/api/podcasts', 'POST'), 403);
    assert.equal(await check({ ...trusted, origin: remote.origin }, '/api/podcasts', 'POST'), 403);
    assert.equal(await check({ host: 'localhost:4310', origin: remote.origin, 'x-commute-client': '1' }, '/api/podcasts', 'POST'), 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('remote configuration accepts only an exact HTTPS Tailscale device origin and account', () => {
  assert.deepEqual(remoteAccessSchema.parse({ ...remote, origin: remote.origin + '/' }), remote);
  for (const origin of ['http://commute.example-tailnet.ts.net', 'https://example.com', 'https://commute.example-tailnet.ts.net.evil.test', remote.origin + '/path', remote.origin + ':8443', remote.origin + '?key=x', 'https://user:secret@commute.example-tailnet.ts.net']) {
    assert.equal(remoteAccessSchema.safeParse({ ...remote, origin }).success, false, origin);
  }
  assert.equal(remoteAccessSchema.safeParse({ ...remote, login: '' }).success, false);
});
