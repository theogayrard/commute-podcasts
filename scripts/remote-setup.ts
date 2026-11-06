import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { run } from '../server/process.ts';
import { remoteAccessSchema } from '../server/remote-access.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const executable = process.env.TAILSCALE_BIN || (process.platform === 'win32'
  ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(dir => path.join(dir!, 'Tailscale', 'tailscale.exe')).find(existsSync)
  : undefined) || 'tailscale';

try {
  const status = JSON.parse(await run(executable, ['status', '--json']));
  if (status.BackendState !== 'Running') throw new Error('Open Tailscale on your PC and sign in before running this command again.');
  const remote = remoteAccessSchema.parse({
    origin: `https://${String(status.Self?.DNSName || '').replace(/\.$/, '')}`,
    login: status.User?.[status.Self?.UserID]?.LoginName,
  });
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const target = `http://127.0.0.1:${port}`;
  const hostPort = `${new URL(remote.origin).hostname}:443`;
  const existing = JSON.parse(await run(executable, ['serve', 'status', '--json']));
  const handlers = existing.Web?.[hostPort]?.Handlers;
  if ((handlers && (Object.keys(handlers).some(route => route !== '/') || handlers['/']?.Proxy !== target))
    || (existing.TCP?.['443'] && !handlers)) {
    throw new Error('Tailscale port 443 is already used by another service. Its settings have been left unchanged.');
  }
  console.log('Setting up private HTTPS access. If Tailscale prints an enablement link, open it to enable HTTPS/Serve, then return here.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['serve', '--bg', '--yes', '--https=443', target], { stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Tailscale Serve was not enabled. Complete the step above, then run npm run remote:setup again.')));
  });
  const served = JSON.parse(await run(executable, ['serve', 'status', '--json']));
  if (served.AllowFunnel?.[hostPort] || served.Web?.[hostPort]?.Handlers?.['/']?.Proxy !== target) {
    throw new Error('Private forwarding could not be verified. Check tailscale serve status before continuing.');
  }
  const directory = path.resolve(process.env.DATA_DIR || '.data');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'remote-access.json');
  await writeFile(file + '.tmp', JSON.stringify(remote, null, 2) + '\n', { mode: 0o600 });
  await rename(file + '.tmp', file);
  console.log(`\nPrivate address: ${remote.origin}\n\nOn your PC: stop npm run dev, then run npm run build and npm start.\nOn your phone: connect Tailscale using the same account, then open the address above.\nKeep your PC awake and leave Commute running.\n`);
} catch (error) {
  console.error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Install Tailscale on your PC first: https://tailscale.com/download' : (error as Error).message);
  process.exitCode = 1;
}
