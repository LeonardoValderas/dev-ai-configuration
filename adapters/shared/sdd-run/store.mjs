// Run evidence store. Lives OUTSIDE the project (default ~/.dac-runs, override with DAC_RUNS_DIR), never inside the working
// tree or the Git metadata, so evidence and worktrees survive and never pollute the project. Records are written exactly once
// (exclusive create, canonical JSON); nothing here ever deletes anything.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { canonicalBytes } from '../sdd-writer/artifacts.mjs';
import { RunError, sha256 } from './git.mjs';

export function stateRoot(deps = {}) {
  const dir = deps.stateDir ?? process.env.DAC_RUNS_DIR ?? join(homedir(), '.dac-runs');
  if (!isAbsolute(dir)) throw new RunError('STATE', 'the run state directory must be an absolute path');
  return dir;
}
export const projectKey = (root) => `${basename(root).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)}-${sha256(root).slice(0, 10)}`;
export const taskDir = (state, root, pid, tid) => join(state, projectKey(root), pid, tid);

export function assertStateOutside(state, root) {
  let real = state; while (!existsSync(real)) real = dirname(real);
  const rel = relative(root, join(realpathSync(real), relative(real, state)));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new RunError('STATE', 'the run state directory must not be inside the project');
}

export function writeOnce(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const buf = Buffer.isBuffer(data) ? data : typeof data === 'string' ? Buffer.from(data, 'utf8') : canonicalBytes(data);
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, buf); } finally { closeSync(fd); }
  return sha256(buf);
}
export const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const fileSha = (path) => { try { return sha256(readFileSync(path)); } catch { return null; } };

// One implement/review operation per task at a time. A dead owner's lock is replaced; a live owner blocks.
export function withLock(dir, fn) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.lock');
  for (let attempt = 0; ; attempt++) {
    try { const fd = openSync(lock, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lock, 'utf8'));
      let alive = true; try { process.kill(pid, 0); } catch (k) { alive = k.code === 'EPERM'; }
      if (alive || attempt > 0) throw new RunError('LOCKED', `another dac implement/review is running for this task (pid ${pid}); lock: ${lock}`);
      try { unlinkSync(lock); } catch { /* raced */ }
    }
  }
  const release = () => { try { unlinkSync(lock); } catch { /* gone */ } };
  let r; try { r = fn(); } catch (e) { release(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(release);
  release(); return r;
}

export function listRuns(dir) {
  let names = []; try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^r-[0-9a-z-]+$/.test(n)).sort().map((id) => {
    const d = join(dir, id);
    try { if (!lstatSync(d).isDirectory()) return null; } catch { return null; }
    const reviews = []; try { for (const n of readdirSync(join(d, 'reviews')).sort()) { const r = readJson(join(d, 'reviews', n)); if (r) reviews.push(r); } } catch { /* none */ }
    return { run_id: id, dir: d, run: readJson(join(d, 'run.json')), outcome: readJson(join(d, 'outcome.json')), audit: readJson(join(d, 'audit.json')), reviews };
  }).filter(Boolean);
}

// Fingerprint of everything a run must not touch in the state area: approval records and the evidence of every OTHER run of
// the task (the current run directory is excluded; worktrees are excluded because they are what the audit walks itself).
export function evidenceFingerprint(state, root, taskDirPath, currentRunId) {
  const out = {};
  const walk = (d, rel, top) => {
    let names = []; try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (n === 'worktree' || n === '.lock' || (top && n === currentRunId)) continue;
      const p = join(d, n); const r = `${rel}/${n}`; let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) out[r] = 'link'; else if (st.isDirectory()) walk(p, r, false); else out[r] = fileSha(p);
    }
  };
  walk(join(state, `approvals-${sha256(root).slice(0, 10)}`), 'approvals', false);
  walk(taskDirPath, 'task', true);
  return sha256(JSON.stringify(out));
}
