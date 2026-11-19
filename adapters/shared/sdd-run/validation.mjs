// Independent validation for `dac review`: BEFORE the read-only reviewer is launched, dac itself executes exactly the task's
// authorized validation_commands (canonical task data the human already authorized) through a dedicated INJECTABLE runner that is
// separate from the implementer and the reviewer. Nothing here executes reviewer output, and nothing is shell-interpreted: a command
// is split into argv words from a strict character set, anything else fails closed.
//
// Isolation: the production runner wraps every command in macOS sandbox-exec (network denied, writes only inside the workspace);
// see validationRunner. Other platforms are BLOCKED. Task-glob/path prevention is NOT claimed.
//
// Disposable workspace: commands NEVER run in the audited implementation worktree. After the binding checks, dac materializes an
// exact, safe, standalone copy of the audited result tree (regular files only, no .git) under the numbered attempt directory,
// proves by a deterministic manifest that its Git tree id equals audit.result_tree, and runs the commands there. Whatever the
// commands generate (dist, coverage, node_modules...) is recorded as validation byproducts (path/type/mode/hash), is NOT a product
// change and cannot touch the audited content. The audited worktree, Git metadata, original project, immutable run files and other
// evidence are re-checked before EVERY command and after ALL of them; any drift blocks the review (the reviewer is never invoked).
//
// Cleanup: the workspace is removed only AFTER record.json (with manifests and output reports) was written. If anything throws before
// that, or removal fails, the workspace is retained and cleanup.json says so; it only ever removes its own attempt's workspace.
// Full records are written exclusively (never overwritten) under <run>/validation/attempt-<n>/, OUTSIDE the project; the reviewer only
// gets a bounded, redacted canonical summary.
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { canonicalize } from '../sdd-writer/artifacts.mjs';
import { manifestOf, blobOid } from './audit.mjs';
import { RunError, sha256 } from './git.mjs';
import { safeExcerpt } from './runners.mjs';
import { readJson, writeOnce } from './store.mjs';

export const VALIDATION_MAX_CAPTURE = 8 * 1024 * 1024; // bytes kept per stream in the full record
const EXCERPT = { maxLines: 20, maxLineChars: 240, maxBytes: 2048, causalOnly: false };
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TERM'];
const SUMMARY_PATHS = 25;
// Environment evidence: NAMES only, never values. Fixed keys are always set by dac; everything else is not inherited.
export const FIXED_ENV_KEYS = ['CI', 'HOME', 'TMPDIR', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_update_notifier'];
export const ENV_NOT_INHERITED = 'Provider, API, token and NODE_OPTIONS keys (and every other variable outside the allowlist) are NOT inherited.';
export function environmentEvidence(parentEnv) {
  return {
    note: 'variable NAMES only; no values are recorded',
    inherited_allowlist: ENV_KEYS, inherited_allowlist_present: ENV_KEYS.filter((k) => parentEnv[k] !== undefined),
    fixed_overrides: FIXED_ENV_KEYS, fixed_override_values: 'CI=1; npm_config_update_notifier=false; HOME, TMPDIR and the npm_config_* paths point into the private DAC infrastructure directories of the workspace',
    not_inherited: ENV_NOT_INHERITED,
  };
}

// A validation command becomes argv ONLY if it is plain words (no quoting, expansion, redirection, chaining, env assignment).
const WORD = /^[A-Za-z0-9_@%+:,.\/-][A-Za-z0-9_@%+=:,.\/-]*$/;
export function parseCommand(command) {
  if (typeof command !== 'string' || !command.length || command !== command.trim() || /\s{2,}|[^\S ]/.test(command)) return null;
  const argv = command.split(' ');
  return argv.every((w) => WORD.test(w)) && !argv[0].includes('=') && !argv[0].startsWith('-') ? argv : null;
}

// Production runner (macOS only, FAIL CLOSED elsewhere): every authorized command is spawned as
//   /usr/bin/sandbox-exec -D WORKSPACE=<canonical real workspace> -p <profile> <original executable> <original args...>   (shell:false)
// PREVENTIVE controls = the sandbox profile: all network* denied; every file-write* denied except under the canonical real path of the
// disposable validation workspace (not the audited worktree, run evidence, repository, HOME or general temp; /dev/null is the only
// extra sink). DETECTIVE controls = the binding checks/fingerprints around every command. Reads are NOT restricted. There is no
// isolator on other platforms: the runner refuses to run there (never a direct-spawn fallback); a missing/unusable sandbox-exec blocks too.
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_PROFILE = '(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath (param "WORKSPACE")) (literal "/dev/null"))\n';
export const SANDBOX_PROFILE_SHA256 = sha256(SANDBOX_PROFILE);
// DAC validation infrastructure inside the workspace (private HOME/TMPDIR/npm cache): NOT command output and NOT a product change.
export const INFRA_ROOT = '.dac-validation';
export const INFRA_DIRS = { home: `${INFRA_ROOT}/home`, tmp: `${INFRA_ROOT}/tmp`, npm_cache: `${INFRA_ROOT}/npm-cache` };
export const isInfrastructurePath = (p) => p === INFRA_ROOT || p.startsWith(`${INFRA_ROOT}/`);

export function validationRunner({ spawn = spawnSync, timeoutMs = 10 * 60 * 1000, platform = process.platform, sandboxExec = SANDBOX_EXEC, sandboxAvailable = () => existsSync(sandboxExec), parentEnv = process.env } = {}) {
  const describe = () => ({
    id: 'dac-independent-validation', role: 'validate', kind: 'sandbox-exec-argv', shell: false, bypass: false,
    isolation: { backend: 'macos-sandbox-exec', executable: sandboxExec, profile_id: 'dac-validation-write-network-deny-v1', profile_sha256: SANDBOX_PROFILE_SHA256, profile: SANDBOX_PROFILE, platform_supported: platform === 'darwin', non_darwin: 'BLOCKED: no supported isolator; commands are never direct-spawned' },
    sandbox: 'macos sandbox-exec', network: 'denied (deny network*)', filesystem: 'writes denied except under the canonical disposable validation workspace (+ /dev/null); reads not restricted',
    cwd: 'disposable validation workspace (exact content copy of the audited tree, no .git)',
    env: `allowlist: ${ENV_KEYS.join(', ')}, CI=1; HOME/TMPDIR/npm cache are private dirs inside the workspace`,
    environment: environmentEvidence(parentEnv),
    infrastructure: { note: 'DAC validation infrastructure, not command or product output', dirs: INFRA_DIRS },
    timeout_ms: timeoutMs, max_capture_bytes_per_stream: VALIDATION_MAX_CAPTURE,
  });
  return {
    id: 'dac-independent-validation', role: 'validate', describe,
    run({ argv, cwd }) {
      if (platform !== 'darwin') throw new Error(`no supported isolator on platform ${platform}: validation is BLOCKED (never run without isolation)`);
      if (!sandboxAvailable()) throw new Error(`${sandboxExec} is missing or unusable: validation is BLOCKED (never run without isolation)`);
      const ws = realpathSync(cwd);
      const infra = Object.fromEntries(Object.entries(INFRA_DIRS).map(([k, rel]) => [k, join(ws, rel)]));
      for (const d of Object.values(infra)) mkdirSync(d, { recursive: true, mode: 0o700 });
      const env = { ...Object.fromEntries(ENV_KEYS.filter((k) => parentEnv[k] !== undefined).map((k) => [k, parentEnv[k]])), CI: '1', HOME: infra.home, TMPDIR: infra.tmp, npm_config_cache: infra.npm_cache, npm_config_userconfig: join(infra.home, '.npmrc'), npm_config_globalconfig: join(infra.home, '.npmrc-global'), npm_config_update_notifier: 'false' };
      const r = spawn(sandboxExec, ['-D', `WORKSPACE=${ws}`, '-p', SANDBOX_PROFILE, ...argv], { cwd: ws, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: VALIDATION_MAX_CAPTURE, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      return { argv, status: r.status ?? null, signal: r.signal ?? null, error: r.error ? `${r.error.code ?? 'error'}: ${r.error.message}` : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

export function assertSafeValidationProfile(runner, ...otherIds) {
  const bad = (why) => { throw new RunError('UNSAFE_PROFILE', `the validation runner is not allowed: ${why}`); };
  if (!runner || runner.role !== 'validate' || typeof runner.run !== 'function' || typeof runner.describe !== 'function') bad('it must be a runner with role "validate"');
  const p = runner.describe();
  if (!p || p.role !== 'validate' || p.id !== runner.id) bad('its profile must declare role "validate" and its own id');
  if (p.shell !== false || p.bypass !== false) bad('shell and bypass must be explicitly false');
  if (otherIds.includes(runner.id)) bad('it must be a different identity than the implementer and the reviewer');
  return p;
}

const bounded = (text) => { const b = Buffer.from(String(text ?? ''), 'utf8'); return b.length > VALIDATION_MAX_CAPTURE ? { buf: b.subarray(0, VALIDATION_MAX_CAPTURE), truncated: true, total: b.length } : { buf: b, truncated: false, total: b.length }; };
// Fail closed if the audited tree has the reserved root (any type, any case, empty or not); descendants imply the root.
function reservedRootPresent(dir) {
  try {
    const hit = readdirSync(dir).find((n) => n.toLowerCase() === INFRA_ROOT);
    if (hit) return `found ${JSON.stringify(hit)}`;
  } catch (e) { return `top level unreadable: ${e.code ?? 'error'}`; }
  return null;
}
const iso = (ms) => new Date(ms).toISOString();
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Materialize the audited tree: re-reads every file of the (already manifest-verified) source without following symlinks, re-verifies
// the blob id of the bytes it is about to write, and creates regular files with mode 0644/0755 (exclusive create). Throws on any
// inconsistency. No Git metadata, no symlinks, no special files, no path escape.
export function materializeCopy(srcRoot, dstRoot, entries, format) {
  mkdirSync(dstRoot, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const parts = e.path.split('/');
    if (e.type !== 'file' || isAbsolute(e.path) || parts.some((x) => x === '' || x === '.' || x === '..' || x === '.git')) throw new Error(`refusing unsafe entry ${JSON.stringify(e.path)}`);
    const dst = join(dstRoot, ...parts); const rel = relative(dstRoot, dst);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escape: ${JSON.stringify(e.path)}`);
    const fd = openSync(join(srcRoot, ...parts), constants.O_RDONLY | constants.O_NOFOLLOW);
    let buf;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink > 1 || (st.mode & 0o7000)) throw new Error(`source is not a plain single-link file: ${e.path}`);
      buf = readFileSync(fd);
    } finally { closeSync(fd); }
    if (blobOid(format, buf) !== e.oid) throw new Error(`source changed while copying: ${e.path}`);
    mkdirSync(dirname(dst), { recursive: true, mode: 0o755 });
    const out = openSync(dst, 'wx', e.mode === '100755' ? 0o755 : 0o644);
    try { writeSync(out, buf); } finally { closeSync(out); }
    chmodSync(dst, e.mode === '100755' ? 0o755 : 0o644);
  }
}

// Byproducts of a command: entries generated / modified / deleted in the workspace relative to the previous snapshot.
function diffSnapshots(prev, next) {
  const key = (e) => `${e.type}|${e.mode ?? ''}|${e.sha256 ?? ''}`;
  const a = new Map(prev.map((e) => [e.path, e])); const b = new Map(next.map((e) => [e.path, e]));
  const generated = []; const modified = []; const deleted = [];
  for (const [p, e] of b) { const o = a.get(p); if (!o) generated.push(e); else if (key(o) !== key(e)) modified.push({ ...e, previous: { type: o.type, mode: o.mode ?? null, sha256: o.sha256 ?? null } }); }
  for (const [p, o] of a) if (!b.has(p)) deleted.push(o);
  return { generated, modified, deleted };
}
const countOf = (d) => ({ generated: d.generated.length, modified: d.modified.length, deleted: d.deleted.length });
// DAC infrastructure (private HOME/TMPDIR/cache) is reported separately from command byproducts.
function splitInfra(d) {
  const infra = { generated: [], modified: [], deleted: [] }; const out = { generated: [], modified: [], deleted: [] };
  for (const k of Object.keys(out)) for (const e of d[k]) (isInfrastructurePath(e.path) ? infra : out)[k].push(e);
  return { out, infra };
}
const INFRA_NOTE = 'DAC validation infrastructure (private HOME/TMPDIR/npm cache), NOT command or product output';

// checkBinding() -> string[] of drift reasons ([] = still exactly the audited/authorized state). Never throws on drift.
export async function runIndependentValidation({ root, run, contract, audit, runDir, runner, clock, checkBinding }) {
  const profile = runner.describe();
  const format = run.object_format ?? 'sha1';
  const reasons = [];
  const authz = readJson(join(runDir, 'authorization.json'));
  if (!authz || authz.digest !== run.authorization_digest || !Array.isArray(authz.validation_commands)) reasons.push('authorization.json is missing, unreadable or does not match the run');
  else if (JSON.stringify(authz.validation_commands) !== JSON.stringify(contract.validation_commands)) reasons.push('the validation commands of the authorization differ from the task contract: unauthorized command set');
  const commands = authz && Array.isArray(authz.validation_commands) && !reasons.length ? [...authz.validation_commands] : [];

  // reserve the next free attempt directory (exclusive mkdir): earlier attempts are evidence and are never touched
  const vdir = join(runDir, 'validation'); mkdirSync(vdir, { recursive: true, mode: 0o700 });
  let attempt = 1; let dir;
  for (;; attempt++) { dir = join(vdir, `attempt-${attempt}`); try { mkdirSync(dir, { mode: 0o700 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const workspace = join(dir, 'workspace');
  const sourceWorktree = run.worktree.path;

  const results = []; let ranAll = true; let workspaceCreated = false; let recorded = false;
  const ws = { kind: 'disposable-copy', path: null, source_worktree: sourceWorktree, git_metadata: 'not copied', pre_manifest_file: null, pre_manifest_sha256: null, tree: null, files: 0, matches_audit_result_tree: false };
  let snapshot = []; const perCommand = []; let finalOutputs = null;
  try {
    // ---- bind a disposable copy to the exact audited result tree (before any command) ----
    if (commands.length && !reasons.length) {
      const pre = checkBinding();
      if (pre.length) reasons.push(`state drift before the workspace copy: ${pre.join('; ')}`);
      else {
        const reserved = reservedRootPresent(sourceWorktree);
        const src = reserved ? null : manifestOf(sourceWorktree, format, { strict: true });
        if (reserved) reasons.push(`the audited tree contains the reserved DAC validation root ${INFRA_ROOT} (${reserved}); it must never be confused with DAC validation infrastructure: no copy was made and no command was run`);
        else if (src.problems.length) reasons.push(`the audited worktree cannot be copied safely: ${src.problems.slice(0, 5).join('; ')}`);
        else if (!audit.result_tree || src.tree !== audit.result_tree) reasons.push('the audited worktree content does not reproduce audit.result_tree; no copy was made');
        else {
          let copyError = null;
          try { workspaceCreated = true; materializeCopy(sourceWorktree, workspace, src.entries, format); } catch (e) { copyError = e; }
          if (copyError) reasons.push(`the validation workspace could not be materialized: ${safeExcerpt(copyError.message, { causalOnly: false, maxLines: 2 })}`);
          else {
            const copy = manifestOf(workspace, format, { strict: true });
            if (copy.problems.length || copy.tree !== audit.result_tree || !sameJson(copy.entries, src.entries)) reasons.push('the validation workspace copy does not match the audited tree (binding mismatch); no command was run');
            else {
              const manifest = { kind: 'dac-validation-workspace-manifest', schema: 1, attempt, result_tree: audit.result_tree, content_hash: audit.content_hash, object_format: format, entries: copy.entries };
              const file = join(dir, 'pre-manifest.json');
              ws.pre_manifest_file = file; ws.pre_manifest_sha256 = writeOnce(file, manifest); ws.tree = copy.tree; ws.files = copy.entries.length; ws.path = workspace; ws.matches_audit_result_tree = true;
              const base = manifestOf(workspace, format, { strict: false });
              if (base.problems.length) reasons.push(`the validation workspace could not be inventoried: ${base.problems.slice(0, 3).join('; ')}`); else snapshot = base.entries;
            }
          }
        }
      }
    }
    const initial = snapshot; // inventory of the exact copy before any command

    for (let i = 0; i < commands.length && !reasons.length; i++) {
      const command = commands[i];
      const argv = parseCommand(command);
      if (!argv) { reasons.push(`command ${i + 1} cannot be executed without a shell and is refused (not plain argv words): ${JSON.stringify(command.slice(0, 120))}`); ranAll = false; break; }
      const pre = checkBinding();
      if (pre.length) { reasons.push(`state drift before command ${i + 1}: ${pre.join('; ')}`); ranAll = false; break; }
      const t0 = clock(); let out = null; let thrown = null;
      try { out = await runner.run({ argv, command, cwd: workspace }); } catch (e) { thrown = e; }
      const t1 = clock();
      const entry = { index: i + 1, command, argv, cwd: workspace, started_at: iso(t0), finished_at: iso(t1), exit_code: null, signal: null, error: null, binding_before: 'equal' };
      const valid = out && typeof out === 'object' && typeof out.stdout === 'string' && typeof out.stderr === 'string' && (Number.isInteger(out.status) || typeof out.signal === 'string' || typeof out.error === 'string') && (out.argv === undefined || JSON.stringify(out.argv) === JSON.stringify(argv));
      let o = { stdout: '', stderr: '' };
      if (thrown) { entry.error = `runner failed: ${safeExcerpt(thrown.message, { causalOnly: false, maxLines: 3 })}`; reasons.push(`command ${i + 1} (${command}) could not be run: the validation runner failed`); }
      else if (!valid) { entry.error = 'the validation runner returned missing or inconsistent evidence'; reasons.push(`command ${i + 1} (${command}): missing or inconsistent validation evidence`); }
      else {
        o = out; entry.exit_code = Number.isInteger(out.status) ? out.status : null; entry.signal = out.signal ?? null; entry.error = out.error ?? null;
        if (entry.exit_code !== 0 || entry.signal || entry.error) reasons.push(`command ${i + 1} (${command}) failed: ${entry.error ? 'error' : entry.signal ? `signal ${entry.signal}` : `exit code ${entry.exit_code}`}`);
      }
      for (const stream of ['stdout', 'stderr']) {
        const b = bounded(o[stream]); const file = join(dir, `cmd-${i + 1}.${stream}.txt`);
        writeOnce(file, b.buf); // exclusive create
        entry[stream] = { file, bytes_total: b.total, bytes_kept: b.buf.length, truncated: b.truncated, sha256: sha256(b.buf), excerpt: safeExcerpt(b.buf.toString('utf8'), EXCERPT) };
      }
      // byproducts of THIS command inside the disposable workspace (never product changes)
      const after = manifestOf(workspace, format, { strict: false });
      if (after.problems.length) reasons.push(`command ${i + 1}: the validation workspace could not be inventoried afterwards: ${after.problems.slice(0, 3).join('; ')}`);
      else {
        const split = splitInfra(diffSnapshots(snapshot, after.entries)); const d = split.out; snapshot = after.entries; perCommand.push(d);
        const file = join(dir, `cmd-${i + 1}.outputs.json`);
        const sha = writeOnce(file, { kind: 'dac-validation-byproducts', schema: 1, attempt, command_index: i + 1, note: 'validation byproducts inside the disposable workspace; NOT product changes', ...d, dac_infrastructure: { note: INFRA_NOTE, counts: countOf(split.infra), paths: [...split.infra.generated, ...split.infra.modified].slice(0, SUMMARY_PATHS).map((e) => e.path) } });
        entry.workspace_outputs = { file, sha256: sha, counts: countOf(d), dac_infrastructure_counts: countOf(split.infra) };
      }
      results.push(entry);
      if (reasons.length) { ranAll = false; break; }
    }
    if (!reasons.length) { const post = checkBinding(); if (post.length) reasons.push(`state drift after the validation commands: ${post.join('; ')}`); }

    if (ws.path && perCommand.length) {
      // cumulative byproducts relative to the exact copy: what is left in the workspace at the end
      const sp = splitInfra(diffSnapshots(initial, snapshot)); const total = sp.out;
      const file = join(dir, 'outputs.json');
      const sha = writeOnce(file, { kind: 'dac-validation-byproducts', schema: 1, attempt, scope: 'cumulative, relative to the exact copy of the audited tree', note: 'validation byproducts inside the disposable workspace; NOT product changes; the audited worktree was not used as cwd', ...total, dac_infrastructure: { note: INFRA_NOTE, dirs: INFRA_DIRS, counts: countOf(sp.infra) } });
      finalOutputs = { file, sha256: sha, counts: countOf(total), dac_infrastructure: { dirs: INFRA_DIRS, counts: countOf(sp.infra) }, sample: { generated: total.generated.slice(0, SUMMARY_PATHS).map((e) => ({ path: e.path, type: e.type, mode: e.mode, sha256: e.sha256 })), modified: total.modified.slice(0, SUMMARY_PATHS).map((e) => ({ path: e.path, type: e.type, mode: e.mode, sha256: e.sha256 })), deleted: total.deleted.slice(0, SUMMARY_PATHS).map((e) => ({ path: e.path, type: e.type })) } };
    }

    const overall = reasons.length ? 'BLOCKED' : 'PASS';
    const record = {
      kind: 'dac-independent-validation', schema: 2, attempt, run_id: run.run_id, task_id: run.task_id, project_id: run.project_id,
      bound: { audit_hash: audit.audit_hash, content_hash: audit.content_hash, result_tree: audit.result_tree, diff_sha256: audit.diff_sha256, base_commit: run.base_commit },
      source_worktree: sourceWorktree, validation_cwd: ws.path, workspace: ws, workspace_outputs: finalOutputs, environment: profile.environment ?? null,
      cleanup_policy: 'the disposable workspace is removed only after this record was written; see cleanup.json (retained if removal fails or if recording failed)',
      runner: { id: runner.id, profile }, authorized_commands: commands, commands_not_run: commands.length - results.length, commands: results,
      binding_after: overall === 'PASS' ? 'equal' : 'not-verified-equal', overall, reasons, complete: ranAll && results.length === commands.length,
      isolation: profile.isolation ?? null,
      limits: 'PREVENTIVE (macOS sandbox-exec only): network denied, file writes denied outside the disposable workspace. DETECTIVE: binding/fingerprint checks of the audited worktree, Git metadata, project and evidence. Reads are not restricted; non-macOS is BLOCKED. Neither control proves what a command did not do.',
    };
    const recordFile = join(dir, 'record.json');
    const recordSha = writeOnce(recordFile, record);
    recorded = true;

    // ---- cleanup: only this attempt's own workspace, only after the evidence was recorded ----
    let cleanup = { status: 'not-created', path: null, reason: null };
    if (workspaceCreated) {
      cleanup = { status: 'retained', path: workspace, reason: null };
      try {
        const st = lstatSync(workspace);
        if (!st.isDirectory() || st.isSymbolicLink() || dirname(workspace) !== dir) cleanup.reason = 'the workspace path is not the expected directory; left untouched';
        else { rmSync(workspace, { recursive: true, force: true, maxRetries: 2 }); if (existsSync(workspace)) cleanup.reason = 'removal did not complete (cleanup uncertain)'; else cleanup = { status: 'removed', path: workspace, reason: null }; }
      } catch (e) { cleanup.reason = `removal failed (cleanup uncertain): ${safeExcerpt(e.message, { causalOnly: false, maxLines: 2 })}`; }
    }
    writeOnce(join(dir, 'cleanup.json'), { kind: 'dac-validation-cleanup', schema: 1, attempt, record_sha256: recordSha, ...cleanup });

    // bounded canonical summary for the reviewer prompt (full outputs stay in the record files)
    const summary = canonicalize({
      attempt, overall, record_file: recordFile, record_sha256: recordSha, bound: record.bound, source_worktree: sourceWorktree, validation_cwd: ws.path,
      workspace: { kind: ws.kind, git_metadata: ws.git_metadata, tree: ws.tree, files: ws.files, matches_audit_result_tree: ws.matches_audit_result_tree, pre_manifest_sha256: ws.pre_manifest_sha256, cleanup: cleanup.status },
      workspace_outputs: finalOutputs ? { note: 'validation byproducts in the disposable copy; NOT product changes', file: finalOutputs.file, sha256: finalOutputs.sha256, counts: finalOutputs.counts, sample: finalOutputs.sample } : null,
      environment: profile.environment ?? null,
      runner: { id: runner.id, profile }, authorized_commands: commands, commands_not_run: record.commands_not_run, reasons, limits: record.limits,
      commands: results.map(({ index, command, cwd, started_at, finished_at, exit_code, signal, error, stdout, stderr }) => ({ index, command, cwd, started_at, finished_at, exit_code, signal, error, stdout: { bytes_total: stdout.bytes_total, truncated: stdout.truncated, sha256: stdout.sha256, tail: stdout.excerpt }, stderr: { bytes_total: stderr.bytes_total, truncated: stderr.truncated, sha256: stderr.sha256, tail: stderr.excerpt } })),
    });
    return { ok: overall === 'PASS', reasons, record, summary, recordFile, recordSha, attempt, cleanup };
  } catch (e) {
    // recording failed before completion: the workspace (if any) is deliberately RETAINED, cleanup is uncertain
    if (!recorded && workspaceCreated) e.message = `${e.message} (validation workspace retained at ${workspace}; cleanup uncertain)`;
    throw e;
  }
}
