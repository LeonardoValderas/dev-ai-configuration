// Post-run audit: comprehensive and blocking. A worktree is NOT a path-level sandbox, so the audit never trusts `git status`
// or the provider's own report. It walks the whole worktree (tracked, untracked AND ignored), compares every entry with the
// authorized base tree by content hash, type and mode, checks Git state (HEAD, refs, remotes, config, hooks) and the original
// project, and evaluates every change against the exact allowed paths, protected paths and ceilings.
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { within, norm } from '../../../installer/lib/sdd.mjs';
import { git, metaFingerprint, worktreeMetaFingerprint, mainFingerprint, resolveRef, sha256, fold, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_CHANGED_FILES } from './git.mjs';
import { digestOf, isProtected, isSensitive, explicitlyListed } from './context.mjs';

const MAX_WALK = 200000;
const MAX_VIOLATIONS = 100;
const BAD_NAME = /[\u0000-\u001f\u007f�‪-‮⁦-⁩\\]/;

export const blobOid = (format, buf) => createHash(format).update(`blob ${buf.length}\0`).update(buf).digest('hex');

function baseTree(wt, base) {
  const map = new Map();
  for (const l of git(wt, ['ls-tree', '-r', '-l', '-z', '--full-tree', base], { buffer: true }).toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) +([0-9a-f]+) +(\S+)\t(.*)$/s.exec(l);
    if (m) map.set(m[5], { mode: m[1], type: m[2], oid: m[3], size: m[4] === '-' ? 0 : Number(m[4]) });
  }
  return map;
}

function walk(wt, violations) {
  const out = []; const stack = [['', wt]]; let n = 0;
  while (stack.length) {
    const [rel, abs] = stack.pop();
    let names; try { names = readdirSync(abs); } catch { violations('unreadable-directory', rel || '.', 'a directory could not be read'); continue; }
    for (const name of names) {
      if (++n > MAX_WALK) { violations('walk-ceiling', rel || '.', `more than ${MAX_WALK} entries in the worktree`); return out; }
      const path = rel ? `${rel}/${name}` : name; const p = join(abs, name);
      if (rel === '' && name === '.git') continue; // the worktree link file is compared separately
      let st; try { st = lstatSync(p); } catch { violations('unreadable-entry', path, 'an entry could not be inspected'); continue; }
      if (name === '.git' || fold(name) === '.git') { violations('nested-git', path, 'nested Git metadata'); continue; }
      if (BAD_NAME.test(name)) violations('unsafe-name', path, 'name contains control, invalid-UTF-8, bidirectional or backslash characters');
      if (st.isDirectory()) { out.push({ path, type: 'dir' }); stack.push([path, p]); } else out.push({ path, type: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other', st, abs: p });
    }
  }
  return out;
}

// Git tree object id of a flat list of { path, mode: '100644'|'100755', oid } computed in pure JS (no Git, no writes), so the
// SAME tree id the audit obtained through `git write-tree` can be recomputed for any directory copy.
export function treeOid(format, files) {
  const build = (items) => {
    const byName = new Map();
    for (const f of items) {
      const i = f.path.indexOf('/');
      if (i < 0) byName.set(f.path, { mode: f.mode, oid: f.oid });
      else { const d = f.path.slice(0, i); if (!byName.has(d)) byName.set(d, { dir: [] }); byName.get(d).dir.push({ ...f, path: f.path.slice(i + 1) }); }
    }
    const parts = [...byName].map(([name, v]) => {
      const oid = v.dir ? build(v.dir) : v.oid; const mode = v.dir ? '40000' : v.mode;
      return { key: Buffer.from(v.dir ? `${name}/` : name, 'utf8'), buf: Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(oid, 'hex')]) };
    }).sort((a, b) => Buffer.compare(a.key, b.key));
    const body = Buffer.concat(parts.map((x) => x.buf));
    return createHash(format).update(`tree ${body.length}\0`).update(body).digest('hex');
  };
  return build(files);
}

// Deterministic manifest of a directory (the root `.git` entry is skipped; nested Git metadata is a problem).
//   strict=true : only what the audit accepts (regular files, no hardlinks/special modes, safe names); anything else is a problem;
//                 `tree` is the Git tree id of the content (comparable with audit.result_tree). Empty directories are not content.
//   strict=false: records every entry (files, symlinks, others; mode/size/sha256) for byproduct reporting; only walk failures are problems.
// Never follows symlinks. Returns { entries (sorted), tree, problems }.
export function manifestOf(dir, format, { strict = true } = {}) {
  const problems = []; const entries = [];
  const walked = walk(dir, (rule, path, detail) => { if (strict || rule === 'walk-ceiling' || rule === 'unreadable-directory' || rule === 'unreadable-entry') problems.push(`${rule}: ${path}: ${detail}`); });
  for (const e of walked) {
    if (e.type === 'dir') { if (!strict) entries.push({ path: e.path, type: 'dir' }); continue; }
    if (e.type === 'symlink') {
      if (strict) { problems.push(`symlink: ${e.path}: symlinks are not allowed`); continue; }
      let target = ''; try { target = readlinkSync(e.abs); } catch { /* unreadable */ }
      entries.push({ path: e.path, type: 'symlink', mode: (e.st.mode & 0o777).toString(8), size: e.st.size, sha256: sha256(Buffer.from(target)) }); continue;
    }
    if (e.type === 'other') { if (strict) problems.push(`special-file: ${e.path}: not a regular file`); else entries.push({ path: e.path, type: 'other', mode: (e.st.mode & 0o7777).toString(8), size: 0, sha256: null }); continue; }
    if (strict && e.st.nlink > 1) problems.push(`hardlink: ${e.path}: hard-linked file`);
    if (strict && (e.st.mode & 0o7000)) problems.push(`special-mode: ${e.path}: setuid, setgid or sticky bit`);
    let buf; try { buf = readFileSync(e.abs); } catch { problems.push(`unreadable-file: ${e.path}`); continue; }
    entries.push({ path: e.path, type: 'file', mode: strict ? ((e.st.mode & 0o111) ? '100755' : '100644') : (e.st.mode & 0o7777).toString(8), size: buf.length, sha256: sha256(buf), ...(strict ? { oid: blobOid(format, buf) } : {}) });
  }
  entries.sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0));
  const tree = strict && !problems.length ? treeOid(format, entries.filter((e) => e.type === 'file')) : null;
  return { entries, tree, problems };
}

// Returns { body, audit_hash, content_hash, diff, warnings }.
//   environment=true  (implementation): also compares the original project, refs, config, hooks and the worktree link file.
//   environment=false (review recheck): worktree content and worktree Git state only.
export function auditWorktree({ root, run, contract, pre = null, environment = true, claimedFiles = null, external = null }) {
  const viol = []; let vCount = 0;
  const violation = (rule, path, detail) => { vCount++; if (viol.length < MAX_VIOLATIONS) viol.push({ rule, path, detail }); };
  const wt = run.worktree.path; const base = run.base_commit; const fmt = run.object_format;
  const allowed = contract.allowed_paths.map(norm); const prohibited = contract.prohibited_paths;

  // ---- Git state ----
  const wtHead = git(wt, ['rev-parse', 'HEAD'], { allowFail: true })?.trim();
  if (wtHead !== base) violation('head-moved', '.', 'HEAD of the worktree is not the authorized base (a commit, reset or checkout happened)');
  if (git(wt, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true })?.trim() !== `refs/heads/${run.branch}`) violation('branch-changed', '.', 'the worktree is not on the run branch');
  if (resolveRef(root, `refs/heads/${run.branch}`) !== base) violation('ref-moved', run.branch, 'the run branch no longer points at the base');
  const gitDir = git(wt, ['rev-parse', '--absolute-git-dir'], { allowFail: true })?.trim();
  if (gitDir) {
    for (const f of ['config.worktree', 'hooks']) { try { lstatSync(join(gitDir, f)); violation('git-metadata', f, 'worktree-specific Git configuration appeared'); } catch { /* absent: expected */ } }
  }
  if (run.pre?.wtmeta && worktreeMetaFingerprint(wt) !== run.pre.wtmeta) violation('git-metadata', '.git', 'worktree-private Git metadata (info/exclude, info/sparse-checkout, config.worktree, hooks) changed; it can hide changes');
  if (environment) {
    try { if (readFileSync(join(wt, '.git'), 'utf8') !== run.worktree.git_file) violation('git-metadata', '.git', 'the worktree link file changed'); } catch { violation('git-metadata', '.git', 'the worktree link file is unreadable'); }
    if (pre) {
      if (metaFingerprint(root) !== pre.meta) violation('git-metadata', '.git', 'refs, remotes, config, hooks or info/ of the project repository changed during the run');
      if (mainFingerprint(root) !== pre.main) violation('original-project-modified', '.', 'the original project (index, files, DAC/provider directories) changed during the run');
    }
  }

  if (environment && external?.evidenceChanged) violation('evidence-modified', '.', 'approval records or the evidence of another run changed during the run');

  // ---- worktree content vs authorized base ----
  const baseMap = baseTree(wt, base);
  const gitlinks = [...baseMap].filter(([, v]) => v.type === 'commit').map(([k]) => k);
  const entries = walk(wt, violation);
  const seen = new Set(); const changes = [];
  let total = 0;
  for (const e of entries) {
    if (e.type === 'dir') continue;
    seen.add(e.path);
    if (gitlinks.some((g) => within(e.path, g))) { violation('submodule', e.path, 'content inside a submodule path'); continue; }
    const b = baseMap.get(e.path);
    if (e.type === 'symlink') {
      let ok = false;
      if (b?.mode === '120000') { try { ok = blobOid(fmt, Buffer.from(readlinkSync(e.abs))) === b.oid; } catch { ok = false; } }
      if (!ok) violation('symlink', e.path, 'symlinks are not allowed');
      continue;
    }
    if (e.type === 'other') { violation('special-file', e.path, 'not a regular file'); continue; }
    if (e.st.nlink > 1) violation('hardlink', e.path, 'hard-linked file');
    if (e.st.mode & 0o7000) violation('special-mode', e.path, 'setuid, setgid or sticky bit');
    const exec = (e.st.mode & 0o111) !== 0; const mode = exec ? '100755' : '100644';
    let status = null; let buf = null; let oid = null;
    if (!b) status = 'added';
    else if (b.type !== 'blob' || b.mode === '120000') { status = 'modified'; violation('type-change', e.path, 'a tracked symlink or non-file entry was replaced by a regular file (type change)'); }
    else if (b.size !== e.st.size) status = 'modified';
    else { buf = readFileSync(e.abs); oid = blobOid(fmt, buf); status = oid !== b.oid ? 'modified' : mode !== b.mode ? 'mode-changed' : null; }
    if (!status) continue;
    if (status === 'added' || status === 'modified') {
      if (e.st.size > MAX_FILE_BYTES) { violation('file-too-large', e.path, `larger than ${MAX_FILE_BYTES} bytes`); continue; }
      buf ??= readFileSync(e.abs);
      total += e.st.size;
    }
    changes.push({ path: e.path, status, mode, size: e.st.size, sha256: sha256(buf ?? readFileSync(e.abs)), base_oid: b?.oid ?? null, base_mode: b?.mode ?? null, abs: e.abs });
  }
  for (const [path, b] of baseMap) {
    if (b.type !== 'blob' || seen.has(path)) continue;
    changes.push({ path, status: 'deleted', mode: null, size: 0, sha256: null, base_oid: b.oid, base_mode: b.mode });
  }
  changes.sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0));
  if (changes.length > MAX_CHANGED_FILES) violation('too-many-files', '.', `${changes.length} changed files (limit ${MAX_CHANGED_FILES})`);
  if (total > MAX_TOTAL_BYTES) violation('total-too-large', '.', `${total} changed bytes (limit ${MAX_TOTAL_BYTES})`);

  // ignored files can hide content from `git status` and from a diff: any ignored addition is blocking
  const added = changes.filter((c) => c.status === 'added').map((c) => c.path);
  if (added.length) {
    const ign = git(wt, ['check-ignore', '--no-index', '-z', '--stdin'], { input: added.join('\0') + '\0', allowFail: true });
    for (const p of (ign ?? '').split('\0').filter(Boolean)) violation('ignored-file', p, 'ignored files cannot be reviewed from a diff');
  }

  // ---- per-change rules ----
  for (const c of changes) {
    const p = c.path;
    if (isProtected(p)) { violation('protected-path', p, 'protected location (Git, DAC, provider or instruction file)'); continue; }
    if (prohibited.some((x) => within(p, x))) { violation('prohibited-path', p, 'listed in prohibited_paths'); continue; }
    if (!allowed.some((a) => within(p, a))) { violation('out-of-scope', p, 'outside the exact allowed paths'); continue; }
    const exact = explicitlyListed(p, allowed);
    if (isSensitive(p) && !exact) violation('sensitive-not-explicit', p, 'manifest/lockfile/CI/environment files are writable only when the task lists their exact path');
    if (c.status === 'deleted' && !exact) violation('delete-not-explicit', p, 'deleting an existing file requires its exact path in the task scope');
    if (c.status === 'mode-changed' && !exact) violation('mode-change-not-explicit', p, 'mode changes of existing files require the exact path in the task scope');
    if (c.mode === '100755' && c.status !== 'modified' && !exact) violation('executable-not-explicit', p, 'new executable files require the exact path in the task scope');
    if (c.mode === '100755' && c.status === 'modified' && c.base_mode !== '100755') violation('mode-change-not-explicit', p, 'the executable bit changed');
  }

  // ---- reviewable content: exact tree + diff (only when nothing is violated) ----
  let resultTree = null; let diff = null;
  if (vCount === 0) {
    const tmp = mkdtempSync(join(tmpdir(), 'dac-audit-'));
    try {
      const idx = { GIT_INDEX_FILE: join(tmp, 'index') };
      git(wt, ['read-tree', base], { extraEnv: idx });
      const zero = '0'.repeat(fmt === 'sha256' ? 64 : 40);
      const lines = changes.map((c) => (c.status === 'deleted' ? `0 ${zero}\t${c.path}\n` : `${c.mode} ${git(wt, ['hash-object', '-w', '--no-filters', '--', c.abs]).trim()}\t${c.path}\n`)).join('');
      if (lines) git(wt, ['update-index', '--index-info'], { input: lines, extraEnv: idx });
      resultTree = git(wt, ['write-tree'], { extraEnv: idx }).trim();
      diff = git(wt, ['diff', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv', '--full-index', base, resultTree], { buffer: true });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  const pub = changes.map(({ abs, ...rest }) => rest);
  const content = { base_commit: base, branch: run.branch, changes: pub, totals: { files: pub.length, bytes: total }, result_tree: resultTree, diff_sha256: diff ? sha256(diff) : null };
  const body = { kind: 'dac-audit', schema: 1, run_id: run.run_id, project_id: run.project_id, task_id: run.task_id, status: vCount ? 'BLOCKED' : 'PASS', ...content, violation_count: vCount, violations: viol, environment_checked: environment };
  const warnings = [];
  if (claimedFiles) {
    const claimed = [...claimedFiles].sort().join('\n'); const actual = pub.map((c) => c.path).join('\n');
    if (claimed !== actual) warnings.push('the files_changed reported by the provider differ from the audited changes (the audit is authoritative)');
  }
  return { body, audit_hash: digestOf(body), content_hash: digestOf({ ...content, worktree_violations: vCount }), diff, warnings };
}
