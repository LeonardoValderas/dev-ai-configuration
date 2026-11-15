// Exclusive per-target/project lock under .sdd/locks/. The lock lifecycle is a writer-owned exception
// outside the executeActions action list (the executor never removes anything).
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WriterError, SDD_ROOT, lockPath, readDestination, canonicalBytes, digestOf } from './artifacts.mjs';
import { inspect } from '../apply.mjs';

// Start-time string of a live process, or null if there is no such process / it cannot be determined.
export function processStart(pid, exec = execFileSync) {
  try {
    const out = exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? null : out;
  } catch { return null; }
}

// Liveness of a recorded owner, fail-safe. Returns 'alive' | 'dead' | 'unverifiable'.
// `ps -o lstart=` must demonstrably work on this platform: it is probed on our own pid first. If the probe
// fails (ps missing, option unsupported, restricted /proc, ...) nothing can be concluded, so the answer is
// 'unverifiable' and the lock is never recovered. Without a recorded start time (null) the owner cannot be
// told apart from a recycled pid, so that is 'unverifiable' as well. Age is never consulted.
export function ownerState(info, exec = execFileSync) {
  if (info.process_start === null || typeof info.process_start !== 'string') return 'unverifiable';
  if (processStart(process.pid, exec) === null) return 'unverifiable';
  const now = processStart(info.pid, exec);
  if (now === null) return 'dead';
  return now === info.process_start ? 'alive' : 'dead';
}

function ensureDir(root, rel, created) {
  let cur = root;
  for (const seg of rel.split('/')) {
    cur = join(cur, seg);
    let st = null;
    try { st = lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw new WriterError('PATH_POLICY', 'path rejected: cannot inspect lock directory'); }
    if (st) { if (st.isSymbolicLink() || !st.isDirectory()) throw new WriterError('PATH_POLICY', 'path rejected: lock directory is a symlink or not a directory'); continue; }
    mkdirSync(cur);
    created.push(cur);
  }
}

function readLock(root, projectId) {
  const cur = inspect(root, lockPath(projectId));
  if (cur.kind === 'missing') return { missing: true };
  if (cur.kind !== 'file') return { invalid: true };
  try {
    const v = JSON.parse(cur.buf.toString('utf8'));
    const keys = ['token', 'pid', 'host', 'process_start', 'project_id', 'target', 'created_at'];
    if (!v || JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...keys].sort()) || !/^[0-9a-f]{32}$/.test(v.token) || !Number.isInteger(v.pid) || v.pid < 1) return { invalid: true };
    return { info: v };
  } catch { return { invalid: true }; }
}

export function acquireLock(root, { projectId, target, nowMs }) {
  readDestination(root, lockPath(projectId)); // path policy / alias / symlink checks (missing is fine)
  const info = { token: randomBytes(16).toString('hex'), pid: process.pid, host: hostname(), process_start: processStart(process.pid), project_id: projectId, target, created_at: new Date(nowMs).toISOString() };
  const created = [];
  const abs = join(root, ...lockPath(projectId).split('/'));
  for (let attempt = 0; ; attempt++) {
    ensureDir(root, `${SDD_ROOT}/locks`, created);
    try { writeFileSync(abs, canonicalBytes(info), { flag: 'wx', mode: 0o600 }); break; } catch (e) {
      if (e.code === 'EEXIST') {
        const l = readLock(root, projectId);
        throw new WriterError('LOCKED', 'another writer holds the lock for this target and project', { owner: l.info ? { pid: l.info.pid, host: l.info.host, created_at: l.info.created_at } : 'unreadable' });
      }
      if (e.code === 'ENOENT' && attempt < 3) continue; // a concurrent release pruned the directory
      throw new WriterError('LOCK_FAILED', 'could not create the lock file');
    }
  }
  return {
    info,
    release() {
      const l = readLock(root, projectId);
      if (l.info?.token === info.token) { try { unlinkSync(abs); } catch { /* already gone */ } }
      for (const d of [...created].reverse()) { try { rmdirSync(d); } catch { /* not empty: owned by someone else now */ } }
    },
  };
}

// Recovery of an existing lock: only after proving the recorded owner is no longer active AND a human
// confirms on the trusted terminal. Never based on age. Returns { removed_token }.
export function recoverLock(root, { projectId, terminal, hooks = {}, exec = execFileSync, confirmTimeoutMs = 120000 }) {
  const l = readLock(root, projectId);
  if (l.missing) return { removed_token: null };
  if (l.invalid) throw new WriterError('LOCK_RECOVERY_REFUSED', 'the lock file is unreadable or foreign; its owner cannot be verified');
  const o = l.info;
  if (o.host !== hostname()) throw new WriterError('LOCK_RECOVERY_REFUSED', 'the lock was created on another host; its owner cannot be verified');
  if (o.project_id !== projectId) throw new WriterError('LOCK_RECOVERY_REFUSED', 'the lock belongs to another project');
  const ownerDead = () => ownerState(o, exec) === 'dead';
  if (!ownerDead()) throw new WriterError('LOCK_RECOVERY_REFUSED', 'the recorded lock owner is still active or cannot be verified as dead (process start time unsupported or unavailable on this platform)');
  const phrase = `recover ${o.token.slice(0, 8)}`;
  const ok = terminal.confirm(`Stale lock for project "${projectId}": owner pid ${o.pid} on ${o.host}, created ${o.created_at}, token ${o.token}. The recorded owner process is not running.`, phrase, { timeoutMs: confirmTimeoutMs });
  if (!ok) throw new WriterError('LOCK_RECOVERY_REFUSED', 'lock recovery was not confirmed');
  hooks.beforeLockRemoval?.();
  const again = readLock(root, projectId);
  if (!again.info || again.info.token !== o.token || digestOf(again.info) !== digestOf(o) || !ownerDead()) throw new WriterError('LOCK_RECOVERY_REFUSED', 'the lock changed during recovery; token or owner no longer matches');
  unlinkSync(join(root, ...lockPath(projectId).split('/')));
  return { removed_token: o.token };
}
