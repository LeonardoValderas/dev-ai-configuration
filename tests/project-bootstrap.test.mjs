import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, symlinkSync, cpSync, existsSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../installer/lib/run.mjs';

// ---- fixtures: real temporary Git repositories holding a copy of this checkout --------------------
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-2ib-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => { const d = join(scratch, `${label}-${counter++}`); mkdirSync(d); return d; };
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const template = fresh('template');
for (const f of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (!existsSync(join(REPO_ROOT, f))) continue;
  mkdirSync(dirname(join(template, f)), { recursive: true });
  cpSync(join(REPO_ROOT, f), join(template, f));
}
git(template, 'init', '-q', '-b', 'main'); git(template, 'add', '-A'); git(template, 'commit', '-q', '-m', 'base');

async function source({ git: withGit = true } = {}) {
  const dir = fresh('src');
  cpSync(template, dir, { recursive: true });
  if (!withGit) rmSync(join(dir, '.git'), { recursive: true, force: true });
  const api = await import(pathToFileURL(join(dir, 'installer/bootstrap.mjs')).href);
  const cli = (...args) => spawnSync(process.execPath, [join(dir, 'installer/bootstrap.mjs'), ...args], { encoding: 'utf8' });
  const head = () => git(dir, 'rev-parse', 'HEAD').trim();
  const change = (file, fn, msg = 'change') => { writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8'))); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
  return { dir, api, cli, head, git: (...a) => git(dir, ...a), change };
}
const target = () => { const d = fresh('target'); return d; };

function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n); const r = rel ? `${rel}/${n}` : n; const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root, '');
  return out;
}
const files = (root) => Object.entries(snapshot(root)).filter(([, v]) => v !== 'dir').map(([k]) => k);
const read = (root, p) => readFileSync(join(root, p), 'utf8');
const readJ = (root, p) => JSON.parse(read(root, p));
const apply = (s, t, providers, extra = {}) => s.api.apply({ target: t, providers, ...extra });
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// ---- source verification -------------------------------------------------------------------------
test('clean Git source: applies and records the full verified HEAD and standard version', async () => {
  const s = await source(); const t = target();
  const r = apply(s, t, ['codex']);
  assert.equal(r.status, 'APPLIED');
  const rec = readJ(t, '.dac/standard.json');
  assert.equal(rec.standard_commit, s.head());
  assert.match(rec.standard_commit, /^[0-9a-f]{40}$/);
  assert.equal(rec.standard_version, read(s.dir, 'VERSION').trim());
  assert.deepEqual(Object.keys(rec.providers), ['codex']);
  assert.equal(s.git('status', '--porcelain'), '');
  assert.equal(s.api.verify({ target: t }).status, 'OK');
});

test('dirty source (modified, untracked, ignored input, hidden by assume-unchanged): zero writes', async () => {
  const cases = [
    (s) => writeFileSync(join(s.dir, 'README.md'), 'edited'),
    (s) => writeFileSync(join(s.dir, 'standards/untracked.txt'), 'x'),
    (s) => { writeFileSync(join(s.dir, '.gitignore'), 'standards/ignored.txt\n'); s.git('add', '-A'); s.git('commit', '-q', '-m', 'ignore'); writeFileSync(join(s.dir, 'standards/ignored.txt'), 'x'); },
    (s) => { s.git('update-index', '--assume-unchanged', 'VERSION'); writeFileSync(join(s.dir, 'VERSION'), '9.9.9\n'); },
  ];
  for (const dirty of cases) {
    const s = await source(); const t = target(); writeFileSync(join(t, 'keep.txt'), 'mine');
    dirty(s);
    assert.equal(codeOf(() => apply(s, t, ['codex', 'cursor'])), 'SOURCE_DIRTY');
    assert.deepEqual(files(t), ['keep.txt']);
  }
});

test('non-Git source and unverifiable HEAD: zero writes', async () => {
  const noGit = await source({ git: false }); const t = target();
  assert.equal(codeOf(() => apply(noGit, t, ['claude-code'])), 'SOURCE_NOT_GIT');
  assert.equal(codeOf(() => noGit.api.plan({ providers: ['codex'] })), 'SOURCE_NOT_GIT');
  const noCommit = await source(); rmSync(join(noCommit.dir, '.git'), { recursive: true }); git(noCommit.dir, 'init', '-q');
  assert.equal(codeOf(() => apply(noCommit, t, ['codex'])), 'SOURCE_UNVERIFIABLE');
  const missingObject = await source(); writeFileSync(join(missingObject.dir, '.git/HEAD'), 'a'.repeat(40) + '\n');
  assert.equal(codeOf(() => apply(missingObject, t, ['codex'])), 'SOURCE_UNVERIFIABLE');
  assert.deepEqual(files(t), []);
});

test('source nested in another Git repository is rejected', async () => {
  const outer = fresh('outer'); git(outer, 'init', '-q'); const inner = join(outer, 'standard'); cpSync(template, inner, { recursive: true }); rmSync(join(inner, '.git'), { recursive: true });
  const api = await import(pathToFileURL(join(inner, 'installer/bootstrap.mjs')).href);
  const t = target();
  assert.equal(codeOf(() => api.apply({ target: t, providers: ['codex'] })), 'SOURCE_NOT_GIT');
  assert.deepEqual(files(t), []);
});

test('HEAD or tree changing between planning and mutation (TOCTOU): zero writes', async () => {
  for (const mutate of [(s) => s.git('commit', '-q', '--allow-empty', '-m', 'moved'), (s) => writeFileSync(join(s.dir, 'README.md'), 'late edit')]) {
    const s = await source(); const t = target(); writeFileSync(join(t, 'keep.txt'), 'mine');
    const code = codeOf(() => apply(s, t, ['codex', 'cursor'], { hooks: { afterPlan: () => mutate(s) } }));
    assert.ok(['SOURCE_CHANGED', 'SOURCE_DIRTY'].includes(code), String(code));
    assert.deepEqual(files(t), ['keep.txt']);
  }
  const s = await source(); const t = target();
  assert.equal(apply(s, t, ['codex']).status, 'APPLIED');
  const before = snapshot(t);
  s.git('commit', '-q', '--allow-empty', '-m', 'moved');
  assert.equal(codeOf(() => s.api.update({ target: t, hooks: { afterPlan: () => s.git('commit', '-q', '--allow-empty', '-m', 'moved again') } })), 'SOURCE_CHANGED');
  assert.deepEqual(snapshot(t), before);
});

// ---- install, idempotence, conflicts, drift ------------------------------------------------------
test('initial install of every provider, idempotent, unrelated target changes preserved', async () => {
  const s = await source(); const t = target();
  mkdirSync(join(t, 'src')); writeFileSync(join(t, 'src/app.js'), 'code'); writeFileSync(join(t, 'package.json'), '{}');
  const r = apply(s, t, ['claude-code', 'codex', 'cursor']);
  assert.equal(r.status, 'APPLIED'); assert.deepEqual(r.conflicts, []);
  for (const f of ['.claude/dac-manifest.json', '.codex/dac-manifest.json', '.cursor/dac-manifest.json', 'AGENTS.md', '.dac/standard.json', '.dac/shared.json']) assert.ok(existsSync(join(t, f)), f);
  const after1 = snapshot(t);
  const again = apply(s, t, ['claude-code', 'codex', 'cursor']);
  assert.equal(again.status, 'UNCHANGED'); assert.deepEqual(snapshot(t), after1);
  assert.equal(read(t, 'src/app.js'), 'code'); assert.equal(read(t, 'package.json'), '{}');
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED');
  assert.equal(read(t, 'src/app.js'), 'code');
});

test('generated files and records contain no machine paths, OpenClaw references, Spec Kit install or Context7 by default', async () => {
  const s = await source(); const t = target();
  apply(s, t, ['claude-code', 'codex', 'cursor']);
  for (const f of files(t)) {
    const text = read(t, f);
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|[A-Za-z]:\\\\|openclaw/i, f);
    assert.doesNotMatch(text, new RegExp(s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), f);
    assert.doesNotMatch(f, /context7|\.mcp\.json$/i);
    assert.doesNotMatch(text, /specify init|uvx specify|npm i.*spec-kit/i);
  }
  assert.ok(!files(t).includes('.mcp.json'));
  assert.doesNotMatch(read(t, '.codex/config.toml'), /context7/);
  assert.equal(JSON.stringify(readJ(t, '.cursor/mcp.json')), '{"mcpServers":{}}');
  assert.equal(readJ(t, '.dac/standard.json').providers.codex.context7, false);
});

test('--context7 is an explicit opt-in', async () => {
  const s = await source(); const t = target();
  apply(s, t, ['codex', 'claude-code'], { options: { context7: true } });
  assert.match(read(t, '.codex/config.toml'), /context7[\s\S]*enabled = false/);
  assert.ok(existsSync(join(t, '.mcp.json')));
  assert.equal(readJ(t, '.dac/standard.json').providers.codex.context7, true);
  assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
});

test('existing unmanaged conflicts yield zero writes across all providers', async () => {
  for (const pre of ['AGENTS.md', '.claude/settings.json', '.cursor/mcp.json', '.dac/standard.json', '.codex/config.toml']) {
    const s = await source(); const t = target();
    mkdirSync(dirname(join(t, pre)), { recursive: true }); writeFileSync(join(t, pre), 'user content'); writeFileSync(join(t, 'other.txt'), 'x');
    const before = snapshot(t);
    const r = apply(s, t, ['claude-code', 'codex', 'cursor']);
    assert.equal(r.status, 'CONFLICT', pre); assert.ok(r.conflicts.some((c) => c.path === pre), pre);
    assert.deepEqual(snapshot(t), before, pre);
  }
});

test('managed drift is detected by verify and blocks apply, update and uninstall with zero writes', async () => {
  const s = await source(); const t = target(); apply(s, t, ['codex', 'cursor']);
  writeFileSync(join(t, '.cursor/rules/dac.mdc'), 'tampered');
  rmSync(join(t, '.codex/config.toml'));
  writeFileSync(join(t, 'AGENTS.md'), 'tampered');
  const before = snapshot(t);
  const v = s.api.verify({ target: t });
  assert.equal(v.status, 'DRIFT');
  assert.deepEqual(v.findings.map((f) => `${f.kind}:${f.path}`).sort(), ['missing:.codex/config.toml', 'modified:.cursor/rules/dac.mdc', 'modified:AGENTS.md']);
  assert.equal(s.api.update({ target: t }).status, 'CONFLICT');
  assert.equal(apply(s, t, ['codex']).status, 'CONFLICT');
  assert.equal(s.api.uninstall({ target: t, provider: 'cursor' }).status, 'CONFLICT');
  assert.deepEqual(snapshot(t), before);
  assert.equal(s.api.verify({ target: t }).findings.length, 3);
});

test('tampered records are drift: standard record, ledger, manifest', async () => {
  const s = await source(); const t = target(); apply(s, t, ['codex']);
  const std = read(t, '.dac/standard.json');
  writeFileSync(join(t, '.dac/standard.json'), std.replace(/[0-9a-f]{40}/, 'b'.repeat(40)).replace('\n', ' \n'));
  assert.equal(s.api.verify({ target: t }).status, 'DRIFT');
  assert.equal(s.api.update({ target: t }).status, 'CONFLICT');
  writeFileSync(join(t, '.dac/standard.json'), std);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  const ledger = JSON.parse(read(t, '.dac/shared.json')); ledger.files[0].owners = ['cursor'];
  writeFileSync(join(t, '.dac/shared.json'), JSON.stringify(ledger, null, 2) + '\n');
  assert.equal(s.api.verify({ target: t }).status, 'DRIFT');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'CONFLICT');
});

// ---- update ---------------------------------------------------------------------------------------
test('update between standard versions is explicit, all-owner atomic and fail closed', async () => {
  const s = await source(); const t = target(); apply(s, t, ['claude-code', 'codex', 'cursor']);
  const oldHead = s.head();
  const agentsBefore = read(t, 'AGENTS.md');
  s.change('standards/sdd/sdd-workflow.json', (x) => x.replace(/"objective": "/, '"objective": "Updated: '), 'new version');
  const newHead = s.head(); assert.notEqual(oldHead, newHead);
  const before = snapshot(t);
  // never implicit: apply refuses, verify reports outdated, dry-run and verify write nothing
  assert.equal(apply(s, t, ['codex']).status, 'CONFLICT');
  assert.equal(s.api.verify({ target: t }).outdated, true);
  assert.equal(s.api.update({ target: t, dryRun: true }).status, 'DRY_RUN');
  assert.deepEqual(snapshot(t), before);
  // drift blocks the update
  const settings = read(t, '.claude/settings.json');
  writeFileSync(join(t, '.claude/settings.json'), '{}');
  const drifted = snapshot(t);
  assert.equal(s.api.update({ target: t }).status, 'CONFLICT');
  assert.deepEqual(snapshot(t), drifted);
  writeFileSync(join(t, '.claude/settings.json'), settings);
  // injected fault mid-update rolls back every owner
  for (const n of [1, 4, 8]) { assert.throws(() => s.api.update({ target: t, faultAfter: n }), (e) => e.rolledBack === true); assert.deepEqual(snapshot(t), before); }
  const r = s.api.update({ target: t });
  assert.equal(r.status, 'APPLIED');
  assert.ok(r.updated.includes('AGENTS.md') && r.updated.includes('.codex/dac/sdd/sdd-workflow.json') && r.updated.includes('.cursor/dac/sdd/sdd-workflow.json') && r.updated.includes('.claude/dac/sdd/sdd-workflow.json'));
  assert.notEqual(read(t, 'AGENTS.md'), agentsBefore); assert.match(read(t, 'AGENTS.md'), /Updated: /);
  assert.equal(readJ(t, '.dac/standard.json').standard_commit, newHead);
  assert.equal(readJ(t, '.dac/shared.json').files[0].sha256, createHash('sha256').update(readFileSync(join(t, 'AGENTS.md'))).digest('hex'));
  const v = s.api.verify({ target: t }); assert.equal(v.status, 'OK'); assert.equal(v.outdated, false);
  assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
  assert.equal(apply(s, t, ['codex']).status, 'UNCHANGED');
  s.git('commit', '-q', '--allow-empty', '-m', 'metadata only');
  assert.deepEqual(s.api.update({ target: t }).updated, ['.dac/standard.json']);
});

test('update requires an existing installation', async () => {
  const s = await source(); const t = target();
  assert.equal(codeOf(() => s.api.update({ target: t })), 'NOT_INSTALLED');
  assert.deepEqual(files(t), []);
});

// ---- rollback --------------------------------------------------------------------------------------
test('injected partial failure rolls back apply and uninstall across providers and shared state', async () => {
  const s = await source(); const t = target(); writeFileSync(join(t, 'keep.txt'), 'mine');
  const empty = snapshot(t);
  const total = apply(s, t, ['claude-code', 'codex', 'cursor'], { dryRun: true }).created.length;
  for (const n of [1, 3, 40, total]) { assert.throws(() => apply(s, t, ['claude-code', 'codex', 'cursor'], { faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), empty, `fault ${n}`); }
  apply(s, t, ['claude-code', 'codex', 'cursor']);
  const full = snapshot(t);
  for (const n of [1, 6, 30, 60]) { assert.throws(() => s.api.uninstall({ target: t, provider: 'codex', faultAfter: n }), (e) => e.rolledBack === true); assert.deepEqual(snapshot(t), full, `uninstall fault ${n}`); }
  for (const p of ['claude-code', 'codex', 'cursor']) assert.equal(s.api.uninstall({ target: t, provider: p }).status, 'REMOVED');
  assert.deepEqual(snapshot(t), empty);
});

test('target changing during apply aborts and rolls back', async () => {
  const s = await source(); const t = target(); const before = snapshot(t);
  // a file appears after planning but before its write: the executor re-checks every path
  const { executeActions } = await import(pathToFileURL(join(s.dir, 'adapters/shared/apply.mjs')).href);
  writeFileSync(join(t, 'late.txt'), 'appeared');
  assert.throws(() => executeActions(t, [{ op: 'create', path: 'a.txt', buf: Buffer.from('a') }, { op: 'create', path: 'late.txt', buf: Buffer.from('b') }]), (e) => e.rolledBack === true);
  assert.deepEqual(Object.keys(snapshot(t)), ['late.txt']); assert.equal(read(t, 'late.txt'), 'appeared');
  void before;
});

// ---- uninstall and shared AGENTS.md ---------------------------------------------------------------
test('uninstall one provider keeps the others and unrelated files', async () => {
  const s = await source(); const t = target(); writeFileSync(join(t, 'keep.txt'), 'mine');
  apply(s, t, ['claude-code', 'codex']);
  assert.equal(s.api.uninstall({ target: t, provider: 'codex', dryRun: true }).status, 'DRY_RUN');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED');
  assert.ok(!existsSync(join(t, '.codex')) && !existsSync(join(t, '.agents')) && !existsSync(join(t, 'AGENTS.md')) && !existsSync(join(t, '.dac/shared.json')));
  assert.deepEqual(Object.keys(readJ(t, '.dac/standard.json').providers), ['claude-code']);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'UNCHANGED');
  assert.equal(s.api.uninstall({ target: t, provider: 'claude-code' }).status, 'REMOVED');
  assert.deepEqual(files(t), ['keep.txt']);
});

for (const order of [['codex', 'cursor'], ['cursor', 'codex'], ['both']]) {
  test(`Codex+Cursor share one neutral AGENTS.md (${order.join(' then ')}) with owners and ownership-safe removal`, async () => {
    const s = await source(); const t = target();
    if (order[0] === 'both') apply(s, t, ['cursor', 'codex']); else for (const p of order) { assert.equal(apply(s, t, [p]).status, 'APPLIED'); }
    const agents = readFileSync(join(t, 'AGENTS.md'));
    const sha = createHash('sha256').update(agents).digest('hex');
    assert.deepEqual(readJ(t, '.dac/shared.json'), { schema: 1, files: [{ path: 'AGENTS.md', sha256: sha, owners: ['codex', 'cursor'] }] });
    assert.doesNotMatch(agents.toString(), /\bcodex adapter\b|\bcursor adapter\b/i);
    for (const p of ['codex', 'cursor']) assert.ok(!readJ(t, `.${p}/dac-manifest.json`).files.some((f) => f.path === 'AGENTS.md'));
    assert.equal(apply(s, t, ['codex', 'cursor']).status, 'UNCHANGED');
    assert.equal(s.api.verify({ target: t }).status, 'OK');
    // second owner is added without rewriting
    if (order.length === 2) assert.deepEqual(readFileSync(join(t, 'AGENTS.md')), agents);
    // uninstall one: file retained, ownership shrinks; other provider intact
    const first = order[0] === 'both' ? 'codex' : order[0];
    const second = first === 'codex' ? 'cursor' : 'codex';
    assert.equal(s.api.uninstall({ target: t, provider: first }).status, 'REMOVED');
    assert.deepEqual(readFileSync(join(t, 'AGENTS.md')), agents);
    assert.deepEqual(readJ(t, '.dac/shared.json').files[0].owners, [second]);
    assert.equal(s.api.verify({ target: t }).status, 'OK');
    // modified shared file blocks the final removal
    writeFileSync(join(t, 'AGENTS.md'), 'user edit');
    const snap = snapshot(t);
    assert.equal(s.api.uninstall({ target: t, provider: second }).status, 'CONFLICT');
    assert.deepEqual(snapshot(t), snap);
    writeFileSync(join(t, 'AGENTS.md'), agents);
    assert.equal(s.api.uninstall({ target: t, provider: second }).status, 'REMOVED');
    assert.deepEqual(files(t), []);
  });
}

test('shared AGENTS.md identical bytes whichever provider wrote it', async () => {
  const s = await source(); const a = target(); const b = target();
  apply(s, a, ['codex']); apply(s, b, ['cursor']);
  assert.deepEqual(readFileSync(join(a, 'AGENTS.md')), readFileSync(join(b, 'AGENTS.md')));
});

// ---- legacy migration ------------------------------------------------------------------------------
function legacyApply(s, provider, t) {
  const r = spawnSync(process.execPath, [join(s.dir, `adapters/${provider}/cli.mjs`), 'apply', '--target', t], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('legacy provider manifest migrates into the shared ledger only on a canonical hash', async () => {
  for (const legacy of ['codex', 'cursor']) {
    const other = legacy === 'codex' ? 'cursor' : 'codex';
    const s = await source(); const t = target(); legacyApply(s, legacy, t);
    assert.equal(s.api.verify({ target: t }).findings[0].kind, 'legacy');
    assert.match(read(t, 'AGENTS.md'), new RegExp(`Generated ${legacy} project adapter`));
    const r = apply(s, t, [other]);
    assert.equal(r.status, 'APPLIED'); assert.ok(r.updated.includes('AGENTS.md'));
    assert.doesNotMatch(read(t, 'AGENTS.md'), /project adapter\. Regenerate/);
    assert.deepEqual(readJ(t, '.dac/shared.json').files[0].owners, ['codex', 'cursor']);
    assert.ok(!readJ(t, `.${legacy}/dac-manifest.json`).files.some((f) => f.path === 'AGENTS.md'));
    assert.equal(s.api.verify({ target: t }).status, 'OK');
  }
  // update alone migrates a legacy install too
  const s = await source(); const t = target(); legacyApply(s, 'codex', t);
  assert.equal(s.api.update({ target: t }).status, 'APPLIED'); assert.equal(s.api.verify({ target: t }).status, 'OK');
  // legacy uninstall through the facade removes its own AGENTS.md
  const u = await source(); const ut = target(); legacyApply(u, 'cursor', ut);
  assert.equal(u.api.uninstall({ target: ut, provider: 'cursor' }).status, 'REMOVED'); assert.deepEqual(files(ut), []);
});

test('legacy AGENTS.md that is edited or not canonical conflicts with zero writes', async () => {
  const s = await source(); const t = target(); legacyApply(s, 'codex', t);
  const original = read(t, 'AGENTS.md');
  writeFileSync(join(t, 'AGENTS.md'), original + '\nuser edit\n');
  let before = snapshot(t);
  assert.equal(apply(s, t, ['cursor']).status, 'CONFLICT'); assert.equal(s.api.update({ target: t }).status, 'CONFLICT');
  assert.deepEqual(snapshot(t), before);
  // manifest rewritten to match the edit: hashes agree, but it is still not this standard's canonical legacy file
  const mp = join(t, '.codex/dac-manifest.json'); const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.files.find((f) => f.path === 'AGENTS.md').sha256 = createHash('sha256').update(readFileSync(join(t, 'AGENTS.md'))).digest('hex');
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); before = snapshot(t);
  const r = apply(s, t, ['cursor']);
  assert.equal(r.status, 'CONFLICT'); assert.ok(r.conflicts.some((c) => /not canonical/.test(c.reason)));
  assert.deepEqual(snapshot(t), before);
});

// ---- target safety ---------------------------------------------------------------------------------
test('unsafe targets, symlinks and traversal are rejected with zero writes', async () => {
  const s = await source();
  const real = target(); const link = join(scratch, 'link-target'); symlinkSync(real, link);
  assert.equal(codeOf(() => apply(s, link, ['codex'])), 'TARGET');
  assert.equal(codeOf(() => apply(s, 'relative/dir', ['codex'])), 'TARGET');
  assert.equal(codeOf(() => apply(s, join(scratch, 'missing'), ['codex'])), 'TARGET');
  assert.equal(codeOf(() => apply(s, join(s.dir, 'standards'), ['codex'])), 'TARGET');
  assert.equal(codeOf(() => s.api.verify({ target: link })), 'TARGET');
  for (const [name, mk] of [['.dac', (t, outside) => symlinkSync(outside, join(t, '.dac'))], ['.codex', (t, outside) => symlinkSync(outside, join(t, '.codex'))], ['AGENTS.md', (t, outside) => symlinkSync(join(outside, 'x'), join(t, 'AGENTS.md'))]]) {
    const t = target(); const outside = target(); mk(t, outside);
    const r = apply(s, t, ['codex', 'cursor']);
    assert.equal(r.status, 'CONFLICT', name); assert.deepEqual(files(outside), [], name); assert.deepEqual(files(t).filter((f) => !f.startsWith(name)), [], name);
  }
  // ledger and manifest entries that escape the target are invalid, not followed
  const t = target(); apply(s, t, ['codex']);
  const ledger = JSON.parse(read(t, '.dac/shared.json')); ledger.files[0].path = '../outside';
  writeFileSync(join(t, '.dac/shared.json'), JSON.stringify(ledger, null, 2) + '\n');
  assert.equal(s.api.verify({ target: t }).status, 'DRIFT'); assert.equal(s.api.update({ target: t }).status, 'CONFLICT');
  const t2 = target(); apply(s, t2, ['claude-code']);
  const m = readJ(t2, '.claude/dac-manifest.json'); m.files.push({ path: '../escape', sha256: 'a'.repeat(64) });
  writeFileSync(join(t2, '.claude/dac-manifest.json'), JSON.stringify(m));
  assert.equal(s.api.uninstall({ target: t2, provider: 'claude-code' }).status, 'CONFLICT');
});

// ---- no-write commands and CLI ---------------------------------------------------------------------
test('plan and verify never write, to the target or the source', async () => {
  const s = await source(); const t = target(); writeFileSync(join(t, 'keep.txt'), 'x');
  const before = snapshot(t);
  const p = s.api.plan({ providers: ['codex', 'cursor'] });
  assert.deepEqual(p.shared, [{ path: 'AGENTS.md', owners: ['codex', 'cursor'] }]);
  assert.ok(!p.files.codex.includes('AGENTS.md') && p.records.includes('.dac/shared.json'));
  const pt = s.api.plan({ providers: ['codex', 'cursor'], target: t });
  assert.equal(pt.target.status, 'DRY_RUN');
  assert.equal(s.api.verify({ target: t }).status, 'NOT_INSTALLED');
  assert.deepEqual(snapshot(t), before);
  apply(s, t, ['codex']); const installed = snapshot(t);
  s.api.verify({ target: t }); s.api.plan({ providers: ['claude-code'], target: t });
  assert.deepEqual(snapshot(t), installed);
  assert.equal(s.git('status', '--porcelain'), '');
});

test('verify works when the source is unverifiable, and reports it', async () => {
  const s = await source(); const t = target(); apply(s, t, ['codex']);
  writeFileSync(join(s.dir, 'README.md'), 'dirty');
  const v = s.api.verify({ target: t });
  assert.equal(v.status, 'OK'); assert.equal(v.source.status, 'UNVERIFIED'); assert.equal(v.source.code, 'SOURCE_DIRTY');
});

test('CLI: usage errors, apply, verify, update, uninstall and fail-closed exit codes', async () => {
  const s = await source(); const t = target();
  assert.equal(s.cli().status, 2);
  assert.equal(s.cli('apply', '--target', t).status, 2);
  assert.equal(s.cli('apply', '--provider', 'nope', '--target', t).status, 1);
  assert.equal(s.cli('apply', '--provider', 'codex', '--bogus').status, 2);
  assert.equal(s.cli('verify', '--target', t, '--provider', 'codex').status, 2);
  assert.equal(s.cli('uninstall', '--provider', 'codex,cursor', '--target', t).status, 2);
  assert.equal(s.cli('--help').status, 0);
  assert.deepEqual(files(t), []);
  const a = s.cli('apply', '--provider', 'codex,cursor', '--target', t, '--json');
  assert.equal(a.status, 0, a.stderr); assert.equal(JSON.parse(a.stdout).status, 'APPLIED');
  assert.equal(s.cli('verify', '--target', t).status, 0);
  assert.equal(s.cli('update', '--target', t).status, 0);
  assert.equal(JSON.parse(s.cli('plan', '--provider', 'codex', '--json').stdout).files.codex.length > 0, true);
  writeFileSync(join(t, 'AGENTS.md'), 'x');
  assert.equal(s.cli('verify', '--target', t).status, 1);
  writeFileSync(join(t, '.codex/config.toml'), 'x');
  assert.equal(s.cli('uninstall', '--provider', 'codex', '--target', t).status, 1);
  writeFileSync(join(s.dir, 'README.md'), 'dirty');
  const d = s.cli('apply', '--provider', 'claude-code', '--target', t);
  assert.equal(d.status, 1); assert.match(d.stderr, /SOURCE_DIRTY/);
});

test('Context7 flag is rejected for update/verify and optional agents only apply to claude-code', async () => {
  const s = await source(); const t = target();
  assert.equal(s.cli('update', '--target', t, '--context7').status, 2);
  assert.equal(codeOf(() => apply(s, t, ['codex'], { options: { optionalAgents: ['x'] } })), 'OPTIONS');
  assert.deepEqual(files(t), []);
});
