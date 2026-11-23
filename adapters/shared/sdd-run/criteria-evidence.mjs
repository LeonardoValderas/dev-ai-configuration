// Criterion -> evidence matrix for `dac review`. READ-ONLY and derived: it re-reads only evidence that already exists (the ORIGINAL
// project's managed metadata, the audited result/baseline trees in Git, and the recorded independent-validation record), binds every
// item to run_id / base_commit / result_tree / audit_hash, and never writes, re-runs or reinterprets anything. Run authorization,
// hashes, standard_commit and prior evidence are untouched. Nothing here can turn absent evidence into a PASS.
//
// Vocabularies (never merged):
//   managed metadata (.dac/project.json of the ORIGINAL project): absent | uninspected | baseline-bound (proven unchanged from run.pre.main) | drift
//   package_name vs package.json name: match | mismatch | not-comparable (reason given)
//   package.json change (exact audited result tree vs the exact base commit): absent | uninspected | match (unchanged from baseline) | changed
//   validation binding items: verified | mismatch | not-recorded
//   matrix status: available (readable now from preserved evidence) | recoverable (preserved but not read/verified here; re-inspect) | not-recorded (never captured)
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, sha256, mainFingerprint } from './git.mjs';
import { canonicalize } from '../sdd-writer/artifacts.mjs';
import { fileSha } from './store.mjs';

const MAX_META = 1024 * 1024;
const PROJECT_FILE = '.dac/project.json';
const bind = (run, audit) => ({ run_id: run.run_id, base_commit: run.base_commit, result_tree: audit.result_tree ?? null, audit_hash: audit.audit_hash });

// ---- managed project metadata: ORIGINAL project .dac/project.json, bound to the run baseline (run.pre.main) ----
// Current-vs-baseline binding uses the fingerprint the run already recorded: mainFingerprint(root) === run.pre.main proves the
// whole original project (including .dac/project.json) is unchanged since the baseline. Otherwise only "drift" is reported: which
// component changed is NOT guessed and the current package_name is not treated as the baseline value.
export function inspectManagedMetadata({ root, run, audit }) {
  const out = { source: `ORIGINAL project ${PROJECT_FILE} (not the worktree, not .dac/standard.json)`, binding: bind(run, audit), baseline_fingerprint: run.pre?.main ?? null };
  const abs = join(root, PROJECT_FILE);
  let st; try { st = lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT') return { ...out, status: 'uninspected', reason: 'the file could not be inspected' }; st = null; }
  if (!st) return { ...out, status: 'absent', reason: 'the original project has no managed .dac/project.json now' };
  if (!st.isFile() || st.size > MAX_META) return { ...out, status: 'uninspected', reason: 'not a regular file within the size limit; not read' };
  let buf; try { buf = readFileSync(abs); } catch { return { ...out, status: 'uninspected', reason: 'unreadable' }; }
  out.current_sha256 = sha256(buf);
  let cur = null; try { cur = mainFingerprint(root); } catch { /* reported below */ }
  if (!run.pre?.main) return { ...out, status: 'uninspected', reason: 'the run recorded no baseline fingerprint to bind the current project to' };
  if (cur === null) return { ...out, status: 'uninspected', reason: 'the current original-project fingerprint could not be computed' };
  if (cur !== run.pre.main) return { ...out, status: 'drift', baseline: 'drift', reason: 'the original project differs from the run baseline (run.pre.main); which component changed is not determined and the current package_name is not baseline-bound' };
  let doc = null; try { doc = JSON.parse(buf.toString('utf8')); } catch { /* shape check below */ }
  const exact = doc && typeof doc === 'object' && !Array.isArray(doc) && doc.schema === 1 && typeof doc.package_name === 'string' && doc.package_name !== '' && Object.keys(doc).sort().join() === 'package_name,schema';
  if (!exact) return { ...out, status: 'uninspected', baseline: 'unchanged-from-baseline', reason: 'not the exact managed shape {"schema":1,"package_name":<string>}; package_name not read' };
  return { ...out, status: 'baseline-bound', baseline: 'unchanged-from-baseline', package_name: doc.package_name, reason: 'current .dac/project.json is proven unchanged from the run baseline (mainFingerprint equals run.pre.main)' };
}

// Semantic comparison: baseline-bound managed package_name vs the audited result's package.json "name". Never guessed.
export function comparePackageName(metadata, packageJson) {
  const r = packageJson.result;
  const pkg = !r ? { state: 'uninspected', why: packageJson.reason } : r;
  if (metadata.status !== 'baseline-bound') return { result: 'not-comparable', reason: `managed metadata is ${metadata.status}`, package_name: null, package_json_name: null };
  const base = { package_name: metadata.package_name, package_json_name: null };
  if (pkg.state === 'absent') return { ...base, result: 'not-comparable', reason: 'the audited result has no package.json' };
  if (pkg.state !== 'present') return { ...base, result: 'not-comparable', reason: 'package.json could not be read from the audited result' };
  if (!pkg.parsed) return { ...base, result: 'not-comparable', reason: 'the audited result package.json is not a valid JSON object' };
  if (typeof pkg.name !== 'string' || pkg.name === '') return { ...base, result: 'not-comparable', reason: 'the audited result package.json has no usable name' };
  return { ...base, package_json_name: pkg.name, result: pkg.name === metadata.package_name ? 'match' : 'mismatch', reason: pkg.name === metadata.package_name ? 'package_name equals the audited package.json name' : 'package_name differs from the audited package.json name' };
}

// ---- package.json: exact audited result tree vs exact base commit, via Git objects (no checkout, no writes) ----
function blobAt(wt, rev) {
  const ls = git(wt, ['ls-tree', '-z', rev, '--', 'package.json'], { buffer: true, allowFail: true });
  if (ls === null) return { state: 'uninspected', why: `tree ${String(rev).slice(0, 12)} is not readable` };
  const m = /^(\d+) (\w+) ([0-9a-f]+)\tpackage\.json\0?$/.exec(ls.toString('utf8'));
  if (!ls.length) return { state: 'absent' };
  if (!m || m[2] !== 'blob' || m[1] === '120000') return { state: 'uninspected', why: 'not a regular blob' };
  const buf = git(wt, ['cat-file', 'blob', m[3]], { buffer: true, allowFail: true });
  if (buf === null) return { state: 'uninspected', why: 'blob not readable' };
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* reported below */ }
  return { state: 'present', oid: m[3], sha256: sha256(buf), parsed: Boolean(json && typeof json === 'object' && !Array.isArray(json)), json };
}
const brief = (b) => (b.state !== 'present' ? { state: b.state, ...(b.why ? { why: b.why } : {}) } : { state: 'present', oid: b.oid, sha256: b.sha256, parsed: b.parsed, ...(b.parsed ? { name: b.json.name ?? null, version: b.json.version ?? null, dependencies: Object.keys(b.json.dependencies ?? {}).sort(), devDependencies: Object.keys(b.json.devDependencies ?? {}).sort(), scripts: Object.keys(b.json.scripts ?? {}).sort() } : {}) });
export function inspectPackageJson({ run, audit }) {
  const out = { source: 'package.json read from Git objects: audited result_tree and base_commit', binding: bind(run, audit) };
  if (!audit.result_tree) return { ...out, status: 'uninspected', reason: 'the audit recorded no result tree' };
  const wt = run.worktree?.path;
  if (!wt || !existsSync(wt)) return { ...out, status: 'uninspected', reason: 'the audited worktree repository is not available to read Git objects from' };
  const res = blobAt(wt, audit.result_tree); const base = blobAt(wt, run.base_commit);
  out.result = brief(res); out.baseline = brief(base);
  if (res.state === 'uninspected' || base.state === 'uninspected') return { ...out, status: 'uninspected', reason: 'a side could not be read; no conclusion is drawn' };
  if (res.state === 'absent' && base.state === 'absent') return { ...out, status: 'absent', reason: 'package.json exists in neither the baseline nor the audited result' };
  if (res.state === 'present' && base.state === 'present' && res.oid === base.oid) return { ...out, status: 'match', reason: 'identical to the baseline blob' };
  return { ...out, status: 'changed', reason: res.state === 'absent' ? 'removed by the audited result' : base.state === 'absent' ? 'added by the audited result' : 'content differs from the baseline' };
}

// ---- independent validation record: inspected, never assumed ----
const item = (state, detail) => ({ state, ...(detail ? { detail } : {}) });
const V = 'verified'; const M = 'mismatch'; const N = 'not-recorded';
export function inspectValidationBinding({ recordFile, recordSha256, run, audit, contract }) {
  const out = { binding: bind(run, audit), record_file: recordFile ?? null };
  const authorized = contract.validation_commands ?? [];
  if (!authorized.length) return { ...out, status: 'no-validation-authorized', note: 'The task authorizes no validation command, so there is NO independent validation evidence. This is not a pass and not a failure.', items: {} };
  let rec = null; try { rec = JSON.parse(readFileSync(recordFile, 'utf8')); } catch { /* handled */ }
  if (!rec) return { ...out, status: 'not-recorded', note: 'the validation record is missing or unreadable', items: {} };
  const items = {};
  items.record_sha256 = recordSha256 && fileSha(recordFile) === recordSha256 ? item(V) : item(M, 'the record file hash differs from the hash written when it was created');
  items.identity = rec.kind === 'dac-independent-validation' && rec.run_id === run.run_id && rec.task_id === run.task_id && rec.project_id === run.project_id ? item(V) : item(M);
  const want = { audit_hash: audit.audit_hash, content_hash: audit.content_hash, result_tree: audit.result_tree, diff_sha256: audit.diff_sha256, base_commit: run.base_commit };
  items.bound_content = rec.bound ? (Object.keys(want).every((k) => rec.bound[k] === want[k]) ? item(V) : item(M, 'recorded audit_hash/content_hash/result_tree/diff_sha256/base_commit differ from the audited run')) : item(N);
  items.tested_content = rec.workspace?.tree ? (rec.workspace.tree === audit.result_tree && rec.workspace.matches_audit_result_tree === true && rec.workspace.pre_manifest_sha256 && rec.workspace.pre_manifest_file && fileSha(rec.workspace.pre_manifest_file) === rec.workspace.pre_manifest_sha256 ? item(V, 'workspace tree id equals result_tree and its manifest hash re-matches') : item(M, 'the tested copy is not proven identical to result_tree')) : item(N, 'no tested-content manifest recorded');
  items.not_audited_worktree = rec.validation_cwd && rec.validation_cwd !== run.worktree?.path && rec.source_worktree === run.worktree?.path ? item(V) : item(M, 'cwd is not a distinct disposable copy of the audited worktree');
  const cmds = Array.isArray(rec.commands) ? rec.commands : [];
  items.authorized_commands = Array.isArray(rec.authorized_commands) && rec.authorized_commands.length === authorized.length && authorized.every((c, i) => rec.authorized_commands[i] === c) && cmds.length === authorized.length && authorized.every((c, i) => cmds[i]?.command === c) ? item(V) : item(M, 'executed commands are not exactly the authorized ones, in order');
  items.commands = authorized.map((c, i) => {
    const e = cmds[i];
    if (!e) return { command: c, state: N };
    const streams = ['stdout', 'stderr'].map((s) => { const f = e[s]; if (!f?.sha256) return [s, N]; return [s, f.file && fileSha(f.file) === f.sha256 ? V : (f.file ? M : 'hash-only')]; });
    const s = Object.fromEntries(streams);
    const exitOk = e.exit_code === 0 && !e.signal && !e.error;
    const cwdOk = typeof e.cwd === 'string' && e.cwd === rec.validation_cwd;
    const complete = e.exit_code !== undefined && e.cwd && s.stdout !== N && s.stderr !== N;
    return { command: c, state: !complete ? N : exitOk && cwdOk && s.stdout !== M && s.stderr !== M ? V : M, cwd: e.cwd ?? null, cwd_is_tested_workspace: cwdOk, exit_code: e.exit_code ?? null, signal: e.signal ?? null, stdout_sha256: e.stdout?.sha256 ?? null, stderr_sha256: e.stderr?.sha256 ?? null, stdout_hash_rechecked: s.stdout, stderr_hash_rechecked: s.stderr };
  });
  items.completeness = rec.overall === 'PASS' && rec.complete === true && rec.commands_not_run === 0 && rec.binding_after === 'equal' ? item(V) : item(M, 'record is not a complete PASS with an equal binding afterwards');
  const states = [...Object.entries(items).filter(([k]) => k !== 'commands').map(([, v]) => v.state), ...items.commands.map((c) => c.state)];
  const status = states.every((x) => x === V) ? 'verified-bound' : states.includes(M) ? 'mismatch' : 'not-recorded-in-part';
  return { ...out, status, items, note: status === 'verified-bound' ? 'Every item was re-read from the preserved record and matches. This covers ONLY the authorized commands, run by dac in a copy equal to result_tree.' : 'Do NOT infer a pass from the absence of a blocker; at least one item is not verified.' };
}

// ---- the matrix ----
const KW = { package: /package|dependenc|metadata|manifest|lockfile/i, scope: /scope|network|install|restrict|git write|sandbox|allowed|prohibit|outside/i };
export function classifyCriterion(text) {
  const id = /^([^:]+):/.exec(text)?.[1]?.trim() ?? text;
  const kind = /package/i.test(id) ? 'package' : /scope/i.test(id) ? 'scope' : KW.package.test(text) ? 'package' : KW.scope.test(text) ? 'scope' : 'general';
  return { id, kind };
}
const row = (criterion, needed_evidence, source, run_binding, status, extra = {}) => ({ criterion, needed_evidence, source, run_binding, status, ...extra });

export function buildEvidenceMatrix({ contract, run, audit, metadata, packageJson, validationBinding, profile }) {
  const rb = bind(run, audit);
  const rows = [];
  const diffRow = (id) => row(id, 'the exact audited diff and per-file changes', 'diff.patch + audit.json (immutable run files)', rb, 'available');
  const vb = validationBinding;
  const valStatus = vb.status === 'verified-bound' ? 'available' : vb.status === 'no-validation-authorized' || vb.status === 'not-recorded' ? 'not-recorded' : 'recoverable';
  for (const text of contract.acceptance_criteria) {
    const { id, kind } = classifyCriterion(text);
    if (kind === 'package') {
      const cmp = comparePackageName(metadata, packageJson);
      const determinate = (cmp.result === 'match' || cmp.result === 'mismatch') && (packageJson.status === 'match' || packageJson.status === 'changed');
      const neverCaptured = metadata.status === 'absent' || cmp.reason === 'the audited result has no package.json';
      rows.push(row(id, 'baseline-bound managed package_name (ORIGINAL .dac/project.json) vs audited result package.json name, plus whether package.json changed vs baseline', `${metadata.source}; ${packageJson.source}`, rb, determinate ? 'available' : neverCaptured ? 'not-recorded' : 'recoverable',
        { package_name_comparison: cmp, metadata_status: metadata.status, baseline_status: metadata.baseline ?? 'unknown', package_json_change: packageJson.status, rule: 'The semantic comparison (package_name vs package.json name) and the baseline/change facts are separate. absent, uninspected, drift and not-comparable are NOT a match and NOT a pass; judge the criterion only on what is determinate and mark it UNVERIFIED otherwise.' }));
      rows.push(row(`${id} (validation)`, 'independent validation of the authorized commands against result_tree', 'validation/attempt-N/record.json', rb, valStatus, { validation_binding: vb.status }));
    } else if (kind === 'scope') {
      rows.push(row(id, 'configured controls vs observed actions vs effectively verified restrictions', 'run.json runner profile; audit.json; implementer transcripts', rb, 'recoverable', {
        configured_controls: { status: 'available', note: 'declared profile and contract constraints; declaration is not enforcement', implementer: { sandbox: run.runner?.profile?.sandbox ?? null, approval: run.runner?.profile?.approval ?? null, network: run.runner?.profile?.network ?? null, mcp: run.runner?.profile?.mcp ?? null, verified_against_real_binary: run.runner?.profile?.verified_against_real_binary ?? false }, reviewer: { sandbox: profile?.sandbox ?? null, network: profile?.network ?? null } },
        observed_actions: { status: 'available', note: 'what the post-run audit inspected: final file content, Git state and original project; NOT commands or network', audit_status: audit.status, changed_files: audit.totals?.files ?? null },
        effectively_verified: { status: 'available', verified: ['changes are inside the authorized paths (audit PASS bound to audit_hash)'], not_verified: ['implementer network use', 'implementer package installs or other commands', 'whether the declared implementer sandbox was enforced'] },
        not_recorded: ['implementer command log', 'implementer network activity', 'enforcement proof for the declared sandbox'],
        rule: 'Where required historical evidence is not recorded the criterion stays UNVERIFIED and the overall validation_result must be BLOCKED; it is never upgraded to PASS and never retroactively changed. dac exposes only what already exists.' }));
    } else rows.push(row(id, 'the exact audited diff, plus independent validation if the criterion is behavioural', 'diff.patch, audit.json; validation record', rb, valStatus === 'available' ? 'available' : 'recoverable', { validation_binding: vb.status, diff: diffRow(id).status }));
  }
  return rows;
}

export function criterionEvidence({ root, run, audit, contract, validation, profile }) {
  const metadata = inspectManagedMetadata({ root, run, audit });
  const packageJson = inspectPackageJson({ run, audit });
  const validationBinding = inspectValidationBinding({ recordFile: validation?.record_file, recordSha256: validation?.record_sha256, run, audit, contract });
  return canonicalize({ evidence_class: 'criterion evidence matrix (derived read-only from existing preserved evidence; not a new evidence record)', binding: bind(run, audit), managed_metadata: metadata, package_json: packageJson, validation_binding: validationBinding, matrix: buildEvidenceMatrix({ contract, run, audit, metadata, packageJson, validationBinding, profile }) });
}
