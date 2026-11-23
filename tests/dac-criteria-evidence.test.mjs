// Criterion -> evidence matrix, managed-metadata delivery (ORIGINAL project) and package.json (audited result vs baseline), and the
// inspection of independent-validation records. Disposable projects and simulated runners only: no Codex/Cursor is executed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './support/run-harness.mjs';
import { makeProject, impl, review, runs, reviewRunner, validationSim, implRunner, SCAFFOLD, ok, write } from './support/run-harness.mjs';
import { mainFingerprint } from '../adapters/shared/sdd-run/git.mjs';
import { comparePackageName, inspectManagedMetadata, inspectPackageJson, inspectValidationBinding, buildEvidenceMatrix, classifyCriterion } from '../adapters/shared/sdd-run/criteria-evidence.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });

async function ready(extra = {}) {
  const root = makeProject();
  const r = await impl(root, { runner: implRunner(extra.effect ?? SCAFFOLD, ok()) });
  assert.equal(r.code, 0, r.out);
  const [run] = runs(root, r.st);
  return { root, st: r.st, run: run.run, audit: run.audit, dir: run.dir };
}
const STD = '.dac/standard.json';

const PRJ = '.dac/project.json';
const BIND = (run, audit) => ({ run_id: run.run_id, base_commit: run.base_commit, result_tree: audit.result_tree, audit_hash: audit.audit_hash });

test('metadata: original .dac/project.json is baseline-bound when mainFingerprint equals run.pre.main; package_name read unmodified', async () => {
  const { root, run, audit } = await ready();
  const before = readFileSync(join(root, PRJ), 'utf8'); const std = readFileSync(join(root, STD), 'utf8');
  const m = inspectManagedMetadata({ root, run, audit });
  assert.equal(m.status, 'baseline-bound', JSON.stringify(m)); assert.equal(m.package_name, 'demo-pkg'); assert.equal(m.baseline, 'unchanged-from-baseline');
  assert.deepEqual(m.binding, BIND(run, audit)); assert.equal(m.baseline_fingerprint, run.pre.main);
  assert.match(m.source, /\.dac\/project\.json/);
  assert.equal(readFileSync(join(root, PRJ), 'utf8'), before); assert.equal(readFileSync(join(root, STD), 'utf8'), std);
});

test('metadata: drift (changed original project) is reported as drift, not guessed; standard.json drift is not the source', async () => {
  const { root, run, audit } = await ready();
  writeFileSync(join(root, PRJ), JSON.stringify({ schema: 1, package_name: 'changed' }, null, 2) + '\n');
  const m = inspectManagedMetadata({ root, run, audit });
  assert.equal(m.status, 'drift'); assert.equal(m.package_name, undefined); assert.match(m.reason, /not determined/);
  const cmp = comparePackageName(m, inspectPackageJson({ run, audit }));
  assert.equal(cmp.result, 'not-comparable'); assert.match(cmp.reason, /drift/);
  // another original-project change (not project.json) also reports drift for the whole baseline binding
  const b = await ready(); writeFileSync(join(b.root, 'stray.txt'), 'x');
  assert.equal(inspectManagedMetadata({ root: b.root, run: b.run, audit: b.audit }).status, 'drift');
});

test('metadata: absent, unreadable/uninspected, no baseline, malformed are distinct and never a match', async () => {
  const { root, run, audit } = await ready();
  const f = join(root, PRJ); const keep = readFileSync(f);
  rmSync(f); assert.equal(inspectManagedMetadata({ root, run, audit }).status, 'absent');
  mkdirSync(f); assert.equal(inspectManagedMetadata({ root, run, audit }).status, 'uninspected'); // not a regular file: never read
  rmSync(f, { recursive: true }); writeFileSync(f, keep);
  assert.equal(inspectManagedMetadata({ root, run: { ...run, pre: {} }, audit }).status, 'uninspected'); // no baseline recorded
  assert.equal(inspectManagedMetadata({ root, run, audit }).status, 'baseline-bound');
  // malformed / non-exact shapes: use a run whose baseline equals the current state so only the shape is at issue
  for (const bad of ['junk', '{"schema":1,"package_name":"a","project_id":"P"}', '{"schema":2,"package_name":"a"}', '{"schema":1,"package_name":7}', '[]']) {
    const x = await ready(); writeFileSync(join(x.root, PRJ), bad);
    const fixed = { ...x.run, pre: { ...x.run.pre, main: mainFingerprint(x.root) } };
    const m = inspectManagedMetadata({ root: x.root, run: fixed, audit: x.audit });
    assert.equal(m.status, 'uninspected', bad); assert.equal(m.package_name, undefined);
  }
});

test('mainFingerprint covers .dac/project.json content and presence: content change, creation and deletion break baseline binding', async () => {
  const bound = (x, main) => inspectManagedMetadata({ root: x.root, run: { ...x.run, pre: { ...x.run.pre, main } }, audit: x.audit });
  // 1) present baseline; only package_name changes
  const a = await ready(); const baseA = mainFingerprint(a.root);
  assert.equal(bound(a, baseA).status, 'baseline-bound');
  writeFileSync(join(a.root, PRJ), JSON.stringify({ schema: 1, package_name: 'other-pkg' }, null, 2) + '\n');
  assert.notEqual(mainFingerprint(a.root), baseA);
  const mA = bound(a, baseA); assert.notEqual(mA.status, 'baseline-bound'); assert.equal(mA.package_name, undefined);
  // 2) absent baseline; creating the file
  const b = await ready(); rmSync(join(b.root, PRJ)); const baseB = mainFingerprint(b.root);
  writeFileSync(join(b.root, PRJ), JSON.stringify({ schema: 1, package_name: 'demo-pkg' }, null, 2) + '\n');
  assert.notEqual(mainFingerprint(b.root), baseB);
  const mB = bound(b, baseB); assert.notEqual(mB.status, 'baseline-bound'); assert.equal(mB.package_name, undefined);
  // 3) present baseline; deleting the file
  const c = await ready(); const baseC = mainFingerprint(c.root);
  rmSync(join(c.root, PRJ));
  assert.notEqual(mainFingerprint(c.root), baseC);
  const mC = bound(c, baseC); assert.notEqual(mC.status, 'baseline-bound'); assert.equal(mC.package_name, undefined);
});

test('package_name vs package.json name: match', async () => {
  const root = makeProject({ files: { 'README.md': '# demo\n', 'package.json': '{"name":"demo-pkg","version":"1.0.0"}\n' } });
  const r = await impl(root, { runner: implRunner((cwd) => write(cwd, 'src/index.js', 'export const x = 1;\n'), ok(['src/index.js'])) });
  assert.equal(r.code, 0, r.out);
  const [x] = runs(root, r.st);
  const m = inspectManagedMetadata({ root, run: x.run, audit: x.audit }); const p = inspectPackageJson({ run: x.run, audit: x.audit });
  assert.equal(p.status, 'match'); // package.json unchanged vs baseline
  const c = comparePackageName(m, p); assert.equal(c.result, 'match'); assert.equal(c.package_name, 'demo-pkg'); assert.equal(c.package_json_name, 'demo-pkg');
  const contract = { acceptance_criteria: ['ac-package: package metadata is delivered'], validation_commands: [] };
  const [row] = buildEvidenceMatrix({ contract, run: x.run, audit: x.audit, metadata: m, packageJson: p, validationBinding: inspectValidationBinding({ run: x.run, audit: x.audit, contract }) });
  assert.equal(row.status, 'available'); assert.equal(row.package_name_comparison.result, 'match'); assert.equal(row.package_json_change, 'match'); assert.equal(row.baseline_status, 'unchanged-from-baseline');
  assert.deepEqual(row.run_binding, BIND(x.run, x.audit));
});

test('package_name vs package.json name: mismatch, with package.json changed by the result (separate fact)', async () => {
  const { root, run, audit } = await ready(); // SCAFFOLD adds package.json named "demo"; package_name is demo-pkg
  const m = inspectManagedMetadata({ root, run, audit }); const p = inspectPackageJson({ run, audit });
  const c = comparePackageName(m, p);
  assert.equal(c.result, 'mismatch'); assert.equal(c.package_name, 'demo-pkg'); assert.equal(c.package_json_name, 'demo'); assert.equal(p.status, 'changed');
  const contract = { acceptance_criteria: ['ac-package: x'], validation_commands: [] };
  const [row] = buildEvidenceMatrix({ contract, run, audit, metadata: m, packageJson: p, validationBinding: inspectValidationBinding({ run, audit, contract }) });
  assert.equal(row.status, 'available'); assert.equal(row.package_name_comparison.result, 'mismatch'); assert.equal(row.package_json_change, 'changed'); assert.equal(row.metadata_status, 'baseline-bound');
});

test('ac-package row: metadata absent / package absent / drift / malformed are not available and never a comparison', async () => {
  const contract = { acceptance_criteria: ['ac-package: x'], validation_commands: [] };
  const rowOf = (x, metadata, packageJson) => buildEvidenceMatrix({ contract, run: x.run, audit: x.audit, metadata, packageJson, validationBinding: inspectValidationBinding({ run: x.run, audit: x.audit, contract }) })[0];
  const a = await ready();
  const pj = inspectPackageJson({ run: a.run, audit: a.audit });
  // metadata absent
  rmSync(join(a.root, PRJ)); const mAbs = inspectManagedMetadata({ root: a.root, run: a.run, audit: a.audit });
  let r = rowOf(a, mAbs, pj); assert.equal(mAbs.status, 'absent'); assert.equal(r.status, 'not-recorded'); assert.equal(r.package_name_comparison.result, 'not-comparable');
  // package absent (result has none)
  const b = await ready({ effect: (cwd) => write(cwd, 'src/index.js', 'export const x = 1;\n') });
  const pAbs = inspectPackageJson({ run: b.run, audit: b.audit }); assert.equal(pAbs.status, 'absent');
  const mB = inspectManagedMetadata({ root: b.root, run: b.run, audit: b.audit }); assert.equal(mB.status, 'baseline-bound');
  r = rowOf(b, mB, pAbs); assert.equal(r.status, 'not-recorded'); assert.match(r.package_name_comparison.reason, /no package\.json/);
  // drift -> recoverable
  const c = await ready(); writeFileSync(join(c.root, PRJ), '{"schema":1,"package_name":"z"}\n');
  const mC = inspectManagedMetadata({ root: c.root, run: c.run, audit: c.audit });
  r = rowOf(c, mC, inspectPackageJson({ run: c.run, audit: c.audit })); assert.equal(mC.status, 'drift'); assert.equal(r.status, 'recoverable'); assert.equal(r.baseline_status, 'drift');
  // package.json invalid in the audited result / unreadable tree
  const d = await ready({ effect: (cwd) => { write(cwd, 'package.json', '{not json'); } });
  const pBad = inspectPackageJson({ run: d.run, audit: d.audit });
  if (pBad.status !== 'uninspected') { assert.equal(pBad.result.parsed, false); }
  const mD = inspectManagedMetadata({ root: d.root, run: d.run, audit: d.audit });
  assert.equal(comparePackageName(mD, pBad).result, 'not-comparable'); r = rowOf(d, mD, pBad); assert.equal(r.status, 'recoverable');
  const pUn = inspectPackageJson({ run: d.run, audit: { ...d.audit, result_tree: 'f'.repeat(40) } });
  assert.equal(pUn.status, 'uninspected'); r = rowOf(d, mD, pUn); assert.equal(r.status, 'recoverable');
  // name missing in a valid package.json
  const e = await ready({ effect: (cwd) => { write(cwd, 'package.json', '{"version":"1.0.0"}\n'); } });
  assert.equal(comparePackageName(inspectManagedMetadata({ root: e.root, run: e.run, audit: e.audit }), inspectPackageJson({ run: e.run, audit: e.audit })).result, 'not-comparable');
});

test('package.json is read from the exact audited result tree and base commit: changed / match / absent / uninspected', async () => {
  const a = await ready(); // SCAFFOLD adds package.json
  const p = inspectPackageJson({ run: a.run, audit: a.audit });
  assert.equal(p.status, 'changed'); assert.equal(p.baseline.state, 'absent'); assert.equal(p.result.state, 'present'); assert.equal(p.result.name, 'demo');
  assert.equal(p.binding.result_tree, a.audit.result_tree);
  const b = await ready({ effect: (cwd) => write(cwd, 'src/index.js', 'export const x = 1;\n') });
  assert.equal(inspectPackageJson({ run: b.run, audit: b.audit }).status, 'absent'); // in neither baseline nor result
  const c = await ready();
  assert.equal(inspectPackageJson({ run: c.run, audit: { ...c.audit, result_tree: 'f'.repeat(40) } }).status, 'uninspected'); // unreadable tree: no conclusion
  assert.equal(inspectPackageJson({ run: c.run, audit: { ...c.audit, result_tree: null } }).status, 'uninspected');
  assert.equal(inspectPackageJson({ run: { ...c.run, worktree: { path: join(c.dir, 'gone') } }, audit: c.audit }).status, 'uninspected');
  // identical to the baseline: match (use the base tree as the "result")
  const baseTree = H.git(c.root, 'rev-parse', `${c.run.base_commit}^{tree}`).trim();
  assert.equal(inspectPackageJson({ run: c.run, audit: { ...c.audit, result_tree: baseTree } }).status, 'absent');
});

test('package.json match: a result that leaves an existing package.json untouched', async () => {
  const root = makeProject({ files: { 'README.md': '# demo\n', 'package.json': '{"name":"demo","version":"1.0.0"}\n' } });
  const r = await impl(root, { runner: implRunner((cwd) => write(cwd, 'src/index.js', 'export const x = 1;\n'), ok(['src/index.js'])) });
  assert.equal(r.code, 0, r.out);
  const [x] = runs(root, r.st);
  const p = inspectPackageJson({ run: x.run, audit: x.audit });
  assert.equal(p.status, 'match'); assert.equal(p.result.version, '1.0.0');
});

test('integration: the reviewer prompt carries the matrix with bound metadata and package.json statuses; run files and hashes are unchanged', async () => {
  const { root, st, run, audit, dir } = await ready();
  const names = ['run.json', 'authorization.json', 'audit.json', 'diff.patch', 'outcome.json'];
  const sums = () => Object.fromEntries(names.map((n) => [n, H.sha(readFileSync(join(dir, n)))]));
  const before = sums(); const std = readFileSync(join(root, STD), 'utf8');
  const rv = reviewRunner();
  const r = await review(root, st, { runner: rv, validator: validationSim() });
  assert.equal(r.code, 0, r.out);
  const p = rv.calls[0].prompt;
  assert.ok(p.includes('5. Criterion -> evidence matrix'));
  assert.ok(p.includes('"status": "baseline-bound"') && p.includes('.dac/project.json') && p.includes('"package_name": "demo-pkg"'));
  for (const x of [run.run_id, run.base_commit, audit.result_tree, audit.audit_hash]) assert.ok(p.includes(x), x);
  assert.deepEqual(sums(), before); assert.equal(readFileSync(join(root, STD), 'utf8'), std);
  assert.equal(runs(root, st)[0].audit.audit_hash, audit.audit_hash);
});

test('matrix: ac-package and ac-scope rows; unverified items stay unverified, nothing is upgraded', async () => {
  const { root, run, audit } = await ready();
  const contract = { acceptance_criteria: ['ac-package: package metadata is delivered (verification: inspect)', 'ac-scope: the run stayed in scope and used no network (verification: review)', 'ac-1: greet works (verification: unit test)'], validation_commands: [] };
  assert.deepEqual(classifyCriterion(contract.acceptance_criteria[0]), { id: 'ac-package', kind: 'package' });
  assert.equal(classifyCriterion(contract.acceptance_criteria[1]).kind, 'scope');
  const metadata = inspectManagedMetadata({ root, run, audit }); const packageJson = inspectPackageJson({ run, audit });
  const vb = inspectValidationBinding({ run, audit, contract });
  assert.equal(vb.status, 'no-validation-authorized'); assert.match(vb.note, /not a pass/);
  const rows = buildEvidenceMatrix({ contract, run, audit, metadata, packageJson, validationBinding: vb, profile: { sandbox: 'read-only', network: false } });
  const pk = rows.find((x) => x.criterion === 'ac-package'); const sc = rows.find((x) => x.criterion === 'ac-scope'); const pv = rows.find((x) => x.criterion === 'ac-package (validation)');
  assert.equal(pk.status, 'available'); assert.equal(pk.package_name_comparison.result, 'mismatch'); assert.equal(pk.metadata_status, 'baseline-bound'); assert.equal(pk.package_json_change, 'changed');
  assert.equal(pv.status, 'not-recorded');
  assert.equal(sc.status, 'recoverable'); assert.ok(sc.configured_controls && sc.observed_actions && sc.effectively_verified && sc.not_recorded.length);
  assert.ok(sc.effectively_verified.not_verified.some((s) => /network/.test(s))); assert.match(sc.rule, /UNVERIFIED/); assert.match(sc.rule, /BLOCKED/);
  assert.ok(sc.run_binding.audit_hash === audit.audit_hash && sc.run_binding.result_tree === audit.result_tree);
  // an uninspected metadata source makes ac-package recoverable, never available
  const rows2 = buildEvidenceMatrix({ contract, run, audit, metadata: { status: 'uninspected', source: 'x' }, packageJson, validationBinding: vb });
  assert.equal(rows2.find((x) => x.criterion === 'ac-package').status, 'recoverable');
});

// ---- independent validation binding ----
async function withValidation(commands = ['node --test']) {
  const root = makeProject({ persistDocs: false });
  const { persist, projectDoc, task } = H;
  persist(root, { project: projectDoc({ tasks: [task({ validation_commands: commands }), task({ id: 't-feature', title: 'Add the feature', paths: ['src', 'test'], depends_on: ['t-scaffold'], validation_commands: [] })] }) });
  const i = await impl(root, { runner: implRunner(SCAFFOLD, ok()) }); assert.equal(i.code, 0, i.out);
  const rv = reviewRunner(); const r = await review(root, i.st, { runner: rv, validator: validationSim() }); assert.equal(r.code, 0, r.out);
  const [x] = runs(root, i.st); const attempt = join(x.dir, 'validation', 'attempt-1');
  const rec = JSON.parse(readFileSync(join(attempt, 'record.json'), 'utf8'));
  const contract = { validation_commands: commands };
  const inspect = (over = {}) => inspectValidationBinding({ recordFile: join(attempt, 'record.json'), recordSha256: H.sha(readFileSync(join(attempt, 'record.json'))), run: x.run, audit: x.audit, contract, ...over });
  return { x, rec, attempt, inspect, rv };
}

test('independent validation: every item re-read and bound (command, cwd, exit, stdout/stderr hashes, tested tree); prompt carries it', async () => {
  const { x, rec, inspect, rv } = await withValidation();
  const v = inspect();
  assert.equal(v.status, 'verified-bound', JSON.stringify(v.items));
  const c = v.items.commands[0];
  assert.equal(c.command, 'node --test'); assert.equal(c.exit_code, 0); assert.equal(c.cwd, rec.validation_cwd); assert.notEqual(c.cwd, x.run.worktree.path);
  assert.equal(c.stdout_hash_rechecked, 'verified'); assert.equal(c.stderr_hash_rechecked, 'verified');
  assert.equal(v.items.tested_content.state, 'verified'); assert.equal(rec.workspace.tree, x.audit.result_tree);
  const p = rv.calls[0].prompt; assert.ok(p.includes('"status": "verified-bound"'));
});

test('independent validation: tampering, a different binding, a wrong command or a missing record is never a pass', async () => {
  const { x, attempt, inspect } = await withValidation();
  // binding to another audit
  assert.equal(inspect({ audit: { ...x.audit, audit_hash: 'e'.repeat(64) } }).status, 'mismatch');
  assert.equal(inspect({ audit: { ...x.audit, result_tree: 'd'.repeat(40) } }).items.bound_content.state, 'mismatch');
  // commands differ from the authorized list
  assert.equal(inspect({ contract: { validation_commands: ['node --check'] } }).items.authorized_commands.state, 'mismatch');
  // different record hash than recorded at creation
  assert.equal(inspect({ recordSha256: '0'.repeat(64) }).items.record_sha256.state, 'mismatch');
  // missing record / unreadable
  assert.equal(inspect({ recordFile: join(attempt, 'nope.json') }).status, 'not-recorded');
  assert.equal(inspect({ recordFile: undefined }).status, 'not-recorded');
  // tampered stdout is detected via the recorded hash
  const out = join(attempt, 'cmd-1.stdout.txt'); const keep = readFileSync(out);
  try { writeFileSync(out, 'tampered'); assert.equal(inspect().items.commands[0].state, 'mismatch'); } finally { writeFileSync(out, keep); }
  assert.equal(inspect().status, 'verified-bound');
});

test('independent validation: missing output hashes or exit codes are "not recorded", not a pass', async () => {
  const { x, attempt, rec, inspect } = await withValidation();
  const f = join(attempt, 'record.json'); const copy = join(attempt, 'record.copy.json');
  const strip = (mut) => { const r = JSON.parse(JSON.stringify(rec)); mut(r); writeFileSync(copy, JSON.stringify(r)); return inspectValidationBinding({ recordFile: copy, recordSha256: H.sha(readFileSync(copy)), run: x.run, audit: x.audit, contract: { validation_commands: ['node --test'] } }); };
  const a = strip((r) => { delete r.commands[0].stdout.sha256; });
  assert.notEqual(a.status, 'verified-bound'); assert.equal(a.items.commands[0].state, 'not-recorded');
  const b = strip((r) => { delete r.commands[0].exit_code; });
  assert.notEqual(b.status, 'verified-bound');
  const c = strip((r) => { delete r.workspace.tree; });
  assert.equal(c.items.tested_content.state, 'not-recorded'); assert.notEqual(c.status, 'verified-bound');
  const d = strip((r) => { r.commands[0].exit_code = 1; });
  assert.equal(d.items.commands[0].state, 'mismatch'); assert.equal(d.status, 'mismatch');
  void f;
});
