import { spawn } from 'node:child_process';

export function run(command: string, args: string[], options: { input?: string; cwd?: string; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv; maxOutput?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(out.trim()); };
    const abort = () => { child.kill(); finish(new Error('Cancelled.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} timed out. Please retry.`)); }, options.timeout ?? 30_000);
    child.on('error', e => finish(new Error(`Could not run ${command}: ${e.message}`)));
    child.stdout.on('data', b => { out += b.toString(); if (out.length > (options.maxOutput ?? 2_000_000)) { child.kill(); finish(new Error('Command output exceeded the allowed size.')); } });
    child.stderr.on('data', b => { err = (err + b.toString()).slice(-3000); });
    child.on('close', code => finish(code === 0 ? undefined : new Error(err.trim() || `${command} exited with code ${code}.`)));
    child.stdin.on('error', () => {});
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input ?? '');
  });
}
export async function available(command: string, args = ['--version']) { try { await run(command, args, { timeout: 5000, maxOutput: 100_000 }); return true; } catch { return false; } }
export function publicError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/(?:AIza|AQ\.)[\w.-]+/g, '[redacted]').replace(/(?:sk-|Bearer\s+)[\w.-]+/g, '[redacted]').slice(0, 1400);
}
