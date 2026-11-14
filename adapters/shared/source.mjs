// Standard source verification: the standard must come from a valid, clean Git checkout with a
// full, verifiable HEAD. Read-only: only git plumbing that does not modify the repository.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError } from './canonical.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;
// Content that feeds generation; ignored files here would not be visible in `git status`.
const INPUT_PATHS = ['standards', 'adapters', 'installer', 'compatibility', 'VERSION', 'package.json'];

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

// Returns { head, tree, version }. Throws AdapterError SOURCE_* (callers must perform zero writes).
export function verifySource(root) {
  let top;
  try { top = git(root, ['rev-parse', '--show-toplevel']).trim(); } catch { throw new AdapterError('SOURCE_NOT_GIT', 'standard source is not a Git checkout'); }
  let real;
  try { real = realpathSync(root); } catch { throw new AdapterError('SOURCE_NOT_GIT', 'standard source is not accessible'); }
  if (realpathSync(top) !== real) throw new AdapterError('SOURCE_NOT_GIT', 'standard source is not the root of its own Git checkout');
  let head;
  let tree;
  try {
    head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
    if (!FULL_SHA.test(head) || git(root, ['cat-file', '-t', head]).trim() !== 'commit') throw new Error('bad head');
    tree = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}']).trim();
    if (!FULL_SHA.test(tree)) throw new Error('bad tree');
  } catch { throw new AdapterError('SOURCE_UNVERIFIABLE', 'standard source HEAD cannot be verified as a full commit'); }
  let dirty;
  try {
    dirty = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length > 0
      || git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...INPUT_PATHS]).length > 0
      || git(root, ['ls-files', '-v']).split('\n').some((l) => /^[a-zS]/.test(l)); // assume-unchanged / skip-worktree hide edits
  } catch { throw new AdapterError('SOURCE_UNVERIFIABLE', 'standard source working tree state cannot be verified'); }
  if (dirty) throw new AdapterError('SOURCE_DIRTY', 'standard source working tree is not clean');
  let version;
  try { version = readFileSync(join(root, 'VERSION'), 'utf8').trim(); } catch { version = ''; }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new AdapterError('SOURCE_UNVERIFIABLE', 'standard version cannot be read');
  return { head, tree, version };
}
