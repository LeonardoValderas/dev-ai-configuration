// Applies a generated plan to an explicit project directory.
// Guarantees: writes only inside the target, never follows symlinks, never overwrites
// files it does not manage (CONFLICT, zero writes), idempotent, journaled rollback.
// Never reads or writes the user-level provider configuration.
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT } from '../../installer/lib/run.mjs';
import { sha256, AdapterError } from './canonical.mjs';

export function createInstaller({ adapter, manifestPath: MANIFEST_PATH, verify = () => true, accepts = () => true }) {

const inside = (base, target) => {
  const r = relative(base, target);
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r));
};

function resolveTarget(target) {
  if (typeof target !== 'string' || target === '' || !isAbsolute(target)) throw new AdapterError('TARGET', 'target must be an absolute directory path');
  const abs = resolve(target);
  let st;
  try { st = lstatSync(abs); } catch { throw new AdapterError('TARGET', 'target directory does not exist'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AdapterError('TARGET', 'target must be a real directory (symlinks are not followed)');
  const real = realpathSync(abs);
  const home = (() => { try { return realpathSync(homedir()); } catch { return resolve(homedir()); } })();
  if (real === resolve('/') || real === home) throw new AdapterError('TARGET', 'refusing to install into a filesystem or home root');
  if (['.claude', '.codex', '.cursor', '.agents'].some((d) => inside(join(home, d), real) || real.split(sep).includes(d))) throw new AdapterError('TARGET', 'refusing to install into a user-level provider configuration directory');
  if (inside(realpathSync(REPO_ROOT), real)) throw new AdapterError('TARGET', 'refusing to install into the standards repository or any directory inside it');
  return real;
}

function inspect(target, rel) {
  // returns { kind: 'missing' | 'file' | 'other', buf?, reason? }; rejects symlinks on the path.
  let cur = target;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return { kind: 'missing' }; return { kind: 'other', reason: 'path cannot be inspected' }; }
    if (st.isSymbolicLink()) return { kind: 'other', reason: 'symlink in path' };
    if (i < parts.length - 1) { if (!st.isDirectory()) return { kind: 'other', reason: 'path component is not a directory' }; continue; }
    if (!st.isFile()) return { kind: 'other', reason: 'not a regular file' };
    return { kind: 'file', buf: readFileSync(cur) };
  }
  return { kind: 'missing' };
}

function readManifest(target) {
  const cur = inspect(target, MANIFEST_PATH);
  if (cur.kind === 'missing') return { manifest: null };
  if (cur.kind !== 'file') return { error: `manifest path unusable (${cur.reason})` };
  try {
    const m = JSON.parse(cur.buf.toString('utf8'));
    if (m?.adapter !== adapter || !Array.isArray(m.files) || m.files.some((f) => typeof f.path !== 'string' || typeof f.sha256 !== 'string' || f.path.startsWith('/') || f.path.split('/').includes('..') || !safePath(f.path) || !accepts(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256))) return { error: 'existing manifest is not a valid adapter manifest' };
    if (new Set(m.files.map((f) => f.path)).size !== m.files.length || m.files.some((f) => f.path === MANIFEST_PATH)) return { error: 'duplicate or self-referential ownership entry' };
    return { manifest: m, buf: cur.buf };
  } catch { return { error: 'existing manifest is not valid JSON' }; }
}

// Computes actions without touching the disk.
function planActions(target, plan) {
  verify(plan);
  for (const rel of plan.files.keys()) if (!safePath(rel) || !accepts(rel)) throw new AdapterError('PATH', 'unsafe generated path');
  const conflicts = [];
  const actions = [];
  const prior = readManifest(target);
  if (prior.error) conflicts.push({ path: MANIFEST_PATH, reason: prior.error });
  const managed = new Map((prior.manifest?.files ?? []).map((f) => [f.path, f.sha256]));
  managed.set(MANIFEST_PATH, prior.buf ? sha256(prior.buf) : undefined);
  for (const [rel, buf] of plan.files) {
    const cur = inspect(target, rel);
    if (cur.kind === 'other') { conflicts.push({ path: rel, reason: cur.reason }); continue; }
    if (cur.kind === 'missing') { actions.push({ op: 'create', path: rel, buf }); continue; }
    const diskHash = sha256(cur.buf);
    if (diskHash === sha256(buf)) { actions.push({ op: 'unchanged', path: rel }); continue; }
    if (managed.get(rel) === undefined) { conflicts.push({ path: rel, reason: 'file exists and is not managed by this adapter' }); continue; }
    if (managed.get(rel) !== diskHash) { conflicts.push({ path: rel, reason: 'managed file was modified locally' }); continue; }
    actions.push({ op: 'update', path: rel, buf, previous: cur.buf });
  }
  for (const [rel, hash] of managed) {
    if (plan.files.has(rel) || rel === MANIFEST_PATH) continue;
    const cur = inspect(target, rel);
    if (cur.kind === 'missing') continue;
    if (cur.kind !== 'file') { conflicts.push({ path: rel, reason: cur.reason }); continue; }
    if (sha256(cur.buf) !== hash) { conflicts.push({ path: rel, reason: 'stale managed file was modified locally' }); continue; }
    actions.push({ op: 'remove', path: rel, previous: cur.buf });
  }
  return { actions, conflicts };
}

function writeAtomic(abs, buf) {
  const tmp = `${abs}.dac-tmp-${process.pid}`;
  writeFileSync(tmp, buf, { flag: 'wx', mode: 0o644 });
  renameSync(tmp, abs);
}

// faultAfter: test-only fault injection (throw after N mutations) to exercise rollback.
function apply(target, plan, { dryRun = false, faultAfter = null } = {}) {
  const root = resolveTarget(target);
  const { actions, conflicts } = planActions(root, plan);
  const summary = (status) => ({ status, conflicts, created: pick(actions, 'create'), updated: pick(actions, 'update'), removed: pick(actions, 'remove'), unchanged: pick(actions, 'unchanged') });
  if (conflicts.length) return summary('CONFLICT');
  const changes = actions.filter((a) => a.op !== 'unchanged');
  if (changes.length === 0) return summary('UNCHANGED');
  if (dryRun) return summary('DRY_RUN');

  const journal = []; // undo entries, applied in reverse
  const createdDirs = [];
  let n = 0;
  try {
    for (const a of changes) {
      const abs = join(root, ...a.path.split('/'));
      if (a.op === 'remove') {
        unlinkSync(abs);
        journal.push({ abs, previous: a.previous });
      } else {
        const missing = [];
        for (let d = dirname(abs); d !== root;) { // collect dirs to create
          try { lstatSync(d); break; } catch { missing.push(d); d = dirname(d); }
        }
        for (const d of missing.reverse()) { mkdirSync(d); createdDirs.push(d); }
        journal.push({ abs, previous: a.op === 'update' ? a.previous : null });
        writeAtomic(abs, a.buf);
      }
      n++;
      if (faultAfter !== null && n >= faultAfter) throw new Error('injected fault');
    }
  } catch (e) {
    rollbackJournal(journal, createdDirs);
    const err = new AdapterError('APPLY_FAILED', 'apply failed and was rolled back; no partial state remains');
    err.rolledBack = true;
    err.cause = e;
    throw err;
  }
  return summary('APPLIED');
}

const pick = (actions, op) => actions.filter((a) => a.op === op).map((a) => a.path);

function rollbackJournal(journal, createdDirs) {
  for (const j of journal.reverse()) {
    try { if (j.previous === null) unlinkSync(j.abs); else writeFileSync(j.abs, j.previous); } catch { /* best effort per entry */ }
  }
  for (const d of createdDirs.reverse()) { try { rmdirSync(d); } catch { /* not empty or gone */ } }
}

// Removes only files this adapter installed and that are unmodified; keeps everything else.
function uninstall(target, { dryRun = false } = {}) {
  const root = resolveTarget(target);
  const prior = readManifest(root);
  if (prior.error) return { status: 'CONFLICT', conflicts: [{ path: MANIFEST_PATH, reason: prior.error }], removed: [], kept: [] };
  if (!prior.manifest) return { status: 'UNCHANGED', conflicts: [], removed: [], kept: [] };
  const removed = [];
  const kept = [];
  const dirs = new Set();
  for (const f of [...prior.manifest.files, { path: MANIFEST_PATH, sha256: sha256(prior.buf) }]) {
    const cur = inspect(root, f.path);
    if (cur.kind === 'missing') continue;
    if (cur.kind !== 'file' || sha256(cur.buf) !== f.sha256) { kept.push(f.path); continue; }
    removed.push(f.path);
    if (!dryRun) unlinkSync(join(root, ...f.path.split('/')));
    for (let d = dirname(f.path); d !== '.'; d = dirname(d)) dirs.add(d);
  }
  if (!dryRun) {
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      const abs = join(root, ...d.split('/'));
      try { if (readdirSync(abs).length === 0) rmdirSync(abs); } catch { /* keep */ }
    }
  }
  return { status: removed.length ? (dryRun ? 'DRY_RUN' : 'REMOVED') : 'UNCHANGED', conflicts: [], removed, kept };
}

return { apply, uninstall, planActions, resolveTarget };
}
function safePath(p) { return typeof p === 'string' && p.length > 0 && !/[\\:\x00-\x1f]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..'); }
