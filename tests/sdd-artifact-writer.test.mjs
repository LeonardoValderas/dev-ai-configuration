import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, symlinkSync, linkSync, existsSync, readlinkSync, cpSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { plan, apply, verify, CONTRACT, WriterError } from '../adapters/shared/sdd-writer/writer.mjs';
import { validateConstitution, validateSpecify, assertAllowedPath, canonicalBytes, digestOf } from '../adapters/shared/sdd-writer/artifacts.mjs';
import { mintAuthorization, checkAuthorization, effectiveConfirmTimeoutMs, TTL_SECONDS, MAX_FUTURE_SKEW_SECONDS } from '../adapters/shared/sdd-writer/authorization.mjs';
import { processStart, ownerState } from '../adapters/shared/sdd-writer/lock.mjs';
import { generate as generateClaude } from '../adapters/claude-code/lib/generate.mjs';
import { generatePortable } from '../adapters/shared/portable.mjs';

const CLI = join(REPO_ROOT, 'adapters/shared/sdd-writer/cli.mjs');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-2jb-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (label = 't') => { const d = join(scratch, `${label}-${n++}`); mkdirSync(d); return d; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SRC = () => ({ head: 'a'.repeat(40) });
const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const PID = 'demo-project';

function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name); const r = rel ? `${rel}/${name}` : name; const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = sha(readFileSync(p));
    }
  };
  walk(root, '');
  return out;
}
const tty = (answer = true) => ({ calls: [], confirm(text, phrase) { this.calls.push({ text, phrase }); return typeof answer === 'function' ? answer(text, phrase) : answer; } });
const constitution = (o = {}) => ({ kind: 'sdd-constitution', schema_version: '1.0', project_id: PID, principles: [{ id: 'p-one', statement: 'Ship small, verified changes.' }, { id: 'p-two', statement: 'Never skip review.', rationale: 'Quality.' }], constraints: [{ id: 'c-one', statement: 'No secrets in the repository.' }], ...o });
const specify = (o = {}) => ({
  kind: 'sdd-specify', schema_version: '1.0', project_id: PID,
  requirements: [{ id: 'req-1', statement: 'Users can log in.', acceptance_criteria: ['ac-1', 'ac-2'], open_questions: [] }, { id: 'req-2', statement: 'Users can log out.', acceptance_criteria: ['ac-3'], open_questions: ['How long is the session?'] }],
  acceptance_criteria: [
    { id: 'ac-1', requirement: 'req-1', statement: 'Valid credentials open a session.', verification: 'integration test' },
    { id: 'ac-2', requirement: 'req-1', statement: 'Invalid credentials are rejected.', verification: 'integration test' },
    { id: 'ac-3', requirement: 'req-2', statement: 'Logout ends the session.', verification: 'e2e test' },
  ], ...o,
});
const input = (o = {}) => ({ project_id: PID, operation: 'create', constitution: constitution(), specify: specify(), ...o });
const run = (t, o = {}, extra = {}) => apply({ target: t, input: o.input ?? input(), source: SRC, terminal: tty(), clock: () => T0, random: () => 'ab'.repeat(16), ...extra });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const errOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const noSdd = (t) => assert.equal(existsSync(join(t, '.sdd')), false, '.sdd must not exist');

// ---- 1 --------------------------------------------------------------------------------------------
test('1. Constitution: valid and invalid', () => {
  assert.deepEqual(validateConstitution(constitution(), PID).errors, []);
  const bad = (doc, rule) => { const e = validateConstitution(doc, PID).errors; assert.ok(e.length, rule); if (rule) assert.ok(e.some((x) => x.rule === rule || x.code === rule), `${rule}: ${JSON.stringify(e)}`); };
  bad(constitution({ principles: [] }));
  bad(constitution({ kind: 'sdd-specify' }));
  bad(constitution({ extra: 1 }), 'SCHEMA_UNKNOWN_FIELD');
  bad(constitution({ project_id: 'other' }), 'project-mismatch');
  bad(constitution({ principles: [{ id: 'p-one', statement: '   ' }] }), 'text-blank');
  bad(constitution({ principles: [{ id: 'p-one', statement: 'a\u0000b' }] }), 'text-control-characters');
  bad(constitution({ principles: [{ id: 'Bad_Id', statement: 'x' }] }));
  bad(constitution({ principles: [{ id: 'p-one', statement: 'x' }], constraints: [{ id: 'p-one', statement: 'y' }] }), 'duplicate-id');
  const { constraints, ...missing } = constitution();
  bad(missing, 'SCHEMA_MISSING_FIELD');
});

// ---- 2 / 3 ----------------------------------------------------------------------------------------
test('2. Specify: valid and invalid', () => {
  const ok = validateSpecify(specify(), PID);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.summary, { requirements: 2, acceptance_criteria: 3, requirement_to_criterion_links: 3 });
  const bad = (doc, rule) => { const e = validateSpecify(doc, PID).errors; assert.ok(e.some((x) => x.rule === rule || x.code === rule), `${rule}: ${JSON.stringify(e)}`); };
  bad(specify({ requirements: [] }), 'schema');
  bad(specify({ kind: 'x' }), 'schema');
  bad(specify({ project_id: 'other' }), 'project-mismatch');
  const s = specify(); s.requirements[0].acceptance_criteria = []; bad(s, 'requirement-without-criterion');
  const s2 = specify(); s2.requirements[0].acceptance_criteria = ['ac-1', 'ac-2', 'ac-9']; bad(s2, 'broken-ref');
  const s3 = specify(); s3.acceptance_criteria[0].verification = ''; bad(s3, 'schema');
  const s4 = specify(); s4.requirements[0].acceptance_criteria = ['ac-1']; bad(s4, 'requirement-backlink');
  const s5 = specify(); s5.requirements[1].acceptance_criteria = ['ac-3', 'ac-1']; bad(s5, 'criterion-backlink');
});

test('3. duplicate ids and orphan criteria are rejected with zero writes', () => {
  const t = fresh();
  const dupReq = specify(); dupReq.requirements.push({ ...dupReq.requirements[0] });
  assert.ok(validateSpecify(dupReq, PID).errors.some((e) => e.rule === 'duplicate-id' && /requirement/.test(e.message)));
  const dupCrit = specify(); dupCrit.acceptance_criteria.push({ ...dupCrit.acceptance_criteria[0] });
  assert.ok(validateSpecify(dupCrit, PID).errors.some((e) => e.rule === 'duplicate-id' && /criterion/.test(e.message)));
  const orphan = specify(); orphan.acceptance_criteria.push({ id: 'ac-9', requirement: 'req-404', statement: 'x', verification: 'y' });
  assert.ok(validateSpecify(orphan, PID).errors.some((e) => e.rule === 'orphan-criterion'));
  const before = snapshot(t);
  for (const bad of [dupReq, dupCrit, orphan]) {
    const e = errOf(() => run(t, { input: input({ specify: bad }) }));
    assert.equal(e.code, 'VALIDATION'); assert.ok(e.details.errors.length);
    assert.equal(code(() => plan({ target: t, input: input({ specify: bad }), source: SRC })), 'VALIDATION');
  }
  assert.deepEqual(snapshot(t), before); noSdd(t);
});

// ---- 4 / 5 ----------------------------------------------------------------------------------------
const expectedFor = (a) => ({ plan_digest: a.plan_digest, target: a.target, operation: a.operation, project_id: a.project_id, prior_state: a.prior_state, standard_commit: a.standard_commit });
const samplePlan = () => ({ target: { realpath: '/x', device: '1', inode: '2' }, operation: 'create', project_id: PID, prior_state: { files: {}, receipts: { count: 0, latest_sha256: 'none' } }, standard_commit: 'a'.repeat(40) });

test('4. authorization TTL is exactly 600 s: valid before, expired at 600 and 601, other lifetimes rejected', () => {
  assert.equal(TTL_SECONDS, 600);
  const a = mintAuthorization(samplePlan(), 'd'.repeat(64), { nonce: 'ab'.repeat(16), nowMs: T0 });
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.issued_at), 600_000);
  const at = (ms) => checkAuthorization(a, expectedFor(a), T0 + ms).map((f) => f.code);
  assert.deepEqual(at(0), []);
  assert.deepEqual(at(599_999), []);
  assert.deepEqual(at(600_000), ['AUTH_EXPIRED']); // exactly at expires_at is expired
  assert.deepEqual(at(601_000), ['AUTH_EXPIRED']);
  for (const life of [599_000, 601_000, 1_200_000]) {
    const b = { ...a, expires_at: new Date(T0 + life).toISOString() };
    assert.ok(checkAuthorization(b, expectedFor(b), T0).some((f) => f.code === 'AUTH_TTL'), String(life));
  }
});

test('4b. apply: expiry is checked immediately before the first write (599 s ok, 600 s and 601 s refused, zero writes)', () => {
  for (const [jump, ok] of [[599_000, true], [600_000, false], [601_000, false]]) {
    const t = fresh(); let now = T0;
    const go = () => run(t, {}, { clock: () => now, hooks: { afterApproval: () => { now += jump; } } });
    if (ok) assert.equal(go().status, 'APPLIED');
    else { assert.equal(errOf(go).code, 'AUTH_EXPIRED'); noSdd(t); }
  }
});

test('5. 30 s future clock skew is tolerated, 31 s is not, and skew never extends expires_at', () => {
  assert.equal(MAX_FUTURE_SKEW_SECONDS, 30);
  const mk = (issuedAhead) => mintAuthorization(samplePlan(), 'd'.repeat(64), { nonce: 'ab'.repeat(16), nowMs: T0 + issuedAhead });
  const a30 = mk(30_000);
  assert.deepEqual(checkAuthorization(a30, expectedFor(a30), T0).map((f) => f.code), []);
  const a31 = mk(31_000);
  assert.deepEqual(checkAuthorization(a31, expectedFor(a31), T0).map((f) => f.code), ['AUTH_ISSUED_IN_FUTURE']);
  assert.equal(Date.parse(a30.expires_at), T0 + 30_000 + 600_000); // not moved by the tolerance
  assert.deepEqual(checkAuthorization(a30, expectedFor(a30), T0 + 629_999).map((f) => f.code), []);
  assert.deepEqual(checkAuthorization(a30, expectedFor(a30), T0 + 630_000).map((f) => f.code), ['AUTH_EXPIRED']);
  // in apply: the clock stepping back by 31 s after approval is refused with zero writes
  const t = fresh(); let now = T0;
  assert.equal(errOf(() => run(t, {}, { clock: () => now, hooks: { afterApproval: () => { now -= 31_000; } } })).code, 'AUTH_ISSUED_IN_FUTURE');
  noSdd(t);
  const t2 = fresh(); let now2 = T0;
  assert.equal(run(t2, {}, { clock: () => now2, hooks: { afterApproval: () => { now2 -= 30_000; } } }).status, 'APPLIED');
});

// ---- 6 --------------------------------------------------------------------------------------------
const cliRun = (args, { env = {}, stdin = '' } = {}) => new Promise((resolve) => {
  // detached => new session => no controlling terminal, so /dev/tty cannot be opened
  const c = spawn(process.execPath, [CLI, ...args], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.stdin.on('error', () => {}); c.stdin.end(stdin);
  c.on('close', (status) => resolve({ status, out, err }));
});

test('6. approval needs a trusted TTY: the CLI refuses --yes, env vars, stdin and files; the API refuses non-terminals', async () => {
  const t = fresh(); const f = join(fresh('in'), 'input.json');
  writeFileSync(f, JSON.stringify(input()));
  const before = snapshot(t);
  for (const flag of ['--yes', '-y', '--force', '--approve', '--authorization']) {
    const r = await cliRun(['apply', '--target', t, '--input', f, flag]);
    assert.equal(r.status, 2, flag); assert.match(r.err, /not supported/);
  }
  assert.equal((await cliRun(['apply', '--target', t, '--input', '-'])).status, 2);
  const r = await cliRun(['apply', '--target', t, '--input', f, '--json'], { env: { SDD_APPROVE: '1', DAC_YES: 'yes', CI: '1', APPROVED: 'true' }, stdin: 'approve yes\nyes\ny\n' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.out).code, 'TTY_REQUIRED');
  assert.deepEqual(JSON.parse(r.out).files_changed, []);
  assert.deepEqual(snapshot(t), before);
  // plan and verify never need a terminal and never write
  const p = await cliRun(['plan', '--target', t, '--input', f, '--json']);
  assert.ok([0, 1].includes(p.status)); assert.deepEqual(snapshot(t), before);
  // API: JSON/records/flags are not terminals
  for (const term of [{}, { confirm: 'yes' }, { isTTY: true }]) assert.equal(errOf(() => apply({ target: t, input: input(), source: SRC, terminal: term })).code, 'TTY_REQUIRED');
  assert.deepEqual(snapshot(t), before);
  // API: approval phrase is bound to digest and nonce; denial writes nothing
  const denied = tty(false);
  assert.equal(errOf(() => run(t, {}, { terminal: denied })).code, 'APPROVAL_DENIED');
  assert.match(denied.calls[0].phrase, /^approve [0-9a-f]{12} [0-9a-f]{8}$/);
  assert.deepEqual(snapshot(t), before); noSdd(t);
  const wrong = tty(() => 'yes');
  assert.equal(errOf(() => run(t, {}, { terminal: { confirm: () => false } })).code, 'APPROVAL_DENIED');
  assert.equal(wrong.calls.length, 0);
  const ok = tty((text, phrase) => { assert.match(text, new RegExp(plan({ target: t, input: input(), source: SRC }).plan_digest)); return phrase.startsWith('approve '); });
  assert.equal(run(t, {}, { terminal: ok }).status, 'APPLIED');
  assert.match(ok.calls[0].text, /expires_at/);
});

// ---- 7 --------------------------------------------------------------------------------------------
test('7. replay: a consumed nonce is refused, an identical re-apply is a no-op', () => {
  const t = fresh();
  const r1 = run(t);
  assert.equal(r1.status, 'APPLIED');
  const after1 = snapshot(t);
  assert.equal(run(t, { input: input({ operation: 'update' }) }).status, 'UNCHANGED');
  const changed = input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-one', statement: 'Changed.' }] }) });
  const e = errOf(() => run(t, { input: changed })); // same nonce source => replay
  assert.equal(e.code, 'AUTH_REPLAYED');
  assert.deepEqual(snapshot(t), after1);
  assert.equal(run(t, { input: changed }, { random: () => 'cd'.repeat(16) }).status, 'APPLIED'); // fresh nonce works
  assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
  assert.equal(readdirSync(join(t, '.sdd/consumed', PID)).length, 2);
});

// ---- 8 --------------------------------------------------------------------------------------------
test('8. altered plan, altered authorization and drift fail closed with zero writes', () => {
  const bound = ['plan_digest', 'target', 'operation', 'project_id', 'prior_state', 'standard_commit'];
  const a = mintAuthorization(samplePlan(), 'd'.repeat(64), { nonce: 'ab'.repeat(16), nowMs: T0 });
  for (const k of bound) {
    const exp = { ...expectedFor(a), [k]: k === 'target' ? { realpath: '/y' } : k === 'prior_state' ? { files: { x: 'missing' } } : 'changed' };
    assert.ok(checkAuthorization(a, exp, T0).some((f) => f.code === 'AUTH_MISMATCH' && f.message.includes(k)), k);
  }
  assert.ok(checkAuthorization({ ...a, extra: 1 }, expectedFor(a), T0).some((f) => f.code === 'AUTH_MALFORMED'));
  assert.ok(checkAuthorization({ ...a, nonce: 'zz' }, expectedFor(a), T0).some((f) => f.code === 'AUTH_MALFORMED'));

  const t = fresh();
  assert.equal(errOf(() => run(t, {}, { hooks: { afterApproval: (x) => { x.plan_digest = 'e'.repeat(64); } } })).code, 'AUTH_ALTERED');
  assert.equal(errOf(() => run(t, {}, { hooks: { afterApproval: (x) => { x.operation = 'update'; } } })).code, 'AUTH_ALTERED');
  noSdd(t);
  // drift of a missing file (create) between approval and the first write
  const t2 = fresh();
  const inject = () => { mkdirSync(join(t2, '.sdd/artifacts', PID), { recursive: true }); writeFileSync(join(t2, '.sdd/artifacts', PID, 'constitution.json'), '{}'); };
  assert.equal(errOf(() => run(t2, {}, { hooks: { beforeFirstWrite: inject } })).code, 'DRIFT');
  assert.equal(readFileSync(join(t2, '.sdd/artifacts', PID, 'constitution.json'), 'utf8'), '{}');
  assert.equal(existsSync(join(t2, '.sdd/receipts')), false); assert.equal(existsSync(join(t2, '.sdd/consumed')), false); assert.equal(existsSync(join(t2, '.sdd/locks')), false);
  // drift of an existing file (update)
  const t3 = fresh(); run(t3);
  const upd = input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-one', statement: 'Changed.' }] }) });
  const target = join(t3, '.sdd/artifacts', PID, 'specify.json');
  const before = snapshot(t3); let tampered;
  const e = errOf(() => run(t3, { input: upd }, { random: () => 'cd'.repeat(16), hooks: { beforeFirstWrite: () => { writeFileSync(target, 'tampered'); tampered = snapshot(t3); } } }));
  const noLock = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('.sdd/locks')));
  assert.equal(e.code, 'DRIFT'); assert.deepEqual(snapshot(t3), noLock(tampered)); assert.notDeepEqual(before, noLock(tampered));
  // plan changes between the first computation and the lock
  const t4 = fresh(); let first = true;
  const drifting = () => { if (first) { first = false; return SRC(); } return { head: 'b'.repeat(40) }; };
  assert.equal(errOf(() => apply({ target: t4, input: input(), source: drifting, terminal: tty(), clock: () => T0 })).code, 'DRIFT');
  noSdd(t4);
});

// ---- 9 --------------------------------------------------------------------------------------------
test('9. path policy: allowlist, traversal, absolute, aliases, symlinks, non-regular files', () => {
  for (const p of [`.sdd/artifacts/${PID}/constitution.json`, `.sdd/artifacts/${PID}/specify.md`, `.sdd/receipts/${PID}/000001-0123456789ab.json`, `.sdd/consumed/${PID}/${'a'.repeat(32)}.json`]) assert.equal(assertAllowedPath(p, PID), p);
  const bad = [
    '/etc/passwd', '/.sdd/artifacts/x', 'C:/x', '~/x', '../x', `.sdd/artifacts/${PID}/../../../x`, `.sdd//artifacts/${PID}/constitution.json`, `./.sdd/artifacts/${PID}/constitution.json`, `.sdd\\artifacts\\${PID}\\constitution.json`,
    `.SDD/artifacts/${PID}/constitution.json`, `.sdd/Artifacts/${PID}/constitution.json`, `.sdd/artifacts/${PID}/Constitution.json`, `.sdd/artifacts/${PID.toUpperCase()}/constitution.json`,
    `.sdd/artifacts/${PID}/constitution.json `, `.sdd/artifacts/${PID}/constitution.json\u0000`, `.sdd/artifacts/\uff50roject/constitution.json`, `.sdd/artifacts/${PID}/constitutio\u0301n.json`,
    '.dac/standard.json', '.dac/shared.json', '.git/config', '.specify/x.md', 'specs/x.md', '.github/workflows/ci.yml', '.claude/settings.json', 'package.json', 'src/index.js', 'run.sh',
    `.sdd/artifacts/${PID}/plan.json`, `.sdd/artifacts/${PID}/constitution.mjs`, `.sdd/artifacts/${PID}/evil.sh`, `.sdd/artifacts/other-project/constitution.json`, `.sdd/artifacts/${PID}`, '.sdd', '', null, 42,
  ];
  for (const p of bad) assert.equal(code(() => assertAllowedPath(p, PID)), 'PATH_POLICY', String(p));
  assert.equal(code(() => assertAllowedPath(`.sdd/artifacts/x/constitution.json`, '../x')), 'PATH_POLICY');

  const fail = (setup, label) => {
    const t = fresh(); const outside = fresh('out'); setup(t, outside);
    const before = snapshot(t); const beforeOut = snapshot(outside);
    assert.equal(errOf(() => run(t)).code, 'PATH_POLICY', label);
    assert.equal(code(() => plan({ target: t, input: input(), source: SRC })), 'PATH_POLICY', label);
    assert.deepEqual(snapshot(t), before, label); assert.deepEqual(snapshot(outside), beforeOut, label);
  };
  fail((t, o) => symlinkSync(o, join(t, '.sdd')), '.sdd symlink');
  fail((t, o) => { mkdirSync(join(t, '.sdd')); symlinkSync(o, join(t, '.sdd/artifacts')); }, 'artifacts dir symlink');
  fail((t, o) => { mkdirSync(join(t, '.sdd/artifacts'), { recursive: true }); symlinkSync(o, join(t, '.sdd/artifacts', PID)); }, 'project dir symlink');
  fail((t, o) => { mkdirSync(join(t, '.sdd/artifacts', PID), { recursive: true }); writeFileSync(join(o, 'x'), 'x'); symlinkSync(join(o, 'x'), join(t, '.sdd/artifacts', PID, 'constitution.json')); }, 'file symlink');
  fail((t) => { mkdirSync(join(t, '.sdd/artifacts', PID, 'constitution.json'), { recursive: true }); }, 'directory in place of file');
  fail((t, o) => { mkdirSync(join(t, '.sdd/artifacts', PID), { recursive: true }); writeFileSync(join(o, 'x'), '{}'); linkSync(join(o, 'x'), join(t, '.sdd/artifacts', PID, 'constitution.json')); }, 'hard link');
  fail((t) => { writeFileSync(join(t, '.sdd'), 'file'); }, '.sdd is a file');
  fail((t) => mkdirSync(join(t, '.SDD')), 'case alias of .sdd');
  fail((t) => mkdirSync(join(t, '.sdd/Artifacts'), { recursive: true }), 'case alias of artifacts');
  fail((t) => mkdirSync(join(t, '.sdd/artifacts', 'DEMO-PROJECT'), { recursive: true }), 'case alias of project');
  fail((t) => mkdirSync(join(t, '.sdd/artifacts', '\uff44emo-project'), { recursive: true }), 'unicode alias of project');
  fail((t) => { mkdirSync(join(t, '.sdd/artifacts', PID), { recursive: true }); writeFileSync(join(t, '.sdd/artifacts', PID, 'Constitution.JSON'), '{}'); }, 'case alias of file');
  fail((t, o) => { mkdirSync(join(t, '.sdd/receipts'), { recursive: true }); symlinkSync(o, join(t, '.sdd/receipts', PID)); }, 'receipt store symlink');
  // a target that is itself a symlink or relative is refused by the shared target resolver
  const real = fresh(); const link = join(fresh('l'), 'link'); symlinkSync(real, link);
  assert.equal(errOf(() => run(link)).code, 'TARGET');
  assert.equal(errOf(() => run('relative/path')).code, 'TARGET');
});

// ---- 10 -------------------------------------------------------------------------------------------
const lockFile = (t) => join(t, '.sdd/locks', `${PID}.lock`);
const deadPid = () => { const c = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']); return Number(c.stdout.toString()); };
const writeLock = (t, o = {}) => {
  mkdirSync(join(t, '.sdd/locks'), { recursive: true });
  const info = { token: 'f'.repeat(32), pid: deadPid(), host: hostname(), process_start: 'Mon Jan  1 00:00:00 2026', project_id: PID, target: { realpath: t, device: '1', inode: '1' }, created_at: '2026-01-01T00:00:00.000Z', ...o };
  writeFileSync(lockFile(t), JSON.stringify(info)); return info;
};

test('10. exclusive lock: concurrency is refused, aged/foreign locks are never removed, recovery needs a dead owner and a terminal', () => {
  // concurrent apply from inside a held lock
  const t = fresh(); let inner;
  const r = run(t, {}, { hooks: { afterLock: () => { assert.ok(existsSync(lockFile(t))); inner = errOf(() => run(t, {}, { random: () => 'cd'.repeat(16) })); } } });
  assert.equal(r.status, 'APPLIED'); assert.equal(inner.code, 'LOCKED');
  assert.equal(existsSync(join(t, '.sdd/locks')), false, 'lock released and its directory pruned');
  // lock released after a failure as well
  const t1 = fresh();
  assert.equal(errOf(() => run(t1, {}, { terminal: tty(false) })).code, 'APPROVAL_DENIED'); noSdd(t1);

  // aged stale lock is never removed without recovery
  const t2 = fresh(); writeLock(t2); utimesSync(lockFile(t2), new Date('2000-01-01'), new Date('2000-01-01'));
  const snap2 = snapshot(t2);
  assert.equal(errOf(() => run(t2)).code, 'LOCKED'); assert.deepEqual(snapshot(t2), snap2);
  // recovery needs the terminal confirmation
  assert.equal(errOf(() => run(t2, {}, { recoverLock: true, terminal: tty((x, p) => (p.startsWith('recover ') ? false : true)) })).code, 'LOCK_RECOVERY_REFUSED');
  assert.deepEqual(snapshot(t2), snap2);
  // recovery with a dead owner and confirmation
  const term = tty(true);
  const ok = run(t2, {}, { recoverLock: true, terminal: term });
  assert.equal(ok.status, 'APPLIED'); assert.equal(ok.recovery.removed_token, 'f'.repeat(32));
  assert.match(term.calls[0].phrase, /^recover ffffffff$/);
  assert.equal(existsSync(lockFile(t2)), false);

  // live owner (same pid and start time) is never recovered
  const t3 = fresh(); writeLock(t3, { pid: process.pid, process_start: processStart(process.pid) });
  const snap3 = snapshot(t3);
  assert.equal(errOf(() => run(t3, {}, { recoverLock: true })).code, 'LOCK_RECOVERY_REFUSED'); assert.deepEqual(snapshot(t3), snap3);
  // other host, unreadable lock, unverifiable start time are refused
  for (const o of [{ host: `${hostname()}-other` }, { process_start: null }]) {
    const tt = fresh(); writeLock(tt, o); const s = snapshot(tt);
    assert.equal(errOf(() => run(tt, {}, { recoverLock: true })).code, 'LOCK_RECOVERY_REFUSED'); assert.deepEqual(snapshot(tt), s);
  }
  const t4 = fresh(); mkdirSync(join(t4, '.sdd/locks'), { recursive: true }); writeFileSync(lockFile(t4), 'garbage');
  assert.equal(errOf(() => run(t4, {}, { recoverLock: true })).code, 'LOCK_RECOVERY_REFUSED'); assert.equal(readFileSync(lockFile(t4), 'utf8'), 'garbage');
  // token changes between confirmation and removal => refused, lock kept
  const t5 = fresh(); writeLock(t5);
  const e5 = errOf(() => run(t5, {}, { recoverLock: true, hooks: { beforeLockRemoval: () => writeLock(t5, { token: '1'.repeat(32) }) } }));
  assert.equal(e5.code, 'LOCK_RECOVERY_REFUSED'); assert.equal(JSON.parse(readFileSync(lockFile(t5), 'utf8')).token, '1'.repeat(32));
  // recovery that leaves an unverifiable target does not proceed to write
  const t6 = fresh(); writeLock(t6); writeFileSync(join(t6, '.sdd/locks/x.dac-tmp-1'), 'leftover');
  assert.equal(errOf(() => run(t6, {}, { recoverLock: true })).code, 'RECOVERY_STATE_UNVERIFIED');
  assert.equal(existsSync(join(t6, '.sdd/artifacts')), false);
});

// ---- 11 -------------------------------------------------------------------------------------------
test('11. partial failure rolls back completely; rollback failures and verification failures are reported honestly', () => {
  for (const fault of [1, 2, 3, 4]) {
    const t = fresh(); const e = errOf(() => run(t, {}, { faultAfter: fault }));
    assert.equal(e.code, 'APPLY_FAILED'); assert.equal(e.details.rollback.status, 'clean'); assert.deepEqual(e.details.files_changed, []);
    noSdd(t); assert.deepEqual(snapshot(t), {});
  }
  // update: prior bytes restored byte-for-byte
  const t = fresh(); run(t);
  const base = snapshot(t);
  const upd = input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-one', statement: 'Changed.' }] }), markdown: true });
  const e = errOf(() => run(t, { input: upd }, { random: () => 'cd'.repeat(16), faultAfter: 3 }));
  assert.equal(e.code, 'APPLY_FAILED'); assert.deepEqual(snapshot(t), base);
  // post-write verification failure (disk differs from the plan) => rolled back with evidence
  const t2 = fresh();
  const e2 = errOf(() => run(t2, {}, { hooks: { duringVerify: (root) => writeFileSync(join(root, '.sdd/artifacts', PID, 'specify.json'), 'corrupted') } }));
  assert.equal(e2.code, 'VERIFY_FAILED'); assert.equal(e2.details.rollback.status, 'clean');
  assert.match(e2.details.evidence.path, /specify\.json$/); assert.ok(e2.details.evidence.expected_sha256); assert.ok(e2.details.evidence.observed);
  noSdd(t2);
  // rollback failure: a written file is replaced by a directory, so it cannot be restored
  const t3 = fresh();
  const e3 = errOf(() => run(t3, {}, { hooks: { duringVerify: (root) => { const p = join(root, '.sdd/artifacts', PID, 'constitution.json'); rmSync(p); mkdirSync(p); } } }));
  assert.equal(e3.code, 'VERIFY_FAILED'); assert.equal(e3.details.rollback.status, 'failed');
  assert.ok(e3.details.rollback.failed_paths.includes(`.sdd/artifacts/${PID}/constitution.json`));
  assert.deepEqual(e3.details.files_changed, e3.details.rollback.failed_paths);
  assert.match(e3.details.message_detail, /rollback was incomplete/);
});

// ---- 12 / 13 --------------------------------------------------------------------------------------
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...a], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function bootstrapSource() {
  const dir = fresh('src');
  for (const f of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    if (!existsSync(join(REPO_ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(REPO_ROOT, f), join(dir, f));
  }
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  const api = await import(pathToFileURL(join(dir, 'installer/bootstrap.mjs')).href);
  return { dir, api, change: (file, fn) => { writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8'))); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change'); } };
}
const sub = (snap, prefix) => Object.fromEntries(Object.entries(snap).filter(([k]) => k === prefix || k.startsWith(`${prefix}/`)));

test('12. bootstrap apply, update and uninstall preserve a populated .sdd/ byte for byte; 13. .dac/ is bootstrap-owned and never touched by the writer', async () => {
  const s = await bootstrapSource(); const t = fresh('proj');
  s.api.apply({ target: t, providers: ['claude-code', 'codex'] });
  const dac0 = sub(snapshot(t), '.dac'); assert.ok(dac0['.dac/standard.json']);
  // the writer persists into the bootstrapped project
  const w = run(t, { input: input({ markdown: true }) });
  assert.ok(w.files_changed.every((p) => p.startsWith('.sdd/')));
  assert.deepEqual(sub(snapshot(t), '.dac'), dac0, 'writer never touches .dac');
  assert.equal(code(() => assertAllowedPath('.dac/standard.json', PID)), 'PATH_POLICY');
  const sdd0 = sub(snapshot(t), '.sdd'); assert.ok(Object.keys(sdd0).length > 8);
  // update (with a changed standard commit and version), apply of another provider, uninstall of each provider
  s.change('standards/sdd/sdd-workflow.json', (x) => x.replace(/"objective": "/, '"objective": "Updated: '));
  assert.equal(s.api.update({ target: t }).status, 'APPLIED');
  assert.deepEqual(sub(snapshot(t), '.sdd'), sdd0);
  s.api.apply({ target: t, providers: ['cursor'] });
  assert.deepEqual(sub(snapshot(t), '.sdd'), sdd0);
  for (const p of ['cursor', 'codex', 'claude-code']) { s.api.uninstall({ target: t, provider: p }); assert.deepEqual(sub(snapshot(t), '.sdd'), sdd0, `after uninstall ${p}`); }
  // rollback of a failed bootstrap leaves .sdd untouched too
  assert.throws(() => s.api.apply({ target: t, providers: ['codex'], faultAfter: 2 }));
  assert.deepEqual(sub(snapshot(t), '.sdd'), sdd0);
  // the writer still verifies its own state after all of that
  assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
});

// ---- 14 -------------------------------------------------------------------------------------------
test('14. receipts are verifiable: hashes, chain, exact files_changed, tamper detection', () => {
  const t = fresh();
  const r1 = run(t, { input: input({ markdown: true }) });
  assert.equal(r1.sequence, 1);
  const rp = join(t, r1.receipt); const rc = JSON.parse(readFileSync(rp, 'utf8'));
  assert.deepEqual(rc.files_changed, r1.files_changed); // exact, as reported by the operation
  assert.deepEqual([...r1.files_changed].sort(), [...r1.files_changed]);
  assert.equal(r1.files_changed.length, 4 + 2); // 2 json + 2 md + receipt + marker
  assert.equal(rc.plan_digest, digestOf(rc.plan)); assert.equal(rc.previous_receipt_sha256, 'none');
  assert.equal(rc.authorization.ttl_seconds, 600); assert.equal(rc.authorization.approval.channel, 'trusted-tty');
  for (const f of rc.files) assert.equal(f.after_sha256, sha(readFileSync(join(t, f.path))));
  assert.ok(canonicalBytes(rc).equals(readFileSync(rp)));
  assert.equal(JSON.parse(readFileSync(join(t, rc.consumed_marker), 'utf8')).plan_digest, rc.plan_digest);
  assert.deepEqual(verify({ target: t, projectId: PID }), { status: 'OK', findings: [], files_checked: 6, files_changed: [] });
  // second receipt chains to the first; unchanged files are listed but not reported as changed
  const r2 = run(t, { input: input({ operation: 'update', markdown: true, constitution: constitution({ principles: [{ id: 'p-one', statement: 'Changed.' }] }) }) }, { random: () => 'cd'.repeat(16) });
  assert.equal(r2.sequence, 2);
  assert.equal(JSON.parse(readFileSync(join(t, r2.receipt), 'utf8')).previous_receipt_sha256, sha(readFileSync(rp)));
  assert.equal(r2.files_changed.filter((p) => p.includes('specify')).length, 0);
  assert.equal(r2.files_changed.length, 2 + 2 + 0); // constitution.json + constitution.md + receipt + marker
  assert.equal(verify({ target: t, projectId: PID }).status, 'OK');

  const kinds = (mut) => { const c = fresh(); cpSync(t, c, { recursive: true }); mut(c); return verify({ target: c, projectId: PID }).findings.map((f) => `${f.kind}:${f.path.split('/').at(-1)}`).sort(); };
  const art = (c, f) => join(c, '.sdd/artifacts', PID, f);
  assert.ok(kinds((c) => writeFileSync(art(c, 'constitution.json'), canonicalBytes({ ...constitution(), principles: [{ id: 'p-x', statement: 'Evil.' }] }))).some((k) => k.startsWith('modified:constitution.json')));
  assert.ok(kinds((c) => writeFileSync(art(c, 'specify.md'), 'hand edit')).some((k) => k.startsWith('modified:specify.md')));
  assert.ok(kinds((c) => rmSync(art(c, 'specify.json'))).some((k) => k.startsWith('missing:specify.json')));
  assert.ok(kinds((c) => writeFileSync(art(c, 'specify.json'), '{ not json')).some((k) => k.startsWith('artifact:specify.json')));
  assert.ok(kinds((c) => { const p = join(c, r1.receipt); writeFileSync(p, readFileSync(p, 'utf8').replace('"sequence": 1', '"sequence": 7')); }).some((k) => k.startsWith('receipt:')));
  assert.ok(kinds((c) => { const p = join(c, r2.receipt); const j = JSON.parse(readFileSync(p, 'utf8')); j.previous_receipt_sha256 = 'f'.repeat(64); j.receipt_digest = digestOf({ ...j, receipt_digest: undefined }); writeFileSync(p, canonicalBytes(j)); }).some((k) => k.startsWith('receipt:')));
  assert.ok(kinds((c) => rmSync(join(c, r2.consumed_marker))).some((k) => k.startsWith('consumed:')));
  assert.ok(kinds((c) => writeFileSync(join(c, `.sdd/consumed/${PID}/${'9'.repeat(32)}.json`), '{}')).some((k) => k.startsWith('consumed:')));
  assert.ok(kinds((c) => writeFileSync(art(c, 'constitution.json.dac-tmp-123'), 'x')).some((k) => k.startsWith('leftover:')));
  assert.ok(kinds((c) => rmSync(join(c, '.sdd/receipts'), { recursive: true })).some((k) => k.startsWith('unreceipted:')));
  assert.ok(kinds((c) => writeLock(c)).some((k) => k.startsWith('lock:')));
  assert.ok(kinds((c) => symlinkSync('/tmp', join(c, '.sdd/stray'))).some((k) => k.startsWith('symlink:')));
  // verify performs zero writes
  const before = snapshot(t); verify({ target: t, projectId: PID }); assert.deepEqual(snapshot(t), before);
});

// ---- 15 -------------------------------------------------------------------------------------------
test('15. every preflight failure writes nothing (no .sdd, no lock, no temp files)', async () => {
  const cases = [
    ['unknown input field', input({ extra: 1 })],
    ['bad project id', input({ project_id: '../etc' })],
    ['bad operation', input({ operation: 'delete' })],
    ['no artifacts', { project_id: PID, operation: 'create' }],
    ['bad markdown flag', input({ markdown: 'yes' })],
    ['invalid constitution', input({ constitution: constitution({ principles: [] }) })],
    ['project mismatch', input({ specify: specify({ project_id: 'other' }) })],
    ['oversized artifact', input({ constitution: constitution({ principles: [{ id: 'p-one', statement: 'x'.repeat(4000) }, ...Array.from({ length: 199 }, (_, i) => ({ id: `p-${i}`, statement: 'y'.repeat(4000) }))] }) })],
    ['update of missing artifacts', input({ operation: 'update' })],
  ];
  for (const [label, inp] of cases) {
    const t = fresh(); const before = snapshot(t);
    assert.ok(errOf(() => run(t, { input: inp })), label);
    assert.ok(errOf(() => plan({ target: t, input: inp, source: SRC })), label);
    assert.deepEqual(snapshot(t), before, label);
  }
  const t = fresh(); run(t);
  assert.equal(errOf(() => run(t, { input: input() }, { random: () => 'cd'.repeat(16) })).code, 'OPERATION_MISMATCH'); // create over existing
  assert.equal(errOf(() => run(t, { input: input({ constitution: undefined, specify: undefined }) })).code, 'INPUT');
  assert.equal(errOf(() => run(t, {}, { source: () => ({ head: 'nothex' }) })).code, 'STANDARD_SOURCE');
  assert.equal(errOf(() => run(t, {}, { source: () => { throw new WriterError('SOURCE_DIRTY', 'dirty'); } })).code, 'SOURCE_DIRTY');
  const s = snapshot(t); assert.ok(errOf(() => run(t, { input: input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-one', statement: 'Changed.' }] }) }) }, { random: () => 'cd'.repeat(16), source: () => ({ head: 'nothex' }) }))); assert.deepEqual(snapshot(t), s);
  // stale temp / unexpected receipts block applying instead of being ignored
  mkdirSync(join(t, '.sdd/receipts', PID), { recursive: true }); writeFileSync(join(t, '.sdd/receipts', PID, 'junk.json'), '{}');
  const s2 = snapshot(t); assert.equal(errOf(() => run(t, { input: input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-one', statement: 'C2.' }] }) }) }, { random: () => 'ee'.repeat(16) })).code, 'STATE_UNVERIFIED'); assert.deepEqual(snapshot(t), s2);
  // plan never writes and reports what would change
  const t2 = fresh(); const p = plan({ target: t2, input: input({ markdown: true }), source: SRC });
  assert.equal(p.status, 'PLANNED'); assert.equal(p.authorization_required, true); assert.equal(p.would_write.length, 4); assert.deepEqual(p.files_changed, []);
  assert.deepEqual(snapshot(t2), {});
});

// ---- 16 -------------------------------------------------------------------------------------------
test('16. provider-neutral contract: identical for Claude Code, Codex and Cursor; no agent gains write', () => {
  assert.deepEqual(CONTRACT, { version: 1, operations: ['plan', 'apply', 'verify'], artifacts: ['constitution', 'specify', 'project'], storage_root: '.sdd', gate: 'sdd-artifact-write', approval: 'trusted-tty', ttl_seconds: 600, max_future_skew_seconds: 30, markdown_default: false });
  assert.ok(Object.isFrozen(CONTRACT));
  for (const f of ['writer', 'artifacts', 'authorization', 'lock', 'cli']) assert.doesNotMatch(readFileSync(join(REPO_ROOT, `adapters/shared/sdd-writer/${f}.mjs`), 'utf8'), /claude|codex|cursor/i, f);
  // same inputs => same plan digest no matter which provider drives it
  const t = fresh();
  const digests = ['claude-code', 'codex', 'cursor'].map((provider) => plan({ target: t, input: input(), source: SRC, provider }).plan_digest);
  assert.equal(new Set(digests).size, 1);
  assert.equal(spawnSync(process.execPath, [CLI, 'plan', '--target', t, '--input', '/dev/null', '--provider', 'codex']).status, 2);
  // the gate and the narrowed pre-implementation wording reach every provider unchanged
  const line = (text) => text.toString().split('\n').filter((l) => /^- (sdd-artifact-write|pre-implementation):/.test(l)).join('\n');
  const claude = line(generateClaude().files.get('.claude/rules/dac-sdd.md'));
  assert.match(claude, /sdd-artifact-write: blocks Persisting managed SDD documentation/);
  assert.doesNotMatch(claude, /any file change/);
  for (const p of ['codex', 'cursor']) assert.equal(line(generatePortable(p).files.get('AGENTS.md')), claude, p);
  // permissions: reviewers and specialists stay read-only; the writer is not an agent
  const rev = JSON.parse(readFileSync(join(REPO_ROOT, 'standards/manifests/agents/code-reviewer.json'), 'utf8'));
  assert.ok(!rev.permissions.tools.some((x) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(x)));
  const map = JSON.parse(readFileSync(join(REPO_ROOT, 'standards/sdd/sdd-agent-map.json'), 'utf8'));
  assert.equal(map.agents.find((a) => a.agent === 'code-reviewer').may_implement, false);
  assert.doesNotMatch(JSON.stringify(map), /sdd-artifact-write|sdd-writer/);
});

test('sdd-project files_changed is never populated by the writer and the shared executor keeps one engine', () => {
  const src = ['writer', 'artifacts', 'authorization', 'lock', 'cli'].map((f) => readFileSync(join(REPO_ROOT, `adapters/shared/sdd-writer/${f}.mjs`), 'utf8')).join('\n');
  assert.match(src, /documentation-only/); // the persisted project artifact can never claim changed files, approvals or started work
  assert.match(readFileSync(join(REPO_ROOT, 'adapters/shared/sdd-writer/writer.mjs'), 'utf8'), /executeActions\(root, actions/);
  assert.doesNotMatch(src, /\b(renameSync|copyFileSync|rmSync|appendFileSync)\b/); // no private mutation engine
  assert.doesNotMatch(src, /op: 'remove'/);
  // the writer module itself performs no direct filesystem mutation; only lock.mjs manages the lock file
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, 'adapters/shared/sdd-writer/writer.mjs'), 'utf8'), /\b(writeFileSync|unlinkSync|mkdirSync|rmdirSync)\(/);
});

// ---- 2J-B hardening: real multi-process concurrency ---------------------------------------------------
const PROC = join(REPO_ROOT, 'tests/support/sdd-writer-proc.mjs');
function child(args) {
  const p = spawn(process.execPath, [PROC, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res) => p.on('close', (c) => res({ exit: c, out: out.trim() ? JSON.parse(out.trim().split('\n').pop()) : null, err })));
  return { p, done };
}
const waitFor = async (f, ms = 20000) => { const end = Date.now() + ms; while (!existsSync(f)) { if (Date.now() > end) throw new Error(`timeout waiting for ${f}`); await new Promise((r) => setTimeout(r, 15)); } };

test('17. real processes: exactly one acquires the lock, the other is BLOCKED with no writes; release then reacquire', async () => {
  const t = fresh('mp'); const ctl = fresh('ctl');
  const inA = join(ctl, 'a.json'); const inB = join(ctl, 'b.json'); const inC = join(ctl, 'c.json');
  const ready = join(ctl, 'ready'); const go = join(ctl, 'go');
  writeFileSync(inA, JSON.stringify(input()));
  writeFileSync(inB, JSON.stringify(input({ constitution: constitution({ principles: [{ id: 'p-evil', statement: 'Competing writer.' }] }) })));
  const A = child([t, inA, ready, go, 'a']);
  await waitFor(ready); // A holds the lock and is waiting for its human
  const lockFile1 = join(t, '.sdd/locks', `${PID}.lock`);
  const lockBefore = readFileSync(lockFile1, 'utf8');
  assert.equal(JSON.parse(lockBefore).pid, A.p.pid);
  const before = snapshot(t);
  assert.deepEqual(Object.keys(before).filter((k) => !k.startsWith('.sdd/locks') && k !== '.sdd'), [], 'A has written nothing but its lock yet');

  const B = await child([t, inB, '-', '-', 'b']).done; // independent OS process, same target and project
  assert.equal(B.out.status, 'BLOCKED'); assert.equal(B.out.code, 'LOCKED'); assert.notEqual(B.out.pid, A.p.pid);
  assert.deepEqual(snapshot(t), before, 'the blocked process changed nothing');
  assert.equal(readFileSync(lockFile1, 'utf8'), lockBefore, "A's lock is untouched");

  writeFileSync(go, 'go');
  const ra = await A.done;
  assert.equal(ra.out.status, 'APPLIED', JSON.stringify(ra));
  assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
  const art = JSON.parse(readFileSync(join(t, `.sdd/artifacts/${PID}/constitution.json`), 'utf8'));
  assert.deepEqual(art.principles.map((x) => x.id), ['p-one', 'p-two'], "only A's content was written");
  assert.equal(existsSync(join(t, '.sdd/locks')), false, 'lock released and pruned');
  assert.equal(readdirSync(join(t, `.sdd/receipts/${PID}`)).length, 1, 'exactly one receipt');

  // reacquire: a new process now wins the lock
  writeFileSync(inC, JSON.stringify(input({ operation: 'update', constitution: constitution({ principles: [{ id: 'p-new', statement: 'Reacquired.' }] }) })));
  const C = await child([t, inC, '-', '-', 'c']).done;
  assert.equal(C.out.status, 'APPLIED', C.err);
  assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
  assert.equal(readdirSync(join(t, `.sdd/receipts/${PID}`)).length, 2);
});

// ---- 2J-B hardening: confirmation timeout (controlled clock) ------------------------------------------
test('18. confirmation timeout = min(configured, remaining to expires_at); skew never extends it', () => {
  const auth = mintAuthorization({ target: 't', operation: 'create', project_id: PID, prior_state: {}, standard_commit: 'a'.repeat(40) }, 'd'.repeat(64), { nonce: 'ab'.repeat(16), nowMs: T0 });
  assert.equal(effectiveConfirmTimeoutMs(auth, T0, 120000), 120000);
  assert.equal(effectiveConfirmTimeoutMs(auth, T0, 900000), 600000, 'capped by the 600 s lifetime');
  assert.equal(effectiveConfirmTimeoutMs(auth, T0 + 595000, 120000), 5000, 'remaining wins');
  assert.equal(effectiveConfirmTimeoutMs(auth, T0 + 600000, 120000), 0);
  assert.ok(effectiveConfirmTimeoutMs(auth, T0 + 601000, 120000) < 0);
  assert.equal(effectiveConfirmTimeoutMs(auth, T0 - 30000, 120000), 120000, 'a clock 30 s behind never lifts the timeout above the configured value');
  assert.equal(effectiveConfirmTimeoutMs(auth, T0, 0), 0); assert.equal(effectiveConfirmTimeoutMs(auth, T0, NaN), 0);
});

// A clock that stays at T0 until the authorization is minted, then jumps `jumpMs` forward.
const jumpClock = (jumpMs) => { let armed = false; let minted = false; return { random: () => { armed = true; return 'ab'.repeat(16); }, clock: () => { if (armed && !minted) { minted = true; return T0; } return minted ? T0 + jumpMs : T0; } }; };
const timeoutTerm = (log) => ({ closed: 0, confirm(text, phrase, o) { log.push(o.timeoutMs); const e = new Error('timeout'); e.code = 'APPROVAL_TIMEOUT'; throw e; }, close() { this.closed++; } });

test('19. apply: effective timeout passed to the terminal is min(configured, remaining); expiry is never extended', () => {
  for (const [jump, configured, expected] of [[0, 120000, 120000], [0, 900000, 600000], [595000, 120000, 5000], [590000, 5000, 5000], [599999, 120000, 1]]) {
    const t = fresh(); const seen = []; const c = jumpClock(jump);
    const e = errOf(() => run(t, {}, { terminal: timeoutTerm(seen), confirmTimeoutMs: configured, random: c.random, clock: c.clock }));
    assert.equal(e.code, 'APPROVAL_TIMEOUT'); assert.deepEqual(seen, [expected], `jump ${jump} configured ${configured}`);
  }
  // 30 s skew never adds time: an authorization issued 'in the future' by a clock that then moves back still ends at expires_at
  const auth = mintAuthorization({ target: 't', operation: 'create', project_id: PID, prior_state: {}, standard_commit: 'a'.repeat(40) }, 'd'.repeat(64), { nonce: 'ab'.repeat(16), nowMs: T0 + 30000 });
  assert.equal(effectiveConfirmTimeoutMs(auth, T0, 900000), Date.parse(auth.expires_at) - T0, 'exactly the time left until expires_at, nothing more');
});

test('20. timeout: zero artifact writes, nonce not consumed, lock released, resources closed; foreign lock kept', () => {
  const t = fresh(); const seen = []; const term = timeoutTerm(seen);
  const e = errOf(() => run(t, {}, { terminal: null, openTerminal: () => term, confirmTimeoutMs: 50 }));
  assert.equal(e.code, 'APPROVAL_TIMEOUT'); assert.deepEqual(e.details.files_changed, []);
  assert.equal(term.closed, 1, 'the terminal the writer opened is closed'); noSdd(t);
  // not consumed: the same plan and nonce can still be approved afterwards
  const ok = run(t, {}, { terminal: tty(true) });
  assert.equal(ok.status, 'APPLIED'); assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
  // only an owned lock is released: if the lock changed hands while waiting it stays
  const t2 = fresh(); const foreign = 'e'.repeat(32);
  const e2 = errOf(() => run(t2, {}, { terminal: { confirm() { writeLock(t2, { token: foreign, pid: process.pid, process_start: processStart(process.pid) }); const x = new Error('t'); x.code = 'APPROVAL_TIMEOUT'; throw x; } } }));
  assert.equal(e2.code, 'APPROVAL_TIMEOUT'); assert.equal(JSON.parse(readFileSync(lockFile(t2), 'utf8')).token, foreign);
  assert.equal(existsSync(join(t2, '.sdd/artifacts')), false);
});

test('21. a terminal that answers after expires_at cannot approve; an expired remainder never prompts', () => {
  const t = fresh(); const asked = [];
  const c = jumpClock(600000); // already expired when the timeout is computed
  const e = errOf(() => run(t, {}, { terminal: tty((x, p) => { asked.push(p); return true; }), random: c.random, clock: c.clock }));
  assert.equal(e.code, 'APPROVAL_TIMEOUT'); assert.deepEqual(asked, []); noSdd(t);
  // answered "yes" but only after the authorization expired during the wait
  const t2 = fresh(); let now = T0;
  const e2 = errOf(() => run(t2, {}, { clock: () => now, terminal: { confirm() { now = T0 + 600000; return true; } } }));
  assert.equal(e2.code, 'AUTH_EXPIRED'); noSdd(t2);
});

// ---- real-PTY tests (python3 pty.fork gives the child a controlling terminal; python3 is only used, never installed).
// If python3/pty is unavailable the tests are reported as an explicit Node SKIP, never a silent pass. The macOS gate
// (`npm run test:pty-gate`, sets DAC_REQUIRE_PTY=1) turns "unavailable" into a hard FAIL and also checks nothing skipped.
const REQUIRE_PTY = process.env.DAC_REQUIRE_PTY === '1';
const PTY_HARNESS = `import os,pty,sys,select,time
node,code,mode=sys.argv[1:4]
pid,fd=pty.fork()
if pid==0:
    os.execv(node,[node,'--input-type=module','-e',code])
out=b'';end=time.time()+20;t0=None;stage=0
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.02)
    if r:
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        out+=d
    txt=out.decode('utf8','replace')
    if stage==0 and 'Type exactly "' in txt and '" within' in txt:
        phrase=txt.split('Type exactly "',1)[1].split('" within',1)[0]
        t0=time.time();stage=1
    if stage==1 and time.time()>=t0+0.3:
        os.write(fd,phrase.encode()); stage=2   # typed, but no newline yet
    if stage==2 and time.time()>=t0+(0.4 if mode=='fast' else 2.0):
        try: os.write(fd,b'\\n')
        except OSError: pass
        stage=3
os.waitpid(pid,0)
sys.stdout.write(out.decode('utf8','replace'))`;
let ptyProbe;
function ptyAvailable() {
  if (ptyProbe === undefined) {
    const r = spawnSync('python3', ['-I', '-c', 'import os,pty\nos.close(pty.openpty()[0])'], { encoding: 'utf8', timeout: 10000 });
    ptyProbe = r.error || r.status !== 0 ? `python3/pty unavailable (${r.error?.code ?? `exit ${r.status}`})` : '';
  }
  return ptyProbe;
}
// Explicit SKIP when unavailable (visible in the Node report); under DAC_REQUIRE_PTY=1 it is a failure instead.
const ptyTest = (name, fn) => test(name, { skip: !REQUIRE_PTY && ptyAvailable() ? ptyAvailable() : false }, (t) => {
  if (ptyAvailable()) assert.fail(`mandatory PTY prerequisite missing: ${ptyAvailable()}`);
  return fn(t);
});
const REAL_AUTH = pathToFileURL(join(REPO_ROOT, 'adapters/shared/sdd-writer/authorization.mjs')).href;
const REAL_WRITER = pathToFileURL(join(REPO_ROOT, 'adapters/shared/sdd-writer/writer.mjs')).href;
function ptyRun(code, mode) {
  const r = spawnSync('python3', ['-I', '-c', PTY_HARNESS, process.execPath, code, mode], { encoding: 'utf8', timeout: 40000 });
  const m = /RESULT (\{.*\})/.exec(r.stdout ?? '');
  assert.ok(m, `the PTY child produced no result (this is a harness failure, not a skip): ${r.stderr}${r.stdout}`);
  return JSON.parse(m[1]);
}

ptyTest('22. PTY: real /dev/tty confirmation honours the timeout when nobody types', () => {
  const child = `import {openTrustedTerminal} from ${JSON.stringify(REAL_AUTH)};
const t=openTrustedTerminal(); const s=Date.now(); let r; try{ r=t.confirm('x','p',{timeoutMs:300}); }catch(e){ r=e.code; } t.close(); console.log('RESULT '+JSON.stringify({r,ms:Date.now()-s}));`;
  const out = ptyRun(child, 'none'); // the late (2 s) newline arrives after the 300 ms timeout
  assert.equal(out.r, 'APPROVAL_TIMEOUT'); assert.ok(out.ms >= 250 && out.ms < 5000, String(out.ms));
});

// Real apply() on a real /dev/tty with the real polling terminal. Only the clock is shifted after the authorization is
// minted so that expires_at is `remainingMs` away; the terminal deadline is real wall time. No skew is added anywhere.
const ptyApplyChild = (t, remainingMs) => `import {apply} from ${JSON.stringify(REAL_WRITER)};
let n=0; const REMAIN=${remainingMs};
const clock=()=>{ n++; return n<=2 ? Date.now() : Date.now()+600000-REMAIN; }; // calls 1-2: lock + mint; later calls: ~REMAIN before expires_at
const s=Date.now(); let o;
try{ const r=apply({target:${JSON.stringify(t)},input:${JSON.stringify(input())},source:()=>({head:'a'.repeat(40)}),random:()=>'ab'.repeat(16),clock}); o={status:r.status}; }
catch(e){ o={status:'FAILED',code:e.code}; }
o.ms=Date.now()-s; console.log('RESULT '+JSON.stringify(o));`;

ptyTest('22b. PTY: control - confirmation typed well before expires_at is accepted (the slow test is not vacuous)', () => {
  const t = fresh(); const o = ptyRun(ptyApplyChild(t, 3000), 'fast');
  assert.equal(o.status, 'APPLIED', JSON.stringify(o)); assert.equal(verify({ target: t, projectId: PID }).status, 'OK');
});

ptyTest('22c. PTY: slow input completing after expires_at is rejected; zero writes, nonce not consumed, no skew extension', () => {
  const t = fresh(); const before = snapshot(t);
  // expires_at is ~1000 ms away; the phrase is typed at ~300 ms but the final newline only arrives at ~2000 ms.
  const o = ptyRun(ptyApplyChild(t, 1000), 'slow');
  assert.equal(o.code, 'APPROVAL_TIMEOUT', JSON.stringify(o)); // not AUTH_EXPIRED/APPLIED: stopped at the deadline, mid-typing
  // Polling is 25 ms, so the rejection lands within ~25 ms (+ scheduling) of expires_at, never later than the late newline.
  assert.ok(o.ms >= 900 && o.ms < 1900, `rejected at ${o.ms} ms for a ~1000 ms window`);
  assert.deepEqual(snapshot(t), before, 'zero writes');
  noSdd(t); // no artifacts, no receipt, no consumed-nonce marker, no leftover lock
  assert.equal(existsSync(lockFile(t)), false);
});

// ---- 2J-B hardening: strict owner verification, fail-safe without ps lstart --------------------------------
test('23. owner verification fails safe when ps lstart is unsupported; never recovers by age', () => {
  const info = { pid: 999999, process_start: 'Mon Jan  1 00:00:00 2026' };
  const broken = () => { throw new Error('ps: illegal option -- o'); };
  assert.equal(ownerState(info, broken), 'unverifiable', 'unsupported ps => cannot call a dead owner dead');
  assert.equal(ownerState({ ...info, process_start: null }, () => 'x'), 'unverifiable');
  assert.equal(ownerState(info, () => ''), 'unverifiable', 'empty output for our own pid means unsupported');
  const selfOk = (cmd, args) => (args.includes(String(process.pid)) ? 'Tue Feb  2 00:00:00 2027\n' : (() => { throw new Error('exit 1'); })());
  assert.equal(ownerState(info, selfOk), 'dead');
  assert.equal(ownerState({ pid: process.pid, process_start: 'Tue Feb  2 00:00:00 2027' }, selfOk), 'alive');
  // end to end: an aged lock with a recorded start time, ps unusable => recovery refused, lock byte-identical
  const t = fresh(); writeLock(t); utimesSync(lockFile(t), new Date('2000-01-01'), new Date('2000-01-01'));
  const s = snapshot(t);
  const oldPath = process.env.PATH; process.env.PATH = join(scratch, 'no-ps-here');
  try { assert.equal(errOf(() => run(t, {}, { recoverLock: true })).code, 'LOCK_RECOVERY_REFUSED'); } finally { process.env.PATH = oldPath; }
  assert.deepEqual(snapshot(t), s);
});
