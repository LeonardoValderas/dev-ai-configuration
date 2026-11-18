// dac implement/review (Increment B), part 2: the blocking post-run audit, dac review binding and separation, runner profiles.
// Everything is simulated with injected runners; no Codex/Cursor binary is ever executed (tripwire executables must stay unexecuted).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, linkSync, unlinkSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { verify as bootstrapVerify } from '../installer/bootstrap.mjs';
import { assertSafeProfile, codexRunner, parseResult } from '../adapters/shared/sdd-run/runners.mjs';
import * as H from './support/run-harness.mjs';
import { PID, git, tty, implRunner, reviewRunner, okResult, write, snapshot, makeProject, persist, projectDoc, task, impl, review, runs, branches, SCAFFOLD, ok, BASE_FILES } from './support/run-harness.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });
const bigProject = () => makeProject({ files: { ...BASE_FILES, 'src/run.sh': '#!/bin/sh\n' } });

// ---- 1. Audit violation matrix: each is blocking, preserved, and never reviewable --------------------------------------------
const CASES = [
  ['out-of-scope file', 'out-of-scope', (cwd) => write(cwd, 'docs/x.md', 'x\n')],
  ['ignored file', 'ignored-file', (cwd) => write(cwd, 'src/a.log', 'x\n')],
  ['symlink', 'symlink', (cwd) => symlinkSync('../README.md', join(cwd, 'src/link'))],
  ['symlink to outside', 'symlink', (cwd) => symlinkSync('/etc/hosts', join(cwd, 'src/hosts'))],
  ['hard link', 'hardlink', (cwd) => linkSync(join(cwd, 'README.md'), join(cwd, 'src/h.md'))],
  ['mode change of an existing file', 'mode-change-not-explicit', (cwd) => chmodSync(join(cwd, 'src/old.js'), 0o755)],
  ['new executable', 'executable-not-explicit', (cwd) => write(cwd, 'src/new.sh', '#!/bin/sh\n', 0o755)],
  ['setuid bit', 'special-mode', (cwd) => { write(cwd, 'src/s.js', 'x\n'); chmodSync(join(cwd, 'src/s.js'), 0o4755); }],
  ['delete of an existing file', 'delete-not-explicit', (cwd) => unlinkSync(join(cwd, 'src/old.js'))],
  ['rename of an existing file', 'delete-not-explicit', (cwd) => renameSync(join(cwd, 'src/old.js'), join(cwd, 'src/renamed.js'))],
  ['write under .codex', 'protected-path', (cwd) => write(cwd, '.codex/config.toml', 'sandbox_mode = "danger-full-access"\n')],
  ['root AGENTS.md', 'protected-path', (cwd) => write(cwd, 'AGENTS.md', 'x\n')],
  ['nested AGENTS.md', 'protected-path', (cwd) => write(cwd, 'src/AGENTS.md', 'x\n')],
  ['write under .sdd', 'protected-path', (cwd) => write(cwd, '.sdd/x.json', '{}\n')],
  ['existing .gitignore edited (not in task)', 'out-of-scope', (cwd) => write(cwd, '.gitignore', '')],
  ['manifest in a subdirectory (directory entry is not exact)', 'sensitive-not-explicit', (cwd) => write(cwd, 'src/package.json', '{}\n')],
  ['nested Git metadata', 'nested-git', (cwd) => write(cwd, 'src/sub/.git/HEAD', 'x\n')],
  ['unsafe file name', 'unsafe-name', (cwd) => write(cwd, 'src/a\nb.js', 'x\n')],
  ['worktree-private info/exclude hiding a file', 'git-metadata', (cwd) => { const gd = git(cwd, 'rev-parse', '--absolute-git-dir').trim(); mkdirSync(join(gd, 'info'), { recursive: true }); writeFileSync(join(gd, 'info/exclude'), 'src/hidden.js\n'); }],
  ['worktree-private info/sparse-checkout', 'git-metadata', (cwd) => { const gd = git(cwd, 'rev-parse', '--absolute-git-dir').trim(); mkdirSync(join(gd, 'info'), { recursive: true }); writeFileSync(join(gd, 'info/sparse-checkout'), '/README.md\n'); }],
  ['too many files', 'too-many-files', (cwd) => { for (let i = 0; i < 201; i++) write(cwd, `src/many/f${i}.txt`, `${i}\n`); }],
  ['file over the ceiling', 'file-too-large', (cwd) => writeFileSync(join(cwd, 'src/big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 1))],
  ['commit created by the runner', 'head-moved', (cwd) => { write(cwd, 'src/c.js', 'x\n'); git(cwd, 'add', 'src/c.js'); git(cwd, 'commit', '-q', '-m', 'sneaky'); }],
  ['branch created by the runner', 'git-metadata', (cwd) => git(cwd, 'branch', 'evil')],
  ['tag created by the runner', 'git-metadata', (cwd) => git(cwd, 'tag', 'evil')],
  ['remote added by the runner', 'git-metadata', (cwd) => git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/x.git')],
  ['hook planted in the project repository', 'git-metadata', (cwd, root) => write(root, '.git/hooks/post-commit', '#!/bin/sh\n', 0o755)],
  ['original project file modified (worktree is not a sandbox)', 'original-project-modified', (cwd, root) => write(root, 'README.md', '# hacked\n')],
  ['original project: new untracked file', 'original-project-modified', (cwd, root) => write(root, 'dropped.txt', 'x\n')],
  ['installed read-only Codex config rewritten in the original project', 'original-project-modified', (cwd, root) => write(root, '.codex/config.toml', 'sandbox_mode = "danger-full-access"\n')],
  ['SDD artifact rewritten in the original project', 'original-project-modified', (cwd, root) => write(root, `.sdd/artifacts/${PID}/project.json`, '{}\n')],
];
for (const [name, rule, effect] of CASES) {
  test(`audit blocks: ${name}`, async () => {
    const root = bigProject();
    const headBefore = git(root, 'rev-parse', 'main').trim();
    const runner = implRunner((cwd) => { SCAFFOLD(cwd); effect(cwd, root); }, ok(['package.json', 'src/index.js']));
    const r = await impl(root, { runner });
    assert.equal(r.code, 1, r.out);
    const [run] = runs(root, r.st);
    assert.equal(run.outcome.status, 'AUDIT_BLOCKED'); assert.equal(run.audit.status, 'BLOCKED');
    assert.ok(run.audit.violations.some((v) => v.rule === rule), `${rule} in ${JSON.stringify(run.audit.violations)}`);
    for (const f of ['run.json', 'audit.json', 'outcome.json', 'authorization.json']) assert.ok(existsSync(join(run.dir, f)), f);
    assert.equal(existsSync(join(run.dir, 'diff.patch')), false, 'a blocked audit never yields a reviewable diff');
    assert.ok(existsSync(join(run.run.worktree.path, 'src/index.js')), 'the failed worktree is preserved');
    assert.equal(git(root, 'rev-parse', 'main').trim(), headBefore, 'no commit reached the project branch');
    const rev = await review(root, r.st); assert.equal(rev.code, 'NOT_REVIEWABLE'); assert.equal(rev.runner.calls.length, 0, 'the reviewer never sees a blocked run');
    assert.equal(existsSync(H.TRIPWIRE), false);
  });
}

test('audit blocks forged approval records and tampering with another run\'s evidence', async () => {
  const root = bigProject(); const st = H.state();
  assert.equal((await impl(root, { st })).code, 0); const [first] = runs(root, st);
  const approvals = join(st, readdirSync(st).find((n) => n.startsWith('approvals-')));
  const forge = (cwd) => { SCAFFOLD(cwd); writeFileSync(join(approvals, readdirSync(approvals)[0]), '{"forged":true}'); };
  const a = await impl(root, { st, runner: implRunner(forge, ok()) }); assert.equal(a.code, 1);
  assert.ok(runs(root, st).at(-1).audit.violations.some((v) => v.rule === 'evidence-modified'));
  const b = await impl(root, { st, runner: implRunner((cwd) => { SCAFFOLD(cwd); writeFileSync(join(first.dir, 'outcome.json'), '{}'); }, ok()) });
  assert.equal(b.code, 1); assert.ok(runs(root, st).at(-1).audit.violations.some((v) => v.rule === 'evidence-modified'));
});

test('audit blocks any content inside a submodule path of the base tree', async () => {
  const root = makeProject({ files: BASE_FILES, persistDocs: false });
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},src/vendor`); git(root, 'commit', '-q', '-m', 'gitlink'); mkdirSync(join(root, 'src/vendor'), { recursive: true }); // an uninitialized submodule is an empty directory
  persist(root);
  const r = await impl(root, { runner: implRunner((cwd) => { SCAFFOLD(cwd); write(cwd, 'src/vendor/x.js', 'x\n'); }, ok()) });
  assert.equal(r.code, 1); assert.ok(runs(root, r.st)[0].audit.violations.some((v) => v.rule === 'submodule'));
});

test('audit passes legitimate in-scope changes, including exactly-listed manifest edits, deletions and executables; provider self-report mismatch is only a warning', async () => {
  const root = makeProject({ files: { ...BASE_FILES, 'src/run.sh': '#!/bin/sh\n' }, persistDocs: false });
  persist(root, { project: projectDoc({ tasks: [task({ paths: ['package.json', 'src', 'src/old.js', 'src/run.sh', 'src/tool.sh'] })] }) });
  const effect = (cwd) => { write(cwd, 'package.json', '{"name":"base","scripts":{}}\n'); write(cwd, 'src/keep.js', 'export const keep = 3;\n'); unlinkSync(join(cwd, 'src/old.js')); chmodSync(join(cwd, 'src/run.sh'), 0o755); write(cwd, 'src/tool.sh', '#!/bin/sh\n', 0o755); write(cwd, 'src/new.js', 'x\n'); };
  const r = await impl(root, { runner: implRunner(effect, okResult(['package.json'])) });
  assert.equal(r.code, 0, r.out); const [run] = runs(root, r.st);
  assert.deepEqual(run.audit.changes.map((c) => `${c.path}:${c.status}`), ['package.json:modified', 'src/keep.js:modified', 'src/new.js:added', 'src/old.js:deleted', 'src/run.sh:mode-changed', 'src/tool.sh:added']);
  assert.equal(run.audit.warnings.length, 1); assert.match(run.audit.warnings[0], /differ from the audited changes/);
  assert.match(readFileSync(join(run.dir, 'diff.patch'), 'utf8'), /deleted file mode/);
  assert.equal(bootstrapVerify({ target: root }).status, 'OK', 'bootstrap integrity unaffected');
});

test('runner failure, invalid result and provider BLOCKED are retained as evidence and are not reviewable', async () => {
  const root = bigProject();
  const crash = { id: 'sim-implement', role: 'implement', describe: () => implRunner().describe(), async run({ cwd }) { SCAFFOLD(cwd); throw new Error('runner crashed'); } };
  const a = await impl(root, { runner: crash }); assert.equal(a.code, 1); const [ra] = runs(root, a.st);
  assert.equal(ra.outcome.status, 'RUNNER_FAILED'); assert.match(ra.outcome.runner_error, /runner crashed/); assert.ok(ra.audit && existsSync(ra.run.worktree.path));
  const b = await impl(root, { runner: implRunner(SCAFFOLD, { kind: 'result' }) }); assert.equal(runs(root, b.st)[0].outcome.status, 'NOT_REVIEWABLE'); assert.ok(runs(root, b.st)[0].outcome.result_errors.length);
  const c = await impl(root, { runner: implRunner(SCAFFOLD, okResult([], { execution_status: 'BLOCKED', validation_result: 'BLOCKED', unresolved_blockers: ['no network'] })) }); assert.equal(runs(root, c.st)[0].outcome.status, 'NOT_REVIEWABLE');
  for (const r of [a, b, c]) assert.equal((await review(root, r.st)).code, 'NOT_REVIEWABLE');
});

// ---- 2. dac review: exact binding, separation, no cleanup ----------------------------------------------------------------------
async function implemented(o = {}) {
  const root = bigProject(); const r = await impl(root, o); assert.equal(r.code, 0, r.out); return { root, st: r.st, run: runs(root, r.st)[0] };
}

test('review: a separate read-only reviewer is bound to the exact audit/diff hash, validated by the result contract, rechecked afterwards; nothing is cleaned or published', async () => {
  const { root, st, run } = await implemented();
  const before = snapshot(root); const refs = git(root, 'for-each-ref');
  const reviewer = reviewRunner(() => {}, okResult([], { warnings: ['minor style nit'] }));
  const r = await review(root, st, { runner: reviewer }); assert.equal(r.code, 0, r.out); assert.match(r.out, /: PASS/);
  assert.equal(reviewer.calls.length, 1); const call = reviewer.calls[0];
  assert.equal(call.cwd, run.run.worktree.path); assert.equal(call.network, false); assert.equal(call.profile.sandbox, 'read-only');
  assert.ok(call.prompt.includes(run.audit.audit_hash) && call.prompt.includes(run.audit.diff_sha256) && call.prompt.includes('+++ b/src/index.js'), 'the prompt carries the exact diff and hashes');
  assert.match(call.prompt, /strictly read-only/i); assert.match(call.prompt, /did not implement this change/);
  const [rec] = runs(root, st)[0].reviews;
  assert.equal(rec.verdict, 'PASS'); assert.equal(rec.audit_hash, run.audit.audit_hash); assert.equal(rec.diff_sha256, run.audit.diff_sha256); assert.equal(rec.result_tree, run.audit.result_tree); assert.equal(rec.binding_rechecked_after_review, 'equal');
  assert.equal(rec.reviewer.role, 'review'); assert.notEqual(rec.reviewer.id, rec.implementer.id); assert.notEqual(rec.reviewer.session, rec.implementer.run_id);
  assert.ok(existsSync(run.run.worktree.path)); assert.deepEqual(snapshot(root), before); assert.equal(git(root, 'for-each-ref'), refs);
  assert.equal((await review(root, st)).code, 0, 'a second independent review of the same run is allowed and recorded'); assert.equal(runs(root, st)[0].reviews.length, 2);
});

test('review: reviewer verdicts FAIL/BLOCKED/INVALID_RESULT are recorded and exit non-zero', async () => {
  const { root, st } = await implemented();
  const verdict = async (result, effect) => { const r = await review(root, st, { runner: reviewRunner(effect ?? (() => {}), result) }); return [r.code, runs(root, st)[0].reviews.at(-1).verdict]; };
  assert.deepEqual(await verdict(okResult([], { validation_result: 'FAIL', warnings: ['[HIGH] src/index.js:1 injection'] })), [1, 'FAIL']);
  assert.deepEqual(await verdict(okResult([], { unresolved_blockers: ['needs a test'] })), [1, 'FAIL']);
  assert.deepEqual(await verdict(okResult([], { execution_status: 'BLOCKED', validation_result: 'BLOCKED' })), [1, 'BLOCKED']);
  assert.deepEqual(await verdict({ kind: 'nope' }), [1, 'INVALID_RESULT']);
  assert.deepEqual(await verdict(okResult(['src/index.js'])), [1, 'INVALID_RESULT']); // a read-only reviewer cannot report changed files
  const thrower = reviewRunner(); thrower.run = async () => { throw new Error('reviewer died'); };
  assert.equal((await review(root, st, { runner: thrower })).code, 1); assert.equal(runs(root, st)[0].reviews.at(-1).verdict, 'INVALID_RESULT');
});

test('review: the binding is rechecked AFTER the review; a reviewer that touches the worktree or the original project invalidates its own verdict', async () => {
  const { root, st } = await implemented();
  const touched = await review(root, st, { runner: reviewRunner((cwd) => write(cwd, 'src/injected.js', 'x\n')) });
  assert.equal(touched.code, 1); const rec = runs(root, st)[0].reviews.at(-1); assert.equal(rec.verdict, 'INVALIDATED'); assert.equal(rec.binding_rechecked_after_review, 'CHANGED');
  const again = await review(root, st); assert.equal(again.code, 'EVIDENCE', 'the changed worktree no longer matches the audited content'); assert.equal(again.runner.calls.length, 0);
  const b = await implemented();
  const outside = await review(b.root, b.st, { runner: reviewRunner((cwd, a) => write(b.root, 'README.md', '# reviewer wrote here\n')) });
  assert.equal(outside.code, 1); assert.equal(runs(b.root, b.st)[0].reviews.at(-1).verdict, 'INVALIDATED');
});

test('review: refuses when the worktree, the immutable evidence or the SDD context changed since the audit; the reviewer is never invoked', async () => {
  const mk = async () => implemented();
  let c = await mk(); write(c.run.run.worktree.path, 'src/extra.js', 'x\n');
  let r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE'); assert.equal(r.runner.calls.length, 0);
  c = await mk(); write(c.run.run.worktree.path, 'src/index.js', 'export const greet = () => "evil";\n');
  r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE'); assert.equal(r.runner.calls.length, 0);
  c = await mk(); writeFileSync(join(c.run.dir, 'audit.json'), readFileSync(join(c.run.dir, 'audit.json'), 'utf8') + ' ');
  r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE'); assert.equal(r.runner.calls.length, 0);
  c = await mk(); writeFileSync(join(c.run.dir, 'diff.patch'), readFileSync(join(c.run.dir, 'diff.patch'), 'utf8') + '\n');
  r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE');
  c = await mk(); writeFileSync(join(c.run.dir, 'run.json'), readFileSync(join(c.run.dir, 'run.json'), 'utf8') + ' ');
  r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE');
  c = await mk(); const spec = join(c.root, `.sdd/artifacts/${PID}/specify.json`); writeFileSync(spec, readFileSync(spec, 'utf8') + ' ');
  r = await review(c.root, c.st); assert.equal(r.code, 'CONTEXT'); assert.equal(r.runner.calls.length, 0);
  c = await mk(); git(c.root, 'update-ref', '-d', `refs/heads/${c.run.run.branch}`); // the run branch was deleted/moved behind our back
  r = await review(c.root, c.st); assert.equal(r.code, 'EVIDENCE');
});

const WT_PRIVATE = [
  ['info/exclude', 'src/hidden.js\n'],
  ['info/sparse-checkout', '/README.md\n'],
];
const gitDirOf = (cwd) => git(cwd, 'rev-parse', '--absolute-git-dir').trim();

for (const [file, content] of WT_PRIVATE) {
  test(`review: worktree-private ${file} tampered after READY_FOR_REVIEW is refused before the reviewer runs`, async () => {
    const { root, st, run } = await implemented();
    const gd = gitDirOf(run.run.worktree.path); mkdirSync(join(gd, 'info'), { recursive: true }); writeFileSync(join(gd, file), content);
    const r = await review(root, st); assert.equal(r.code, 'EVIDENCE', r.out); assert.equal(r.runner.calls.length, 0, 'the reviewer is never invoked');
    assert.equal(runs(root, st)[0].reviews.length, 0, 'no review record is written for a refused review');
  });

  test(`review: a reviewer that tampers with worktree-private ${file} invalidates its own verdict`, async () => {
    const { root, st } = await implemented();
    const r = await review(root, st, { runner: reviewRunner((cwd) => { const gd = gitDirOf(cwd); mkdirSync(join(gd, 'info'), { recursive: true }); writeFileSync(join(gd, file), content); }) });
    assert.equal(r.code, 1, r.out); const rec = runs(root, st)[0].reviews.at(-1);
    assert.equal(rec.verdict, 'INVALIDATED'); assert.equal(rec.binding_rechecked_after_review, 'CHANGED');
  });
}

test('review: worktree-private config.worktree and hooks tampering after READY_FOR_REVIEW is refused before the reviewer runs', async () => {
  for (const tamper of [(gd) => writeFileSync(join(gd, 'config.worktree'), '[core]\n\tfsmonitor = true\n'), (gd) => { mkdirSync(join(gd, 'hooks'), { recursive: true }); writeFileSync(join(gd, 'hooks/post-commit'), '#!/bin/sh\n', { mode: 0o755 }); }]) {
    const { root, st, run } = await implemented(); tamper(gitDirOf(run.run.worktree.path));
    const r = await review(root, st); assert.equal(r.code, 'EVIDENCE', r.out); assert.equal(r.runner.calls.length, 0);
  }
});

test('review: ambiguous runs require --run; unknown, blocked or absent runs are refused', async () => {
  const root = bigProject(); const st = H.state();
  assert.equal((await review(root, st)).code, 'NO_RUN');
  const blocked = await impl(root, { st, runner: implRunner((cwd) => { SCAFFOLD(cwd); write(cwd, 'docs/x', 'x'); }, ok()) }); assert.equal(blocked.code, 1);
  const only = await review(root, st); assert.equal(only.code, 'NOT_REVIEWABLE');
  const one = await impl(root, { st }); assert.equal(one.code, 0); const two = await impl(root, { st }); assert.equal(two.code, 0);
  const all = runs(root, st); const ready = all.filter((x) => x.outcome.status === 'READY_FOR_REVIEW'); assert.equal(ready.length, 2);
  const amb = await review(root, st); assert.equal(amb.code, 'RUN_AMBIGUOUS'); for (const x of ready) assert.ok(amb.error.message.includes(x.run_id)); assert.equal(amb.runner.calls.length, 0);
  assert.equal((await review(root, st, { flags: { run: 'r-nope' } })).code, 'NO_RUN');
  assert.equal((await review(root, st, { flags: { run: all.find((x) => x.outcome.status === 'AUDIT_BLOCKED').run_id } })).code, 'NOT_REVIEWABLE');
  const picked = await review(root, st, { flags: { run: ready[1].run_id } }); assert.equal(picked.code, 0, picked.out);
  assert.equal(runs(root, st).find((x) => x.run_id === ready[1].run_id).reviews.length, 1); assert.equal(runs(root, st).find((x) => x.run_id === ready[0].run_id).reviews.length, 0);
});

test('review: the implementer can never approve; implementation runners, same-identity runners and unsafe review profiles are refused before anything runs', async () => {
  const { root, st } = await implemented();
  const implAsReviewer = implRunner(); assert.equal((await review(root, st, { runner: implAsReviewer })).code, 'UNSAFE_PROFILE'); assert.equal(implAsReviewer.calls.length, 0);
  const same = reviewRunner(() => {}, null, { id: 'sim-implement' }); assert.equal((await review(root, st, { runner: same })).code, 'NOT_INDEPENDENT'); assert.equal(same.calls.length, 0);
  for (const profile of [{ sandbox: 'workspace-write' }, { sandbox: 'danger-full-access' }, { network: true }, { bypass: true }, { approval: 'on-request' }, { mcp: 'filesystem' }, { argv: ['--dangerously-bypass-approvals-and-sandbox'] }, { argv: ['--yolo'] }]) {
    const r = reviewRunner(() => {}, null, { profile }); const res = await review(root, st, { runner: r });
    assert.equal(res.code, 'UNSAFE_PROFILE', JSON.stringify(profile)); assert.equal(r.calls.length, 0);
  }
  assert.equal(runs(root, st)[0].reviews.length, 0);
});

test('audit blocks a tracked base symlink replaced by a regular file at the same in-scope path as a type change', async () => {
  const root = makeProject({ files: BASE_FILES });
  symlinkSync('keep.js', join(root, 'src/alias')); git(root, 'add', 'src/alias'); git(root, 'commit', '-q', '-m', 'tracked symlink');
  assert.match(git(root, 'ls-files', '-s', 'src/alias'), /^120000/);
  const runner = implRunner((cwd) => { SCAFFOLD(cwd); unlinkSync(join(cwd, 'src/alias')); write(cwd, 'src/alias', 'export const real = 1;\n'); }, ok(['package.json', 'src/index.js', 'src/alias']));
  const r = await impl(root, { runner });
  assert.equal(r.code, 1, r.out);
  const [run] = runs(root, r.st);
  assert.equal(run.outcome.status, 'AUDIT_BLOCKED');
  assert.ok(run.audit.violations.some((v) => v.rule === 'type-change' && v.path === 'src/alias'), JSON.stringify(run.audit.violations));
});

// ---- 3. Runner profiles: explicit, safe, injectable -------------------------------------------------------------------------------
test('implement: unsafe runner profiles (bypass, danger-full-access, prompts, MCP, unauthorized network, wrong role) are refused before any prompt or side effect', async () => {
  const root = bigProject();
  for (const profile of [{ sandbox: 'danger-full-access' }, { sandbox: 'read-only' }, { approval: 'never' }, { approval: 'on-failure' }, { approval: 'untrusted' }, { mcp: 'filesystem' }, { network: true }, { bypass: true }, { bypass: undefined }, { argv: ['--dangerously-bypass-approvals-and-sandbox'] }, { argv: ['--yolo'] }, { argv: ['--full-auto'] }, { role: 'review' }]) {
    const t = tty(); const runner = implRunner(SCAFFOLD, ok(), { profile }); const st = H.state();
    const r = await impl(root, { runner, terminal: t, st });
    assert.equal(r.code, 'UNSAFE_PROFILE', JSON.stringify(profile)); assert.equal(t.calls.length, 0); assert.equal(runner.calls.length, 0); assert.deepEqual(H.stateEntries(st), []);
  }
  const reviewAsImpl = await impl(root, { runner: reviewRunner() }); assert.equal(reviewAsImpl.code, 'UNSAFE_PROFILE');
  assert.equal(branches(root).filter((b) => b.includes('dac/')).length, 0);
});

test('implement: network is off unless the persisted task declares it, is shown, and is authorized; the runner must match exactly', async () => {
  const root = makeProject({ files: BASE_FILES, persistDocs: false });
  persist(root, { project: projectDoc({ tasks: [task({ needs_network: true, validation_commands: ['npm install', 'node --test'] })] }) });
  const off = await impl(root, { runner: implRunner(SCAFFOLD, ok(), { profile: { network: false } }) }); assert.equal(off.code, 'UNSAFE_PROFILE', 'task needs network, runner profile says no network');
  const t = tty(); const runner = implRunner(SCAFFOLD, ok(), { profile: { network: true } });
  const on = await impl(root, { terminal: t, runner, extra: {} });
  assert.equal(on.code, 0, on.out); assert.match(t.calls[0].text, /network:      ENABLED/); assert.match(t.calls[0].text, /npm install \| node --test/); assert.equal(runner.calls[0].network, true);
  const plain = await impl(root, { taskId: 't-scaffold', runner: implRunner(SCAFFOLD, ok(), { profile: { network: false } }) });
  assert.equal(plain.code, 'UNSAFE_PROFILE');
});

test('production Codex runner builds an explicit safe profile (no bypass, no MCP, read-only for review); exercised only through an injected spawn', async () => {
  for (const [role, network] of [['implement', false], ['implement', true], ['review', false]]) {
    const calls = []; const dir = H.fresh('rdir');
    const spawn = (bin, argv, opts) => { calls.push({ bin, argv, opts }); writeFileSync(argv[argv.indexOf('--output-last-message') + 1], '```json\n' + JSON.stringify(okResult([])) + '\n```'); return { status: 0, stdout: 'out', stderr: '' }; };
    const runner = codexRunner(role, { bin: 'codex-test-bin', spawn });
    const profile = assertSafeProfile(runner.describe({ network }), role, role === 'implement' ? network : false);
    assert.equal(profile.verified_against_real_binary, false);
    const out = await runner.run({ cwd: '/wt', prompt: 'PROMPT', runDir: dir, network });
    assert.equal(out.result.kind, 'result'); assert.equal(calls.length, 1);
    const { bin, argv, opts } = calls[0]; const line = argv.join(' ');
    assert.equal(bin, 'codex-test-bin'); assert.equal(opts.shell, false); assert.equal(opts.input, 'PROMPT'); assert.equal(opts.cwd, '/wt');
    assert.ok(argv.includes(role === 'implement' ? 'workspace-write' : 'read-only')); assert.ok(line.includes(`approval_policy="${role === 'implement' ? 'on-request' : 'never'}"`) && line.includes('mcp_servers={}')); assert.equal(profile.approval, role === 'implement' ? 'on-request' : 'never');
    assert.ok(!/bypass|yolo|danger|full-auto/i.test(line)); assert.equal(line.includes(`network_access=${network}`), role === 'implement');
    assert.ok(Object.keys(opts.env).every((k) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'].includes(k)), 'no foreign environment leaks');
  }
  assert.deepEqual(parseResult('noise {"a":1} tail'), { a: 1 }); assert.equal(parseResult('no json'), null);
  const failing = codexRunner('implement', { spawn: () => ({ status: 3, stdout: '', stderr: '' }) });
  await assert.rejects(failing.run({ cwd: '/wt', prompt: 'p', runDir: H.fresh('rdir2'), network: false }), /codex exited with 3/);
});

test('no provider probes: sdd-run only runs git and injected runners; no Codex/Cursor/Claude invocation, version/help probe, daemon or auto-publish exists in source; tripwires stayed silent', () => {
  const dir = join(REPO_ROOT, 'adapters/shared/sdd-run');
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn|exec)\(\s*['"`](codex|cursor|cursor-agent|claude)['"`]/, f);
    assert.doesNotMatch(src, /(codex|cursor|claude)[^\n]{0,30}(--version|--help|\s-V\b|-h\b)/i, f);
    assert.doesNotMatch(src, /['"`]push['"`]|['"`]merge['"`]|['"`]fetch['"`]|['"`]clone['"`]|git[^\n]{0,20}\b(gc|clean|reset|stash|checkout)\b[^\n]*\[/, `${f}: forbidden Git verbs`);
    assert.doesNotMatch(src, /\bsetInterval\b|detached:\s*true|\.unref\(\)|\bdaemon\b/i, f);
  }
  const runners = readFileSync(join(dir, 'runners.mjs'), 'utf8');
  assert.equal((runners.match(/\bspawn\(/g) ?? []).length, 1, 'exactly one process launch, inside the production runner');
  assert.doesNotMatch(readFileSync(join(dir, 'git.mjs'), 'utf8'), /'(push|merge|rebase|reset|clean|stash|checkout|tag|fetch|pull|clone)'/);
  assert.equal(existsSync(H.TRIPWIRE), false, 'tripwire codex/cursor binaries were never executed');
});
