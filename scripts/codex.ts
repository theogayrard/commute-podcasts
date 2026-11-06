import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveCodexExecutable } from '../server/codex-path.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const child = spawn(resolveCodexExecutable(), process.argv.slice(2), { stdio: 'inherit', shell: false });
child.on('error', () => {
  console.error('Codex could not be found. Install the official Codex CLI, or set CODEX_BIN to its executable path in .env.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
