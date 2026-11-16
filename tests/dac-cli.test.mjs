// dac CLI v1 (bin/dac.mjs): thin facade over bootstrap, custodian CLI and SDD writer CLI.
// Disposable projects only; the standard source is a throw-away Git copy (clean-source gate). No provider binary (Codex/Cursor/Claude) is
// ever executed. The SDD writer is replaced by a recording stub ONLY in a separate source copy to test delegation and exit passthrough.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../installer/lib/run.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-cli-')));
const children = []; const stopTargets = [];
after(() => {
  for (const { src, dir } of stopTargets) spawnSync(process.execPath, [join(src, 'bin/dac.mjs'), 'stop'], { cwd: dir, env: { PATH: process.env.PATH } });
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label) => { const d = join(scratch, `${label}-${counter++}`); mkdirSync(d); return d; };
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const template = fresh('template');
for (const f of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (!existsSync(join(REPO_ROOT, f))) continue;
  mkdirSync(dirname(join(template, f)), { recursive: true });
  cpSync(join(REPO_ROOT, f), join(template, f));
}
git(template, 'init', '-q', '-b', 'main'); git(template, 'add', '-A'); git(template, 'commit', '-q', '-m', 'base');
const source = (label) => { const d = fresh(label); cpSync(template, d, { recursive: true }); return d; };
const SRC = source('src');
const dac = (args, cwd, src = SRC) => spawnSync(process.execPath, [join(src, 'bin/dac.mjs'), ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } });
const project = (label = 'proj') => { const d = fresh(label); git(d, 'init', '-q', '-b', 'main'); return realpathSync(d); };
function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      if (n === '.git') continue;
      const p = join(d, n); const r = rel ? `${rel}/${n}` : n;
      if (lstatSync(p).isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = readFileSync(p).toString('base64');
    }
  };
  walk(root, '');
  return out;
}
const readJ = (root, p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

// ---- arguments ---------------------------------------------------------------
test('package.json exposes the dac bin with a node shebang and no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.dac, 'bin/dac.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.match(readFileSync(join(REPO_ROOT, 'bin/dac.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('strict allowlist: unknown commands/flags, cursor, two providers, runtime-dir and approval flags are usage errors (exit 2)', () => {
  const p = project();
  for (const args of [[], ['nope'], ['init'], ['init', '--provider', 'cursor'], ['init', '--provider', 'codex,claude-code'], ['init', '--provider', 'codex', '--provider', 'claude-code'],
    ['init', '--provider', 'codex', '--context7'], ['init', '--provider', 'codex', '--target', '/tmp'], ['status', '--runtime-dir', '/tmp'], ['start', '--runtime-dir', '/tmp'], ['stop', '--json'],
    ['sdd'], ['sdd', 'cancel'], ['sdd', 'plan'], ['sdd', 'plan', '--handoff', 'a', '--input', 'b'], ['sdd', 'plan', '--handoff', 'a', '--runtime-dir', '/tmp'],
    ['sdd', 'apply', '--handoff', 'a', '--yes'], ['sdd', 'apply', '--handoff', 'a', '--approve'], ['sdd', 'apply', '--handoff', 'a', '--recover-lock'], ['sdd', 'apply', '--handoff', 'a', '--target', '/x'],
    ['sdd', 'verify'], ['sdd', 'verify', '--project', 'x', '--handoff', 'a'], ['sdd', 'plan', '--handoff', '--json']]) {
    const r = dac(args, p);
    assert.equal(r.status, 2, `${args.join(' ')} -> ${r.status} ${r.stderr}`);
  }
  assert.deepEqual(snapshot(p), {});
});

// ---- root detection ----------------------------------------------------------
test('root detection: nearest ancestor with .dac/standard.json; otherwise fail (not init)', () => {
  const p = project();
  assert.equal(dac(['init', '--provider', 'codex'], p).status, 0);
  const deep = join(p, 'a/b/c'); mkdirSync(deep, { recursive: true });
  const s = dac(['status', '--json'], deep);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).root, p);
  const none = fresh('noproj');
  const r = dac(['status'], none);
  assert.equal(r.status, 1); assert.match(r.stderr, /NO_PROJECT/);
});

test('init root = Git top-level (from a subdirectory); non-Git folders are unsupported and untouched', () => {
  const p = project();
  const sub = join(p, 'pkg'); mkdirSync(sub);
  const r = dac(['init', '--provider', 'claude-code'], sub);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(p, '.dac/standard.json'))); assert.ok(!existsSync(join(sub, '.dac')));
  const empty = fresh('nongit');
  const n = dac(['init', '--provider', 'claude-code'], empty);
  assert.equal(n.status, 1); assert.match(n.stderr, /NOT_GIT/);
  assert.deepEqual(readdirSync(empty), []);
});

// ---- init ----------------------------------------------------------------------
test('init shows the dry-run plan before applying; second run is idempotent; no Cursor files; claude-code gets the handoff runtime', () => {
  const p = project();
  const r = dac(['init', '--provider', 'claude-code'], p);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan \(DRY_RUN\)/);
  assert.ok(r.stdout.indexOf('Plan (DRY_RUN)') < r.stdout.indexOf('APPLIED'));
  assert.equal(readJ(p, '.dac/standard.json').providers['claude-code'].sdd_handoff, true);
  assert.ok(!existsSync(join(p, '.cursor')) && !existsSync(join(p, '.codex')));
  const before = snapshot(p);
  const again = dac(['init', '--provider', 'claude-code'], p);
  assert.equal(again.status, 0); assert.match(again.stdout, /Already installed/);
  assert.deepEqual(snapshot(p), before);
});

test('init upgrades an existing provider without handoff to handoff, preserving context7 and optional agents; rerun is idempotent; Cursor untouched', () => {
  const p = project();
  const args = ['installer/bootstrap.mjs', 'apply', '--provider', 'claude-code', '--target', p, '--context7', '--optional-agent', 'payment-integration'];
  const b = spawnSync(process.execPath, args, { cwd: SRC, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(readJ(p, '.dac/standard.json').providers['claude-code'].sdd_handoff, undefined);
  const r = dac(['init', '--provider', 'claude-code'], p);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Already installed/);
  const rec = readJ(p, '.dac/standard.json').providers['claude-code'];
  assert.equal(rec.sdd_handoff, true); assert.equal(rec.context7, true); assert.deepEqual(rec.optional_agents, ['payment-integration']);
  assert.ok(existsSync(join(p, '.claude/agents/payment-integration.md')));
  const before = snapshot(p);
  const again = dac(['init', '--provider', 'claude-code'], p);
  assert.equal(again.status, 0); assert.match(again.stdout, /Already installed/);
  assert.deepEqual(snapshot(p), before);
  assert.ok(!existsSync(join(p, '.cursor')));
});

test('init: a second provider does not steal the handoff owner; requesting handoff for it is rejected with zero writes; conflicts stop before any write', () => {
  const p = project();
  assert.equal(dac(['init', '--provider', 'claude-code'], p).status, 0);
  const r = dac(['init', '--provider', 'codex'], p);
  assert.equal(r.status, 0, r.stderr);
  const rec = readJ(p, '.dac/standard.json').providers;
  assert.equal(rec['claude-code'].sdd_handoff, true); assert.equal(rec.codex.sdd_handoff, undefined);
  const owned = snapshot(p);
  const second = dac(['init', '--provider', 'codex'], p);
  assert.equal(second.status, 1); assert.match(second.stderr, /HANDOFF_CONFLICT/);
  assert.deepEqual(snapshot(p), owned);
  const c = project('conflict');
  writeFileSync(join(c, 'AGENTS.md'), 'user file\n');
  const before = snapshot(c);
  const k = dac(['init', '--provider', 'codex'], c);
  assert.equal(k.status, 1); assert.match(k.stdout, /CONFLICT/);
  assert.deepEqual(snapshot(c), before);
});

test('init refuses a dirty standard source (engine gate) with zero writes', () => {
  const src = source('dirtysrc'); writeFileSync(join(src, 'untracked.txt'), 'x');
  const p = project();
  const r = dac(['init', '--provider', 'codex'], p, src);
  assert.equal(r.status, 1); assert.match(r.stderr, /SOURCE_DIRTY/);
  assert.deepEqual(snapshot(p), {});
});

// ---- start / status / stop -------------------------------------------------------
const waitFor = (fn, ms = 10000) => new Promise((res, rej) => { const end = Date.now() + ms; const t = () => { let v; try { v = fn(); } catch { /* retry */ } if (v) res(v); else if (Date.now() > end) rej(new Error('timeout')); else setTimeout(t, 50); }; t(); });
const startForeground = (cwd) => {
  const c = spawn(process.execPath, [join(SRC, 'bin/dac.mjs'), 'start'], { cwd, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c); c.out = ''; c.err = '';
  c.stdout.on('data', (d) => { c.out += d; }); c.stderr.on('data', (d) => { c.err += d; });
  c.exited = new Promise((res) => c.on('exit', (code, sig) => res({ code, sig })));
  return c;
};

test('start requires the handoff runtime; status/stop need a project', () => {
  const p = project();
  assert.equal(dac(['init', '--provider', 'codex'], p).status, 0);
  const q = project('nohandoff');
  const b = spawnSync(process.execPath, ['installer/bootstrap.mjs', 'apply', '--provider', 'codex', '--target', q], { cwd: SRC, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(b.status, 0, b.stderr);
  const r = dac(['start'], q);
  assert.equal(r.status, 1); assert.match(r.stderr, /NO_HANDOFF/);
  const none = fresh('none');
  assert.equal(dac(['stop'], none).status, 1);
});

test('start runs in the foreground, duplicate start reports running (0), status is combined and read-only, stop ends it; orphan socket is cleaned', async () => {
  const p = project();
  assert.equal(dac(['init', '--provider', 'codex'], p).status, 0);
  stopTargets.push({ src: SRC, dir: p });
  const idle = dac(['status', '--json'], p);
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(JSON.parse(idle.stdout).custodian.state, 'not-running');
  const c = startForeground(p);
  await waitFor(() => /started \(foreground\)/.test(c.err));
  const before = snapshot(p);
  const st = dac(['status', '--json'], p);
  const j = JSON.parse(st.stdout);
  assert.equal(st.status, 0); assert.equal(j.bootstrap.status, 'OK'); assert.equal(j.custodian.state, 'running'); assert.equal(j.custodian.pid, c.pid);
  assert.match(dac(['status'], p).stdout, /custodian: running/);
  const dup = dac(['start'], p);
  assert.equal(dup.status, 0); assert.match(dup.stdout, /already running/);
  assert.deepEqual(snapshot(p), before);
  const stop = dac(['stop'], p);
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.equal((await c.exited).code, 0);
  // orphan: SIGKILL leaves a stale socket; status reports it, start cleans it and runs.
  const c2 = startForeground(p);
  await waitFor(() => /started \(foreground\)/.test(c2.err));
  c2.kill('SIGKILL'); await c2.exited;
  assert.equal(JSON.parse(dac(['status', '--json'], p).stdout).custodian.state, 'stale-socket');
  const c3 = startForeground(p);
  await waitFor(() => /started \(foreground\)/.test(c3.err));
  assert.equal(JSON.parse(dac(['status', '--json'], p).stdout).custodian.state, 'running');
  assert.equal(dac(['stop'], p).status, 0); await c3.exited;
});

// ---- sdd -------------------------------------------------------------------------
function stubbed(code) {
  const src = source('stub'); // writer replaced by a recorder; used only for delegation/exit-passthrough
  writeFileSync(join(src, 'adapters/shared/sdd-writer/cli.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(src, 'stub.log'))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(${code});\n`);
  return src;
}
test('sdd delegates to the writer with the resolved root, passes args through, and passes exit codes through (incl. 3)', () => {
  const proj = fresh('sddproj'); mkdirSync(join(proj, '.dac')); writeFileSync(join(proj, '.dac/standard.json'), '{}');
  const root = realpathSync(proj); const sub = join(root, 'x'); mkdirSync(sub);
  for (const code of [0, 1, 2, 3]) {
    const src = stubbed(code);
    for (const [args, expected] of [
      [['sdd', 'plan', '--handoff', 'h-1'], ['plan', '--target', root, '--handoff', 'h-1']],
      [['sdd', 'apply', '--handoff', 'h-1', '--json'], ['apply', '--target', root, '--handoff', 'h-1', '--json']],
      [['sdd', 'plan', '--input', 'in.json'], ['plan', '--target', root, '--input', 'in.json']],
      [['sdd', 'apply', '--input', 'in.json'], ['apply', '--target', root, '--input', 'in.json']],
      [['sdd', 'verify', '--project', 'P1'], ['verify', '--target', root, '--project', 'P1']]]) {
      const r = dac(args, sub, src);
      assert.equal(r.status, code, `${args.join(' ')} ${r.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(join(src, 'stub.log'), 'utf8')), expected);
    }
  }
});

test('sdd plan is delegated read-only: real writer plan writes nothing; handoff id is never auto-selected; verify delegates', () => {
  const p = project();
  assert.equal(dac(['init', '--provider', 'claude-code'], p).status, 0);
  const fixture = join(SRC, 'tests/sdd-fixtures/projects/project-planning.json');
  const before = snapshot(p);
  const r = dac(['sdd', 'plan', '--input', fixture, '--json'], p);
  assert.ok([0, 1].includes(r.status), r.stderr); // delegated writer result (validation is the writer's job)
  assert.deepEqual(snapshot(p), before);
  const h = dac(['sdd', 'plan', '--handoff', 'ffffffffffffffffffffffffffffffff'], p); // no custodian running: writer/custodian refuses, nothing guessed
  assert.equal(h.status, 1);
  assert.deepEqual(snapshot(p), before);
  const v = dac(['sdd', 'verify', '--project', 'nope'], p);
  const direct = spawnSync(process.execPath, [join(SRC, 'adapters/shared/sdd-writer/cli.mjs'), 'verify', '--target', p, '--project', 'nope'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(v.status, direct.status); assert.equal(v.stdout, direct.stdout); // identical to the writer's own answer
  assert.deepEqual(snapshot(p), before);
  const none = dac(['sdd', 'verify', '--project', 'x'], fresh('noroot'));
  assert.equal(none.status, 1); assert.match(none.stderr, /NO_PROJECT/);
});
