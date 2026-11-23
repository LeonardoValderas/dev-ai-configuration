// Disposable validation workspace for `dac review`: independent validation never runs in the audited worktree; it runs in an exact,
// safe, standalone copy bound to audit.result_tree. Everything is simulated (no project script, Codex or Cursor is executed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync, linkSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as H from './support/run-harness.mjs';
import { makeProject, persist, projectDoc, task, impl, review, runs, reviewRunner, validationSim, implRunner, SCAFFOLD, ok, write } from './support/run-harness.mjs';
import { manifestOf } from '../adapters/shared/sdd-run/audit.mjs';
import { runIndependentValidation, materializeCopy, INFRA_DIRS } from '../adapters/shared/sdd-run/validation.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });

async function ready(commands) {
  const root = makeProject({ persistDocs: !commands });
  if (commands) persist(root, { project: projectDoc({ tasks: [task({ validation_commands: commands }), task({ id: 't-feature', title: 'Add the feature', paths: ['src', 'test'], depends_on: ['t-scaffold'], validation_commands: [] })] }) });
  const r = await impl(root, { runner: implRunner(SCAFFOLD, ok()) });
  assert.equal(r.code, 0, r.out);
  const [run] = runs(root, r.st);
  return { root, st: r.st, run };
}
const sha = (f) => H.sha(readFileSync(f));
const wsOf = (run, n = 1) => join(run.dir, 'validation', `attempt-${n}`, 'workspace');
const recOf = (run, n = 1) => JSON.parse(readFileSync(join(run.dir, 'validation', `attempt-${n}`, 'record.json'), 'utf8'));
const fmt = (run) => run.run.object_format ?? 'sha1';
const buildSim = () => validationSim((argv, c) => { write(c.cwd, 'dist/index.js', 'built\n'); write(c.cwd, 'coverage/lcov.info', 'cov\n'); write(c.cwd, 'src/index.js', 'export const greet = () => "mutated by build";\n'); rmSync(join(c.cwd, 'package.json'), { force: true }); return {}; });

test('npm test/build byproducts (dist, coverage, edits, deletes) land in the disposable copy: the review proceeds, the audited worktree stays byte-identical, byproducts are recorded separately', async () => {
  const { root, st, run } = await ready(['npm test', 'npm run build']);
  const wt = run.run.worktree.path; const tree = H.snapshot(wt, []); const head = H.git(wt, 'rev-parse', 'HEAD');
  const rv = reviewRunner(); const v = buildSim();
  const r = await review(root, st, { runner: rv, validator: v });
  assert.equal(r.code, 0, r.out); assert.equal(rv.calls.length, 1);
  assert.deepEqual(H.snapshot(wt, []), tree, 'the audited worktree is byte-identical'); assert.equal(H.git(wt, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(wt, 'dist')), false); assert.equal(existsSync(join(wt, 'coverage')), false);
  assert.ok(v.calls.length === 2 && v.calls.every((c) => c.cwd === wsOf(run)), 'commands ran in the copy');
  const rec = recOf(run); assert.equal(rec.overall, 'PASS'); assert.equal(rec.workspace_outputs.counts.generated, 4, 'dist, coverage and their files');
  const out = JSON.parse(readFileSync(rec.workspace_outputs.file, 'utf8'));
  assert.deepEqual(out.generated.map((e) => `${e.type}:${e.path}`).sort(), ['dir:coverage', 'dir:dist', 'file:coverage/lcov.info', 'file:dist/index.js']);
  assert.ok(out.generated.filter((e) => e.type === 'file').every((e) => e.sha256 && e.mode));
  assert.deepEqual(out.modified.map((e) => e.path), ['src/index.js']); assert.deepEqual(out.deleted.map((e) => e.path), ['package.json']);
  assert.equal(rec.commands[0].workspace_outputs.counts.generated, 4);
  assert.ok(rv.calls[0].prompt.includes('NOT product changes') && rv.calls[0].prompt.includes('coverage/lcov.info'));
  assert.ok(readFileSync(rec.workspace.pre_manifest_file, 'utf8').includes(run.audit.result_tree));
  // disposable: removed after the evidence was recorded; manifest and outputs stay
  assert.equal(existsSync(wsOf(run)), false); assert.ok(existsSync(rec.workspace.pre_manifest_file));
  assert.equal(JSON.parse(readFileSync(join(run.dir, 'validation', 'attempt-1', 'cleanup.json'), 'utf8')).status, 'removed');
  assert.equal(runs(root, st)[0].reviews[0].verdict, 'PASS');
});

test('DAC validation infrastructure (private HOME/TMPDIR/cache) is recorded separately from command byproducts', async () => {
  const { root, st, run } = await ready();
  const v = validationSim((argv, c) => { write(c.cwd, join(INFRA_DIRS.home, '.npm-state'), 'h\n'); write(c.cwd, join(INFRA_DIRS.tmp, 'x'), 't\n'); write(c.cwd, 'dist/a.js', 'a\n'); return {}; });
  const r = await review(root, st, { runner: reviewRunner(), validator: v }); assert.equal(r.code, 0, r.out);
  const rec = recOf(run); const out = JSON.parse(readFileSync(rec.workspace_outputs.file, 'utf8'));
  assert.deepEqual(out.generated.map((e) => e.path).sort(), ['dist', 'dist/a.js'], 'command byproducts exclude infrastructure');
  assert.ok(out.dac_infrastructure.note.includes('NOT command or product output')); assert.ok(out.dac_infrastructure.counts.generated >= 2);
  assert.ok(rec.workspace_outputs.dac_infrastructure.counts.generated >= 2);
  assert.equal(rec.commands[0].workspace_outputs.dac_infrastructure_counts.generated >= 2, true);
});

test('a validation runner that mutates the ORIGINAL audited worktree still blocks; dac never repairs or deletes in the worktree', async () => {
  const { root, st, run } = await ready(); const wt = run.run.worktree.path; const rv = reviewRunner();
  const r = await review(root, st, { runner: rv, validator: validationSim(() => { write(wt, 'dist/leak.js', 'x\n'); return {}; }) });
  assert.equal(r.code, 1); assert.equal(rv.calls.length, 0); assert.match(r.out, /state drift after the validation commands/);
  assert.equal(runs(root, st)[0].reviews[0].verdict, 'BLOCKED'); assert.ok(existsSync(join(wt, 'dist', 'leak.js')));
});

test('copy binding fails closed: result_tree mismatch, symlink, hardlink and special file in the source; no command runs and no workspace remains', async () => {
  const direct = async (mutate, auditPatch = {}) => {
    const { run } = await ready(); mutate(run.run.worktree.path);
    const authz = JSON.parse(readFileSync(join(run.dir, 'authorization.json'), 'utf8')); const v = validationSim();
    const res = await runIndependentValidation({ root: '/unused', run: run.run, contract: { validation_commands: authz.validation_commands }, audit: { ...run.audit, ...auditPatch }, runDir: run.dir, runner: v, clock: Date.now, checkBinding: () => [] });
    assert.equal(res.ok, false); assert.equal(v.calls.length, 0, 'no command may run'); assert.equal(existsSync(wsOf(run)), false);
    return res.reasons.join();
  };
  assert.match(await direct(() => {}, { result_tree: 'a'.repeat(40) }), /does not reproduce audit\.result_tree/);
  assert.match(await direct((wt) => symlinkSync('/etc/hosts', join(wt, 'link'))), /symlink/);
  assert.match(await direct((wt) => linkSync(join(wt, 'package.json'), join(wt, 'hard.json'))), /hardlink/);
  assert.match(await direct((wt) => execFileSync('mkfifo', [join(wt, 'pipe')])), /special-file/);
  // a source that changes between the manifest and the copy is refused by the per-file blob check; path escape is refused
  const { run } = await ready(); const entries = manifestOf(run.run.worktree.path, fmt(run)).entries;
  write(run.run.worktree.path, 'package.json', 'changed\n');
  assert.throws(() => materializeCopy(run.run.worktree.path, join(H.scratch, 'copy-x'), entries, fmt(run)), /source changed while copying/);
  assert.throws(() => materializeCopy(run.run.worktree.path, join(H.scratch, 'copy-y'), [{ path: '../evil', type: 'file', mode: '100644', oid: '0' }], 'sha1'), /unsafe entry/);
  assert.equal(existsSync(join(H.scratch, 'evil')), false);
});

test('the workspace is a standalone, exact, safe content copy: no .git, tree id equals audit.result_tree, safe modes', async () => {
  const { root, st, run } = await ready(); let seen = null;
  const v = validationSim((argv, c) => { const m = manifestOf(c.cwd, fmt(run)); seen = { tree: m.tree, git: existsSync(join(c.cwd, '.git')), problems: m.problems, modes: readdirSync(c.cwd).map((n) => statSync(join(c.cwd, n)).mode & 0o7777) }; return {}; });
  const r = await review(root, st, { runner: reviewRunner(), validator: v }); assert.equal(r.code, 0, r.out);
  assert.equal(seen.tree, run.audit.result_tree); assert.equal(seen.git, false); assert.deepEqual(seen.problems, []); assert.ok(seen.modes.every((m) => (m & 0o7022) === 0));
});

test('retry preserves earlier evidence; each attempt cleans only its own workspace and never touches another attempt directory', async () => {
  const { root, st, run } = await ready();
  await review(root, st, { runner: reviewRunner(), validator: validationSim((a, c) => { write(c.cwd, 'dist/a.js', 'a\n'); return { status: 2 }; }) });
  const firstOut = sha(join(run.dir, 'validation', 'attempt-1', 'cmd-1.outputs.json')); const firstRec = sha(join(run.dir, 'validation', 'attempt-1', 'record.json'));
  assert.equal(existsSync(wsOf(run, 1)), false, 'attempt 1 cleaned its own workspace after recording');
  // a foreign directory planted where attempt-2 would live is skipped (attempt dirs are exclusive) and stays untouched
  mkdirSync(join(run.dir, 'validation', 'attempt-2', 'workspace'), { recursive: true }); writeFileSync(join(run.dir, 'validation', 'attempt-2', 'workspace', 'keep.txt'), 'keep');
  const r = await review(root, st, { runner: reviewRunner(), validator: validationSim((a, c) => { write(c.cwd, 'coverage/b.info', 'b\n'); return {}; }) });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(run.dir, 'validation', 'attempt-2', 'workspace', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(wsOf(run, 3)), false); assert.ok(existsSync(join(run.dir, 'validation', 'attempt-3', 'record.json')));
  assert.equal(sha(join(run.dir, 'validation', 'attempt-1', 'cmd-1.outputs.json')), firstOut); assert.equal(sha(join(run.dir, 'validation', 'attempt-1', 'record.json')), firstRec);
  assert.equal(recOf(run, 1).overall, 'BLOCKED'); assert.equal(recOf(run, 3).overall, 'PASS');
});

test('a throw before the record is written retains the workspace (cleanup uncertain) and says so', async () => {
  const { run } = await ready(); const authz = JSON.parse(readFileSync(join(run.dir, 'authorization.json'), 'utf8'));
  let n = 0; const clock = () => { if (++n > 1) throw new Error('clock exploded'); return Date.now(); };
  await assert.rejects(runIndependentValidation({ root: '/unused', run: run.run, contract: { validation_commands: authz.validation_commands }, audit: run.audit, runDir: run.dir, runner: validationSim(), clock, checkBinding: () => [] }), /workspace retained.*cleanup uncertain/);
  assert.ok(existsSync(wsOf(run)));
});
