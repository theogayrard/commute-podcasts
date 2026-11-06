import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, publicError } from './process.ts';
import type { AppStatus, Model } from '../shared/types.ts';
import { resolveCodexExecutable } from './codex-path.ts';

const executable = resolveCodexExecutable;
// Inherit the local Codex login, never a provider API key or the app's Gemini key.
function codexEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/API_KEY|SECRET|TOKEN/.test(name)) delete env[name];
  return env;
}

export async function inspectCodex(): Promise<AppStatus['codex']> {
  const child = spawn(executable(), ['app-server', '--disable', 'apps', '--disable', 'plugins'], { windowsHide: true, shell: false, env: codexEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); };
  const timer = setTimeout(() => { fail(new Error('Codex connection timed out. Run npm run codex:status to check your sign-in, then refresh.')); child.kill(); }, 15_000);
  child.on('error', () => fail(new Error('Codex CLI is not available. Install it or set CODEX_BIN in .env, then run npm run codex:login.')));
  child.on('exit', () => fail(new Error('Codex app server exited. Check your Codex CLI installation.')));
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line); const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    } catch { /* Ignore non-protocol diagnostics. */ }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'commute_podcasts', title: 'Commute Podcasts', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const account = await request('account/read', { refreshToken: false });
    if (!account.account) return { connected: false, error: 'Sign in with ChatGPT using npm run codex:login, then refresh.', models: [] };
    if (account.account.type !== 'chatgpt') return { connected: false, authType: account.account.type, error: 'Codex is using API billing. Sign in with ChatGPT to use your subscription.', models: [] };
    const models: Model[] = [];
    let cursor: string | undefined;
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const m of page.data ?? []) models.push({ id: m.model ?? m.id, name: m.displayName ?? m.model, description: m.description, isDefault: m.isDefault });
      cursor = page.nextCursor || undefined;
    } while (cursor);
    return { connected: true, authType: 'chatgpt', models };
  } catch (e) { return { connected: false, error: publicError(e), models: [] }; }
  finally { clearTimeout(timer); child.kill(); lines.close(); }
}

export type GenerateJson = (prompt: string, schema: object, model: string, research: boolean, signal?: AbortSignal) => Promise<any>;
export const generateJson: GenerateJson = async (prompt, schema, model, research, signal) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'commute-script-'));
  const schemaPath = path.join(dir, 'schema.json'); const outputPath = path.join(dir, 'output.json');
  try {
    await writeFile(schemaPath, JSON.stringify(schema));
    const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
      '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
      '-c', 'approval_policy="never"', '-c', `web_search="${research ? 'live' : 'disabled'}"`,
      '-c', 'model_reasoning_effort="medium"', '--model', model, '--output-schema', schemaPath, '--output-last-message', outputPath, '-'];
    await run(executable(), args, { input: prompt, cwd: dir, signal, timeout: 20 * 60_000, maxOutput: 6_000_000, env: codexEnvironment() });
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally { if (path.dirname(path.resolve(dir)) === path.resolve(tmpdir()) && path.basename(dir).startsWith('commute-script-')) await rm(dir, { recursive: true, force: true }); }
};
