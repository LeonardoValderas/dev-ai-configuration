// Git plumbing for `dac implement` / `dac review`. Every call runs with a sanitized environment, no hooks, no filters,
// no fsmonitor and no prompts. The real index and working tree are never reset, cleaned or stashed; the baseline for an
// unborn repository is built from an explicit, reviewed file list (never `git add .`).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError } from '../canonical.mjs';

export class RunError extends AdapterError {
  constructor(code, message, details = {}) { super(code, message); this.details = details; }
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_CHANGED_FILES = 200;
export const MAX_BASELINE_FILES = 500;
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const fold = (s) => s.normalize('NFKC').toLowerCase();

// Provider/DAC-owned locations: never part of a baseline and never writable by an implementation.
export const DAC_DIRS = ['.dac', '.sdd', '.codex', '.claude', '.cursor', '.agents', '.specify'];
export const DAC_FILES = ['AGENTS.md', 'CLAUDE.md'];

const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false'];
const env = (extra = {}) => {
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...e, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...extra };
};
export function git(cwd, args, { input, extraEnv, buffer = false, allowFail = false } = {}) {
  try {
    const out = execFileSync('git', [...HARDEN, ...args], { cwd, env: env(extraEnv), input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    return buffer ? out : out.toString('utf8');
  } catch (e) {
    if (allowFail) return null;
    throw new RunError('GIT', `git ${args[0]} failed: ${String(e.stderr ?? e.message).trim().split('\n')[0].slice(0, 200)}`);
  }
}

export function repoInfo(root) {
  let top;
  try { top = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()); } catch { throw new RunError('NOT_GIT', 'the project is not a Git repository (git init first)'); }
  if (top !== realpathSync(root)) throw new RunError('GIT_ROOT', 'the project root must be the top level of its Git repository');
  let st; try { st = lstatSync(join(root, '.git')); } catch { throw new RunError('GIT_ROOT', '.git is missing'); }
  if (!st.isDirectory()) throw new RunError('GIT_ROOT', '.git must be a real directory (linked worktrees and submodules are not supported as the project root)');
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true })?.trim() || null;
  const headRef = git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })?.trim() || null;
  const format = git(root, ['rev-parse', '--show-object-format'], { allowFail: true })?.trim() || 'sha1';
  return { head, headRef, unborn: head === null, format, gitDir: join(root, '.git') };
}

// ---- porcelain status (never writes) --------------------------------------------------------------------
export function statusEntries(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { buffer: true }).toString('utf8').split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < out.length; i++) {
    const x = out[i]; const code = x.slice(0, 2); const path = x.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next token is the origin path
    entries.push({ code, path });
  }
  return entries;
}
const isDacPath = (p) => DAC_DIRS.some((d) => p === d || p.startsWith(`${d}/`)) || DAC_FILES.includes(p);
export const dirtyEntries = (root) => statusEntries(root).filter((e) => !isDacPath(e.path));

// ---- fingerprints (pre/post run comparison) --------------------------------------------------------------
const fileDigest = (abs) => {
  let st; try { st = lstatSync(abs); } catch { return 'missing'; }
  if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
  if (!st.isFile()) return 'other';
  return sha256(readFileSync(abs));
};
function treeDigest(abs, out, rel) {
  let names; try { names = readdirSync(abs).sort(); } catch { return; }
  for (const n of names) {
    const p = join(abs, n); const r = `${rel}/${n}`; let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory() && !st.isSymbolicLink()) { out[r] = 'dir'; treeDigest(p, out, r); } else out[r] = fileDigest(p);
  }
}

// The original project, as seen from outside the isolated worktree: HEAD, index, every non-ignored change with its content
// hash, the ignored top-level names, and the full content of the DAC/provider directories. A worktree is NOT a path sandbox,
// so the audit compares this before and after the run.
export function mainFingerprint(root) {
  const out = { head: git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })?.trim() ?? 'unborn', index: sha256(git(root, ['ls-files', '-s', '-z'], { buffer: true })) };
  out.status = {};
  for (const e of statusEntries(root)) out.status[e.path] = `${e.code}:${fileDigest(join(root, e.path))}`;
  out.ignored = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { buffer: true }).toString('utf8').split('\0').filter(Boolean).sort();
  out.dac = {};
  for (const d of DAC_DIRS) treeDigest(join(root, d), out.dac, d);
  for (const f of DAC_FILES) out.dac[f] = fileDigest(join(root, f));
  return sha256(JSON.stringify(out));
}

// Repository metadata that a run must not touch: config (remotes, hooks, filters), hooks, info/, alternates, HEAD, refs.
export function metaFingerprint(root) {
  const g = join(root, '.git'); const out = {};
  for (const f of ['config', 'HEAD', 'objects/info/alternates', 'packed-refs', 'shallow']) out[f] = fileDigest(join(g, f));
  for (const d of ['hooks', 'info']) treeDigest(join(g, d), out, d);
  out.refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)'], { allowFail: false }).split('\n').filter(Boolean).sort();
  out.remotes = git(root, ['config', '--get-regexp', '^(remote|url|branch)\\.'], { allowFail: true }) ?? '';
  return sha256(JSON.stringify(out));
}

// Worktree-private Git metadata (and the shared info/ files) that can hide changes from status/diff: info/exclude,
// info/sparse-checkout, config.worktree, hooks, commondir/gitdir. Computed from the worktree's own git dir.
export function worktreeMetaFingerprint(wt) {
  const gd = git(wt, ['rev-parse', '--absolute-git-dir'], { allowFail: true })?.trim();
  const cd = git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true })?.trim();
  const out = { gd: Boolean(gd) };
  if (gd) { for (const f of ['config.worktree', 'commondir', 'gitdir', 'info/exclude', 'info/sparse-checkout']) out[`wt:${f}`] = fileDigest(join(gd, f)); for (const d of ['hooks', 'info']) treeDigest(join(gd, d), out, `wt:${d}`); }
  if (cd) for (const d of ['info', 'hooks']) treeDigest(join(cd, d), out, `common:${d}`);
  if (cd) for (const f of ['info/exclude', 'info/sparse-checkout']) out[`common:${f}`] = fileDigest(join(cd, f));
  return sha256(JSON.stringify(out));
}

// ---- unborn repository: explicit, reviewed baseline ------------------------------------------------------
const SENSITIVE_NAME = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

// Returns { files, excluded, digest }. Nothing is written. `files` is exactly what the baseline commit would contain.
export function planBaseline(root) {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { buffer: true }).toString('utf8').split('\0').filter(Boolean);
  const staged = new Map();
  for (const l of git(root, ['ls-files', '-s', '-z'], { buffer: true }).toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.*)$/s.exec(l); if (m) staged.set(m[3], m[2]);
  }
  const files = []; const excluded = [];
  for (const p of [...new Set(listed)].sort()) {
    const skip = (reason) => excluded.push({ path: p, reason });
    if (isDacPath(p)) { skip('dac-managed'); continue; }
    if (p.split('/').some((s) => fold(s) === '.git') || fold(p) === '.gitmodules') { skip('git-metadata'); continue; }
    if (/[\u0000-\u001f\u007f\\]/.test(p)) { skip('unsafe-name'); continue; }
    if (SENSITIVE_NAME.test(p)) { skip('sensitive-name'); continue; }
    let st; try { st = lstatSync(join(root, p)); } catch { skip('missing'); continue; }
    if (st.isSymbolicLink()) { skip('symlink'); continue; }
    if (!st.isFile()) { skip('not-a-regular-file'); continue; }
    if (st.nlink > 1) { skip('hard-linked'); continue; }
    if (st.size > MAX_FILE_BYTES) { skip('too-large'); continue; }
    const buf = readFileSync(join(root, p));
    const mode = st.mode & 0o111 ? '100755' : '100644';
    if (staged.has(p) && staged.get(p) !== git(root, ['hash-object', '--no-filters', '--stdin'], { input: buf }).trim()) { skip('staged-content-differs'); continue; }
    files.push({ path: p, mode, sha256: sha256(buf), size: st.size });
  }
  if (files.length > MAX_BASELINE_FILES) throw new RunError('BASELINE_TOO_LARGE', `the reviewed baseline would contain ${files.length} files (limit ${MAX_BASELINE_FILES}); add a .gitignore or commit manually`);
  return { files, excluded, digest: sha256(JSON.stringify(files.map((f) => [f.path, f.mode, f.sha256]))) };
}

const identityOf = (root) => {
  const get = (k) => git(root, ['config', k], { allowFail: true })?.trim();
  return { name: get('user.name') || 'dac', email: get('user.email') || 'dac@localhost.invalid' };
};

// Creates the baseline commit from exactly `plan.files` (re-verified byte for byte), on the branch HEAD already names.
// A temporary index is used for the commit; the real index only gains entries equal to the new HEAD.
export function applyBaseline(root, plan, message = 'dac: reviewed baseline') {
  const info = repoInfo(root);
  if (!info.unborn || !info.headRef) throw new RunError('BASELINE_STATE', 'the repository is no longer unborn; nothing was committed');
  const again = planBaseline(root);
  if (again.digest !== plan.digest) throw new RunError('DRIFT', 'the project files changed after the baseline was reviewed; nothing was committed');
  const tmp = mkdtempSync(join(tmpdir(), 'dac-idx-'));
  try {
    const idx = { GIT_INDEX_FILE: join(tmp, 'index') };
    const lines = plan.files.map((f) => `${f.mode} ${git(root, ['hash-object', '-w', '--no-filters', '--', join(root, f.path)]).trim()}\t${f.path}\n`).join('');
    git(root, ['update-index', '--add', '--index-info'], { input: lines, extraEnv: idx });
    const tree = git(root, ['write-tree'], { extraEnv: idx }).trim();
    const who = identityOf(root);
    const commit = git(root, ['commit-tree', tree, '-m', message], { extraEnv: { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } }).trim();
    git(root, ['update-ref', '-m', 'dac baseline', info.headRef, commit, '']);
    git(root, ['update-index', '--add', '--index-info'], { input: lines }); // real index: entries equal to HEAD only; staged-but-excluded entries stay staged
    const got = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { buffer: true }).toString('utf8').split('\0').filter(Boolean).length;
    if (got !== plan.files.length) throw new RunError('BASELINE_VERIFY', 'the baseline commit does not match the reviewed list');
    return { commit, tree };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- isolated branch + worktree --------------------------------------------------------------------------
export function createWorktree(root, { path, branch, base }) {
  if (git(root, ['check-ref-format', `refs/heads/${branch}`], { allowFail: true }) === null) throw new RunError('BRANCH', 'invalid branch name');
  if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })) throw new RunError('BRANCH', 'the run branch already exists');
  git(root, ['worktree', 'add', '-q', '-b', branch, path, base]);
  const wt = realpathSync(path);
  const head = git(wt, ['rev-parse', 'HEAD']).trim();
  if (head !== base) throw new RunError('WORKTREE', 'the new worktree is not at the authorized base');
  return { path: wt, gitFile: readFileSync(join(wt, '.git'), 'utf8') };
}

export const resolveRef = (root, ref) => git(root, ['rev-parse', '--verify', '-q', ref], { allowFail: true })?.trim() || null;
