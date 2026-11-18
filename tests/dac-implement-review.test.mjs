// dac implement (Increment B), part 1: persistence of project.json, trusted-terminal authorization, context verification, drift,
// dependencies, unborn Git baseline and dirty-tree preservation. Disposable projects only. Implementation is SIMULATED by injected
// runners; no Codex/Cursor binary is ever executed (tripwire executables sit first on PATH and must stay unexecuted).
// Audit, review and runner-profile tests: tests/dac-implement-audit.test.mjs. Real-PTY tests: tests/dac-implement-pty.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { plan as writerPlan, apply as writerApply, verify as writerVerify } from '../adapters/shared/sdd-writer/writer.mjs';
import { TOOL } from '../adapters/shared/sdd-handoff/mcp-server.mjs';
import { implementTask } from '../adapters/shared/sdd-run/implement.mjs';
import * as H from './support/run-harness.mjs';
import { PID, git, tty, noTty, implRunner, write, quiet, snapshot, makeProject, persist, projectDoc, task, dac, impl, review, runs, branches, worktreeCount, stateEntries, state, SCAFFOLD, ok, BASE_FILES } from './support/run-harness.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });
const noRunArtifacts = (root, st) => { assert.deepEqual(runs(root, st), []); assert.deepEqual(branches(root).filter((b) => b.includes('dac/')), []); assert.equal(worktreeCount(root), 1); assert.deepEqual(stateEntries(st), []); };
const bareHead = (root) => { try { return execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim(); } catch { return null; } };

// ---- 1. Plan/Tasks persistence through the existing Writer ------------------------------------------------------------
test('project.json persists through the existing writer: plan writes nothing, receipt chain verifies, no derived Markdown, tampering is drift', () => {
  const root = makeProject({ persistDocs: false });
  const input = { project_id: PID, operation: 'create', constitution: H.constitution(), specify: H.specify(), project: projectDoc() };
  const p = writerPlan({ target: root, input, source: () => ({ head: 'a'.repeat(40) }) });
  assert.equal(p.status, 'PLANNED'); assert.ok(p.would_write.includes(`.sdd/artifacts/${PID}/project.json`));
  assert.ok(!p.would_write.some((f) => f.endsWith('project.md')));
  assert.equal(existsSync(join(root, '.sdd')), false, 'plan writes nothing');
  const r = persist(root);
  assert.equal(r.status, 'APPLIED'); assert.equal(r.verification.status, 'passed'); assert.ok(r.files_changed.includes(`.sdd/artifacts/${PID}/project.json`));
  assert.equal(writerVerify({ target: root, projectId: PID }).status, 'OK');
  const rec = JSON.parse(readFileSync(join(root, r.receipt), 'utf8'));
  assert.deepEqual(rec.validation.artifacts, ['constitution', 'specify', 'project']);
  writeFileSync(join(root, `.sdd/artifacts/${PID}/project.json`), '{}\n');
  assert.equal(writerVerify({ target: root, projectId: PID }).status, 'DRIFT');
});

test('project.json validation reuses sdd-project.schema.json + checkProject; documentation can never claim approvals, started work or implementation', () => {
  const root = makeProject({ persistDocs: false });
  const attempt = (project, terminal = tty()) => {
    try { writerApply({ target: root, input: { project_id: PID, operation: 'create', project }, source: () => ({ head: 'a'.repeat(40) }), terminal, random: () => 'ab'.repeat(16) }); return null; } catch (e) { return { code: e.code, rules: (e.details?.errors ?? []).map((x) => x.rule) }; }
  };
  const bad = (project, rule) => { const e = attempt(project); assert.equal(e?.code, 'VALIDATION', JSON.stringify(e)); assert.ok(e.rules.includes(rule), `${rule}: ${JSON.stringify(e.rules)}`); };
  bad(projectDoc({ id: 'other-app' }), 'project-mismatch');
  bad(projectDoc({ approvals: [{ gate: 'pre-implementation', granted: true, approver_type: 'human', approver: 'x', reference: 'y' }] }), 'documentation-only');
  bad(projectDoc({ files_changed: ['src/a.js'] }), 'documentation-only');
  bad(projectDoc({ completed_phases: ['specify', 'plan', 'tasks', 'implement'] }), 'documentation-only');
  bad(projectDoc({ validation: { validation_result: 'PASS', validated_by: 'code-reviewer', evidence: [] } }), 'documentation-only');
  bad(projectDoc({ tasks: [task({ status: 'in-progress' })] }), 'documentation-only');
  bad(projectDoc({ tasks: [task({ depends_on: ['t-ghost'] })] }), 'broken-ref');
  bad(projectDoc({ tasks: [task({ depends_on: ['t-scaffold'] })] }), 'dependency-cycle');
  bad(projectDoc({ tasks: [task({ id: 'a-one', depends_on: ['a-two'] }), task({ id: 'a-two', depends_on: ['a-one'] })] }), 'dependency-cycle');
  bad(projectDoc({ tasks: [task({ owner: 'code-reviewer' })] }), 'owner-not-implementer');
  bad(projectDoc({ tasks: [task({ paths: ['elsewhere'] })] }), 'out-of-scope');
  bad(projectDoc({ tasks: [task({ validation_commands: ['a\nb'] })] }), 'command-multiline');
  bad(projectDoc({ milestone_ref: 'm.md' }), 'milestone-unsupported');
  assert.equal(attempt({ ...projectDoc(), extra: 1 })?.code, 'VALIDATION');
  assert.equal(attempt(projectDoc(), tty(false))?.code, 'APPROVAL_DENIED'); assert.equal(existsSync(join(root, '.sdd/artifacts')), false, 'denied terminal: zero writes');
  assert.equal(attempt(projectDoc()), null);
});

test('handoff tool schema and the real writer CLI accept the project artifact; the normal flow needs no extra input file', () => {
  assert.ok(TOOL.inputSchema.properties.project); assert.equal(TOOL.inputSchema.additionalProperties, false);
  const root = makeProject({ persistDocs: false });
  const f = join(H.fresh('input'), 'in.json');
  writeFileSync(f, JSON.stringify({ project_id: PID, operation: 'create', constitution: H.constitution(), specify: H.specify(), project: projectDoc() }));
  const r = dac(['sdd', 'plan', '--input', f, '--json'], root);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(JSON.parse(r.stdout).status, 'PLANNED'); assert.equal(existsSync(join(root, '.sdd')), false);
});

// ---- 2. Happy path and trusted-terminal authorization ------------------------------------------------------------------
test('implement: authorization shows the exact contract, an isolated branch/worktree is created, the simulated runner runs, evidence is retained; nothing is committed or cleaned', async () => {
  const root = makeProject({ files: BASE_FILES });
  const before = snapshot(root); const head = git(root, 'rev-parse', 'HEAD').trim(); const refs = git(root, 'for-each-ref').split('\n').filter(Boolean);
  const codexCfg = H.sha(readFileSync(join(root, '.codex/config.toml')));
  const t = tty(); const runner = implRunner(SCAFFOLD, ok());
  const r = await impl(root, { terminal: t, runner });
  assert.equal(r.code, 0, r.out);
  assert.equal(t.calls.length, 1); const shown = t.calls[0];
  assert.match(shown.phrase, /^approve [0-9a-f]{12} [0-9a-f]{8}$/);
  for (const needle of ['t-scaffold', 'Scaffold the greeter package', 'Ship a tiny greeter library', head.slice(0, 12), 'package.json, src', 'node --test', 'network:      disabled', 'bypass=false', 'prompt/context hash', 'authorization digest', 'working tree: clean', 'secrets']) assert.ok(shown.text.includes(needle), needle);
  const [run] = runs(root, r.st);
  assert.equal(run.outcome.status, 'READY_FOR_REVIEW'); assert.equal(run.audit.status, 'PASS');
  assert.deepEqual(run.audit.changes.map((c) => [c.path, c.status]), [['package.json', 'modified'], ['src/index.js', 'added']]);
  for (const f of ['run.json', 'audit.json', 'outcome.json', 'diff.patch', 'result.json', 'authorization.json', 'context/task-contract.json', 'context/prompt.md', 'context/context.json']) assert.ok(existsSync(join(run.dir, f)), f);
  assert.ok(existsSync(join(run.run.worktree.path, 'src/index.js')), 'worktree preserved');
  assert.equal(runner.calls.length, 1); assert.equal(runner.calls[0].cwd, run.run.worktree.path); assert.equal(runner.calls[0].network, false);
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head, 'no commit on the project branch');
  assert.equal(git(root, 'rev-parse', run.run.branch).trim(), head, 'the run branch still points at the base: nothing committed');
  assert.deepEqual(snapshot(root), before, 'the original project is byte-identical');
  assert.equal(H.sha(readFileSync(join(root, '.codex/config.toml'))), codexCfg, 'installed read-only Codex config untouched');
  assert.deepEqual(git(root, 'for-each-ref').split('\n').filter((l) => l && !l.includes('/dac/')), refs);
  assert.match(readFileSync(join(run.dir, 'diff.patch'), 'utf8'), /\+\+\+ b\/src\/index\.js/);
  const prompt = readFileSync(join(run.dir, 'context/prompt.md'), 'utf8');
  assert.match(prompt, /Do not commit, push, merge/); assert.doesNotMatch(prompt, /danger-full-access|bypass/i);
  assert.equal(existsSync(H.TRIPWIRE), false);
});

test('implement: terminal cancel, timeout, expiry and a missing terminal create nothing at all', async () => {
  const root = makeProject({ files: BASE_FILES }); const before = snapshot(root);
  const timeout = () => { throw Object.assign(new Error('t'), { code: 'APPROVAL_TIMEOUT' }); };
  const cases = [['APPROVAL_DENIED', { terminal: tty(false) }], ['APPROVAL_TIMEOUT', { terminal: tty(timeout) }], ['APPROVAL_TIMEOUT', { terminal: tty(true), extra: { confirmTimeoutMs: 0 } }], ['TTY_REQUIRED', { terminal: null, extra: { openTerminal: noTty } }]];
  for (const [code, o] of cases) {
    const st = state(); const runner = implRunner(SCAFFOLD, ok());
    const r = await impl(root, { ...o, runner, st });
    assert.equal(r.code, code, r.out); assert.equal(runner.calls.length, 0); noRunArtifacts(root, st);
  }
  assert.deepEqual(snapshot(root), before);
});

test('CLI: approval-style flags do not exist (strict allowlist, exit 2); task errors surface before any terminal or runner', () => {
  const root = makeProject({ files: BASE_FILES });
  for (const args of [['implement'], ['implement', '--project', 'x'], ['implement', 't-scaffold', '--yes'], ['implement', 't-scaffold', '--approve'], ['implement', 't-scaffold', '--force'], ['implement', 't-scaffold', '--no-interactive'], ['implement', 't-scaffold', '--authorization', 'x'], ['implement', 't-scaffold', '--sandbox', 'danger-full-access'], ['implement', 't-scaffold', '--allow-network'], ['review'], ['review', 't-scaffold', '--yes'], ['review', 't-scaffold', '--project']]) {
    const r = dac(args, root); assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  const missing = dac(['implement', 't-ghost'], root); assert.equal(missing.status, 1); assert.match(missing.stderr, /TASK: task "t-ghost" is not defined/);
  assert.equal(existsSync(H.TRIPWIRE), false);
});

test('production CLI entry never accepts injected dependencies (main ignores a 4th argument; seam is mainWithDeps only)', async () => {
  const mod = await import('../bin/dac.mjs');
  assert.equal(mod.main.toString().split('\n')[0].split(',').length, 3, 'main takes (argv, cwd, io) only');
  assert.equal(typeof mod.mainWithDeps, 'function');
  const root = makeProject({ files: BASE_FILES }); const t = tty(); const runner = implRunner(SCAFFOLD, ok());
  const ol = console.log; const oe = console.error; console.log = () => {}; console.error = () => {};
  let code; try { code = await mod.main(['implement', 't-scaffold'], root, undefined, { terminal: t, implementRunner: runner, stateDir: state() }); } finally { console.log = ol; console.error = oe; }
  assert.equal(runner.calls.length, 0, 'the injected runner was ignored'); assert.equal(t.calls.length, 0, 'the injected terminal was ignored'); assert.notEqual(code, 0);
  assert.equal(existsSync(H.TRIPWIRE), false);
  const src = readFileSync(new URL('../bin/dac.mjs', import.meta.url), 'utf8');
  assert.ok(/mainWithDeps\(argv, cwd, io, \{\}\)/.test(src) && /await main\(process\.argv\.slice\(2\)\)/.test(src), 'the CLI entry calls main() only');
});

// ---- 3. Context verification and drift ---------------------------------------------------------------------------------------
test('implement: missing task, tampered/missing/unreceipted artifacts, mismatching documents, incomplete phases and non-implementable change types are refused before any prompt', async () => {
  const t = tty();
  const root = makeProject({ files: BASE_FILES });
  assert.equal((await impl(root, { taskId: 't-ghost', terminal: t })).code, 'TASK');
  const specPath = join(root, `.sdd/artifacts/${PID}/specify.json`); const orig = readFileSync(specPath);
  writeFileSync(specPath, Buffer.concat([orig, Buffer.from(' ')]));
  const drift = await impl(root, { terminal: t }); assert.equal(drift.code, 'CONTEXT'); assert.match(drift.error.message, /do not verify/);
  writeFileSync(specPath, orig);
  const projPath = join(root, `.sdd/artifacts/${PID}/project.json`); const projOrig = readFileSync(projPath);
  rmSync(projPath); assert.equal((await impl(root, { terminal: t })).code, 'PROJECT'); writeFileSync(projPath, projOrig);
  assert.equal((await impl(root, { terminal: t })).code, 0, 'restored artifacts verify again');
  const noProject = makeProject({ files: BASE_FILES, persistDocs: false }); persist(noProject, { only: ['constitution', 'specify'] });
  assert.equal((await impl(noProject, { terminal: t })).code, 'PROJECT');
  assert.equal((await impl(makeProject({ files: BASE_FILES, persistDocs: false }), { terminal: t })).code, 'PROJECT');
  const mism = makeProject({ files: BASE_FILES, persistDocs: false });
  persist(mism, { project: projectDoc({ requirements: [{ id: 'req-1', statement: 'A different requirement.', acceptance_criteria: ['ac-1', 'ac-2'], open_questions: [] }] }) });
  const m = await impl(mism, { terminal: t }); assert.equal(m.code, 'CONTEXT'); assert.match(m.error.message, /does not match specify\.json/);
  const phases = makeProject({ files: BASE_FILES, persistDocs: false }); persist(phases, { project: projectDoc({ completed_phases: ['specify'] }) });
  assert.match((await impl(phases, { terminal: t })).error.message, /required phase\(s\) not completed/);
  const mig = makeProject({ files: BASE_FILES, persistDocs: false }); persist(mig, { project: projectDoc({ tasks: [task({ change_type: 'migration' })] }) });
  assert.equal((await impl(mig, { terminal: t })).code, 'TASK');
  const prot = makeProject({ files: BASE_FILES, persistDocs: false }); persist(prot, { project: projectDoc({ scope: { allowed_paths: ['.codex', 'src'], prohibited_paths: [] }, tasks: [task({ paths: ['.codex'] })] }) });
  assert.match((await impl(prot, { terminal: t })).error.message, /protected location/);
  const glob = makeProject({ files: BASE_FILES, persistDocs: false }); persist(glob, { project: projectDoc({ tasks: [task({ paths: ['src/*'] })], scope: { allowed_paths: ['src/*'], prohibited_paths: [] } }) });
  assert.match((await impl(glob, { terminal: t })).error.message, /plain relative path/);
  assert.equal(t.calls.length, 1, 'only the one valid run prompted');
});

test('implement: several persisted SDD projects need an explicit --project; package_name is not an SDD project id', async () => {
  const root = makeProject({ files: BASE_FILES });
  persist(root, { pid: 'other-app' });
  const amb = await impl(root); assert.equal(amb.code, 'PROJECT_AMBIGUOUS'); assert.match(amb.error.message, /demo-app, other-app/);
  assert.equal((await impl(root, { flags: { project: 'nope' } })).code, 'PROJECT');
  assert.equal((await impl(root, { flags: { project: 'demo-pkg' } })).code, 'PROJECT');
  const good = await impl(root, { flags: { project: 'demo-app' } }); assert.equal(good.code, 0, good.out);
  const cli = dac(['implement', 't-scaffold'], root); assert.equal(cli.status, 1); assert.match(cli.stderr, /PROJECT_AMBIGUOUS/);
});

test('implement: drift after authorization (artifact bytes, base commit) invalidates it and creates nothing', async () => {
  const root = makeProject({ files: BASE_FILES });
  const specPath = join(root, `.sdd/artifacts/${PID}/specify.json`);
  const r1 = await impl(root, { terminal: tty(() => { writeFileSync(specPath, readFileSync(specPath, 'utf8') + ' '); return true; }) });
  assert.equal(r1.code, 'CONTEXT'); noRunArtifacts(root, r1.st);
  const root2 = makeProject({ files: BASE_FILES });
  const r2 = await impl(root2, { terminal: tty(() => { write(root2, 'later.txt', 'x'); git(root2, 'add', 'later.txt'); git(root2, 'commit', '-q', '-m', 'move base'); return true; }) });
  assert.equal(r2.code, 'DRIFT'); assert.deepEqual(runs(root2, r2.st), []); assert.deepEqual(branches(root2).filter((b) => b.includes('dac/')), []);
});

test('implement: an exact still-valid earlier approval is reused without a prompt; material drift asks again; forged approval records are ignored', async () => {
  const root = makeProject({ files: BASE_FILES }); const st = state();
  assert.equal((await impl(root, { st })).code, 0);
  const q = quiet();
  const again = await implementTask({ root, taskId: 't-scaffold', deps: { openTerminal: noTty, implementRunner: implRunner(SCAFFOLD, ok()), stateDir: st, log: q.log } });
  assert.equal(again, 0); assert.match(q.out.join('\n'), /not asking again/); assert.equal(runs(root, st).length, 2);
  // forge: an approval file whose integrity digest does not match is not honoured
  const dir = join(st, readdirSync(st).find((n) => n.startsWith('approvals-'))); const f = join(dir, readdirSync(dir)[0]);
  const rec = JSON.parse(readFileSync(f, 'utf8')); rec.approved_at = new Date().toISOString(); writeFileSync(f, JSON.stringify(rec));
  const forged = await impl(root, { st, terminal: null, extra: { openTerminal: noTty } }); assert.equal(forged.code, 'TTY_REQUIRED');
  rmSync(f); // new base => a different exact authorization
  write(root, 'x.txt', 'x'); git(root, 'add', 'x.txt'); git(root, 'commit', '-q', '-m', 'drift');
  const c = await impl(root, { st, terminal: null, extra: { openTerminal: noTty } }); assert.equal(c.code, 'TTY_REQUIRED');
  const t = tty(); assert.equal((await impl(root, { st, terminal: t })).code, 0); assert.equal(t.calls.length, 1);
});

test('implement: approval reuse follows the canonical Writer TTL (600s) via a bound expires_at; never at or after expiry; forged expiry is rejected', async () => {
  const { TTL_SECONDS } = await import('../adapters/shared/sdd-writer/authorization.mjs'); assert.equal(TTL_SECONDS, 600);
  const root = makeProject({ files: BASE_FILES }); const st = state(); const T0 = Date.parse('2026-01-01T00:00:00.000Z');
  const at = (ms) => () => T0 + ms;
  assert.equal((await impl(root, { st, extra: { clock: at(0) } })).code, 0);
  const dir = join(st, readdirSync(st).find((n) => n.startsWith('approvals-'))); const f = join(dir, readdirSync(dir)[0]);
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(Date.parse(rec.expires_at) - Date.parse(rec.approved_at), TTL_SECONDS * 1000); assert.ok(rec.record_digest);
  const reuse = async (ms, tm = null) => { const q = quiet(); try { return { code: await implementTask({ root, taskId: 't-scaffold', deps: { openTerminal: tm ? () => tm : noTty, implementRunner: implRunner(SCAFFOLD, ok()), stateDir: st, log: q.log, clock: at(ms) } }), out: q.out.join('\n') }; } catch (e) { return { code: e.code, out: q.out.join('\n') }; } };
  const before = await reuse(TTL_SECONDS * 1000 - 1); assert.equal(before.code, 0); assert.match(before.out, /not asking again/);
  assert.equal((await reuse(TTL_SECONDS * 1000)).code, 'TTY_REQUIRED', 'at expiry: not reusable');
  assert.equal((await reuse(TTL_SECONDS * 1000 + 1)).code, 'TTY_REQUIRED', 'after expiry: not reusable');
  assert.equal((await reuse(24 * 3600 * 1000 - 1)).code, 'TTY_REQUIRED', 'no 24-hour window');
  // forged: extended expiry (record_digest mismatch) and consistently re-digested but non-canonical expiry
  writeFileSync(f, JSON.stringify({ ...rec, expires_at: new Date(T0 + 86400000).toISOString() }));
  assert.equal((await reuse(TTL_SECONDS * 1000 + 5)).code, 'TTY_REQUIRED');
  writeFileSync(f, JSON.stringify(rec)); assert.equal((await reuse(1000)).code, 0);
});

// ---- 4. Dependencies --------------------------------------------------------------------------------------------------------------
test('implement: a dependent task waits for a reviewed (PASS) AND integrated dependency; integration is verified by content, not by trust', async () => {
  const root = makeProject({ files: BASE_FILES }); const st = state();
  const feat = () => impl(root, { taskId: 't-feature', st, runner: implRunner((cwd) => write(cwd, 'src/feature.js', 'export const f = 1;\n'), H.okResult(['src/feature.js'])) });
  const none = await feat(); assert.equal(none.code, 'DEPENDENCY'); assert.match(none.error.message, /t-scaffold: no reviewed run/);
  assert.equal((await impl(root, { st })).code, 0);
  const unreviewed = await feat(); assert.equal(unreviewed.code, 'DEPENDENCY'); assert.match(unreviewed.error.message, /no passing independent review/);
  assert.equal((await review(root, st)).code, 0);
  const notMerged = await feat(); assert.equal(notMerged.code, 'DEPENDENCY'); assert.match(notMerged.error.message, /not integrated in HEAD/);
  const [r] = runs(root, st); // the human integrates the reviewed content (here: the same bytes, committed)
  write(root, 'package.json', readFileSync(join(r.run.worktree.path, 'package.json'), 'utf8')); write(root, 'src/index.js', readFileSync(join(r.run.worktree.path, 'src/index.js'), 'utf8'));
  git(root, 'add', 'package.json', 'src/index.js'); git(root, 'commit', '-q', '-m', 'integrate t-scaffold');
  const done = await feat(); assert.equal(done.code, 0, done.out); assert.match(done.terminal.calls[0].text, /dependencies: t-scaffold \(run r-/);
});

// ---- 5. Unborn Git: explicit, reviewed baseline ---------------------------------------------------------------------------------
const UNBORN_FILES = { 'README.md': '# demo\n', 'src/a.js': 'export const a = 1;\n', '.gitignore': 'node_modules/\n*.log\n', '.env': 'SECRET=1\n', 'node_modules/x/index.js': 'x\n', 'debug.log': 'log\n', 'key.pem': 'pem\n' };
test('unborn Git: the baseline is an explicit reviewed list needing the trusted terminal; decline commits nothing; accept commits exactly the list (never "git add .")', async () => {
  const root = makeProject({ born: false, files: UNBORN_FILES });
  git(root, 'add', '.env'); // staged but excluded (sensitive): must stay staged, untouched
  const idxBefore = git(root, 'ls-files', '-s'); const before = snapshot(root);
  const no = await impl(root, { terminal: tty(false) });
  assert.equal(no.code, 'APPROVAL_DENIED'); assert.equal(bareHead(root), null); assert.equal(git(root, 'ls-files', '-s'), idxBefore); assert.deepEqual(snapshot(root), before); noRunArtifacts(root, no.st);
  const t = tty(); const yes = await impl(root, { terminal: t });
  assert.equal(yes.code, 0, yes.out);
  const shown = t.calls[0].text;
  assert.match(shown, /UNBORN repository: a reviewed baseline commit of 3 file\(s\)/);
  for (const f of ['README.md', 'src/a.js', '.gitignore']) assert.ok(shown.includes(`+ ${f}`), f);
  for (const [f, why] of [['.env', 'sensitive-name'], ['key.pem', 'sensitive-name'], ['.dac/standard.json', 'dac-managed'], ['AGENTS.md', 'dac-managed']]) assert.ok(shown.includes(`- ${f} (excluded: ${why})`), f);
  assert.deepEqual(git(root, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort(), ['.gitignore', 'README.md', 'src/a.js']);
  const status = git(root, 'status', '--porcelain').split('\n').filter(Boolean);
  assert.ok(status.includes('A  .env'), 'staged-but-excluded stays staged'); assert.ok(!status.some((l) => /^(D|.D|A )/.test(l) && !l.endsWith('.env')), status.join('|')); // no staged deletions: the index matches HEAD
  assert.deepEqual(snapshot(root), before, 'no working-tree change');
  const [run] = runs(root, yes.st); assert.equal(run.run.base_commit, git(root, 'rev-parse', 'HEAD').trim());
  assert.ok(existsSync(join(run.run.worktree.path, 'README.md'))); assert.equal(existsSync(join(run.run.worktree.path, '.env')), false);
  assert.equal(run.outcome.status, 'READY_FOR_REVIEW');
});

test('unborn Git: files changing after the baseline was reviewed abort without a commit; every unborn run needs the terminal', async () => {
  const root = makeProject({ born: false, files: UNBORN_FILES });
  const r = await impl(root, { terminal: tty(() => { write(root, 'README.md', '# changed after review\n'); return true; }) });
  assert.equal(r.code, 'DRIFT'); assert.equal(bareHead(root), null); noRunArtifacts(root, r.st);
  const nt = await impl(root, { terminal: null, extra: { openTerminal: noTty } }); assert.equal(nt.code, 'TTY_REQUIRED'); assert.equal(bareHead(root), null);
  const big = makeProject({ born: false, files: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f/${i}.txt`, `${i}\n`])) });
  const tooMany = await impl(big); assert.equal(tooMany.code, 'BASELINE_TOO_LARGE'); assert.equal(bareHead(big), null);
});

// ---- 6. Dirty-tree preservation ------------------------------------------------------------------------------------------------------
test('dirty project: refused without an explicit non-destructive policy; with --preserve-dirty every local change stays byte-identical and out of the worktree', async () => {
  const root = makeProject({ files: BASE_FILES });
  write(root, 'README.md', '# locally edited\n'); write(root, 'notes.txt', 'untracked notes\n'); write(root, 'src/keep.js', 'export const keep = 2;\n'); git(root, 'add', 'src/keep.js'); write(root, 'ignored.log', 'x\n');
  const before = snapshot(root); const status = git(root, 'status', '--porcelain'); const index = git(root, 'ls-files', '-s');
  const refused = await impl(root); assert.equal(refused.code, 'DIRTY'); assert.match(refused.error.message, /never stashes, resets or hides/); assert.deepEqual(stateEntries(refused.st), []); assert.equal(refused.terminal.calls.length, 0);
  const t = tty(); const r = await impl(root, { terminal: t, flags: { preserveDirty: true } });
  assert.equal(r.code, 0, r.out); assert.match(t.calls[0].text, /3 uncommitted change\(s\) are PRESERVED untouched and are NOT part of the worktree/);
  assert.deepEqual(snapshot(root), before, 'local changes byte-identical'); assert.equal(git(root, 'status', '--porcelain'), status); assert.equal(git(root, 'ls-files', '-s'), index);
  const [run] = runs(root, r.st); assert.equal(run.run.dirty_preserved, 3);
  assert.equal(readFileSync(join(run.run.worktree.path, 'README.md'), 'utf8'), '# demo\n', 'the worktree starts from HEAD, not from the dirty files');
  assert.equal(existsSync(join(run.run.worktree.path, 'notes.txt')), false);
});

// ---- 7. Root scaffolding only when explicitly included -------------------------------------------------------------------------
test('first-task scaffolding: root files are writable only when the task lists them by exact path; broad or directory entries do not cover them', async () => {
  const explicit = makeProject({ files: { 'README.md': '# demo\n' } });
  const a = await impl(explicit); assert.equal(a.code, 0, a.out); assert.deepEqual(runs(explicit, a.st)[0].audit.changes.map((c) => c.path), ['package.json', 'src/index.js']);
  const implicit = makeProject({ files: { 'README.md': '# demo\n' }, persistDocs: false });
  persist(implicit, { project: projectDoc({ tasks: [task({ paths: ['src'] })] }) });
  const b = await impl(implicit); assert.equal(b.code, 1, b.out); const [run] = runs(implicit, b.st);
  assert.equal(run.outcome.status, 'AUDIT_BLOCKED'); assert.ok(run.audit.violations.some((v) => v.path === 'package.json' && v.rule === 'out-of-scope'), JSON.stringify(run.audit.violations));
  const nested = makeProject({ files: { 'README.md': '# demo\n' }, persistDocs: false });
  persist(nested, { project: projectDoc({ tasks: [task({ paths: ['src'] })] }) });
  const c = await impl(nested, { runner: implRunner((cwd) => write(cwd, 'src/package.json', '{}\n'), H.okResult(['src/package.json'])) });
  assert.ok(runs(nested, c.st)[0].audit.violations.some((v) => v.rule === 'sensitive-not-explicit' && v.path === 'src/package.json'), 'a directory entry does not cover a manifest');
});

test('no provider binary was ever executed by any test in this file', () => { assert.equal(existsSync(H.TRIPWIRE), false); });
