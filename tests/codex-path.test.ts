import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexExecutable } from '../server/codex-path.ts';

test('Codex discovery honors an explicit override', () => {
  assert.equal(resolveCodexExecutable({ CODEX_BIN: 'custom-codex' }, 'win32'), 'custom-codex');
  assert.equal(resolveCodexExecutable({}, 'linux'), 'codex');
});

test('normal Windows sessions find the newest complete desktop installation without injected PATH or runtime variables', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'commute-discovery-'));
  try {
    const root = path.join(directory, 'OpenAI', 'Codex', 'bin');
    const old = path.join(root, 'old-build', 'codex.exe');
    const current = path.join(root, 'current-build', 'codex.exe');
    for (const file of [old, current]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'test fixture'); }
    await utimes(old, new Date('2025-01-01'), new Date('2025-01-01'));
    await utimes(current, new Date('2026-01-01'), new Date('2026-01-01'));
    await mkdir(path.join(root, 'incomplete-update'));
    const env = { LOCALAPPDATA: directory, PATH: '', CODEX_APP_RUNTIME_CLI_PATH: path.join(directory, 'removed.exe') };
    assert.equal(resolveCodexExecutable(env, 'win32'), current);
    const native = path.join(directory, 'standalone', 'codex.exe');
    await mkdir(path.dirname(native)); await writeFile(native, 'test fixture');
    assert.equal(resolveCodexExecutable({ ...env, PATH: path.dirname(native) }, 'win32'), native);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('commute-discovery-'));
    await rm(directory, { recursive: true, force: true });
  }
});
