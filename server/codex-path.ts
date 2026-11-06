import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function isFile(filename: string) {
  try { return statSync(filename).isFile(); } catch { return false; }
}

/** The desktop app adds its bundled CLI to its own environment, not the user's PATH. */
export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  if (env.CODEX_APP_RUNTIME_CLI_PATH && isFile(env.CODEX_APP_RUNTIME_CLI_PATH)) return env.CODEX_APP_RUNTIME_CLI_PATH;
  if (platform !== 'win32') return 'codex';

  const searchPath = env.PATH || env.Path || '';
  for (const directory of searchPath.split(';').filter(Boolean)) {
    const executable = path.join(directory.replace(/^"|"$/g, ''), 'codex.exe');
    if (isFile(executable)) return executable;
  }
  if (env.LOCALAPPDATA) {
    const standalone = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isFile(standalone)) return standalone;
    const desktopRoot = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      // Updates create new version directories; don't pin a disposable build hash.
      const candidates = readdirSync(desktopRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(desktopRoot, entry.name, 'codex.exe'))
        .filter(isFile)
        .map(filename => ({ filename, modified: statSync(filename).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      if (candidates.length) return candidates[0].filename;
    } catch { /* No desktop installation; let the caller report installation guidance. */ }
  }
  return 'codex';
}
