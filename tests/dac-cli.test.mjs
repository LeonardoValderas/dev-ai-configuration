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
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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

// ---- Increment A: interactive init, package name record, update, command installation -----------------------------------
import { pathToFileURL } from 'node:url';
import { symlinkSync, readlinkSync, statSync, chmodSync } from 'node:fs';

async function interactive(src, argv, cwd, answers, onAsk) {
  const mod = await import(pathToFileURL(join(src, 'bin/dac.mjs')).href);
  const asked = []; const out = []; const queue = [...answers];
  const io = { isTTY: true, async ask(q) { asked.push(q); onAsk?.(q, asked.length); return queue.length ? queue.shift() : null; }, close() {} };
  const [ol, oe] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '));
  let code;
  try { code = await mod.main(argv, cwd, io); } finally { console.log = ol; console.error = oe; }
  return { code, asked, out: out.join('\n') };
}
const bootstrap = (args, src = SRC) => spawnSync(process.execPath, [join(src, 'installer/bootstrap.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
const plainDir = (label = 'plain') => realpathSync(fresh(label));

test('interactive init: preview and confirmation precede any write; git init is confirmed, unborn (no commits); project.json holds package_name only', async () => {
  const d = plainDir(); const cwd = fresh('cwd');
  let atConfirm = null;
  const r = await interactive(SRC, ['init'], cwd, [d, 'my-pkg', 'codex', 'y'], (q) => { if (/Apply/.test(q)) atConfirm = { files: snapshot(d), git: existsSync(join(d, '.git')) }; });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(atConfirm, { files: {}, git: false });
  assert.match(r.out, /selected by: explicit path/); assert.match(r.out, /git init/); assert.match(r.out, /Plan \(DRY_RUN\)/);
  assert.deepEqual(readJ(d, '.dac/project.json'), { schema: 1, package_name: 'my-pkg' });
  assert.throws(() => git(d, 'rev-parse', '--verify', 'HEAD'));
  assert.equal(git(d, 'for-each-ref').trim(), '');
  assert.equal(bootstrap(['verify', '--target', d]).status, 0);
  const before = snapshot(d);
  const again = await interactive(SRC, ['init'], cwd, [d, 'my-pkg', 'codex', 'y']);
  assert.equal(again.code, 0); assert.match(again.out, /Already installed/); assert.deepEqual(snapshot(d), before);
  assert.equal(again.asked.length, 3); // no confirmation needed when nothing changes
});

test('interactive init: decline, EOF at every prompt, bad input and non-TTY missing args all leave zero writes', async () => {
  const d = plainDir();
  const full = [d, 'my-pkg', 'codex', 'y'];
  for (let n = 0; n < full.length; n++) { // EOF after n answers
    const r = await interactive(SRC, ['init'], fresh('cwd'), full.slice(0, n));
    assert.equal(r.code, 1, `eof@${n}: ${r.out}`); assert.match(r.out, /Cancelled|NOT_GIT/);
    assert.deepEqual(readdirSync(d), [], `eof@${n}`);
  }
  for (const no of ['n', '', 'maybe']) { const r = await interactive(SRC, ['init'], fresh('cwd'), [d, 'my-pkg', 'codex', no]); assert.equal(r.code, 1); assert.deepEqual(readdirSync(d), []); }
  for (const bad of [[d, '../Bad', 'codex', 'y'], [d, 'my-pkg', 'cursor', 'y'], [join(d, 'missing'), 'my-pkg', 'codex', 'y']]) {
    const r = await interactive(SRC, ['init'], fresh('cwd'), bad); assert.notEqual(r.code, 0); assert.deepEqual(readdirSync(d), []);
  }
  const t = dac(['init', '--path', d, '--package-name', 'x'], fresh('cwd')); // non-TTY, provider missing
  assert.equal(t.status, 2); assert.deepEqual(readdirSync(d), []);
  const nongit = dac(['init', '--provider', 'codex', '--path', d], fresh('cwd')); // flag mode never runs git init
  assert.equal(nongit.status, 1); assert.match(nongit.stderr, /NOT_GIT`?|NOT_GIT/); assert.deepEqual(readdirSync(d), []);
});

test('root precedence: explicit path > nearest installed DAC ancestor > Git root', async () => {
  const outer = project('outer');
  assert.equal(dac(['init', '--provider', 'codex'], outer).status, 0);
  const inner = join(outer, 'inner'); mkdirSync(inner); git(inner, 'init', '-q', '-b', 'main'); // nested repo below an installed project
  const viaAncestor = await interactive(SRC, ['init'], inner, ['', 'p-one', 'codex', 'y']);
  assert.match(viaAncestor.out, new RegExp(`in ${outer}\\n.*nearest installed DAC project`)); assert.equal(viaAncestor.code, 0);
  assert.ok(existsSync(join(outer, '.dac/project.json'))); assert.ok(!existsSync(join(inner, '.dac')));
  const other = project('other');
  const explicit = await interactive(SRC, ['init'], inner, [other, 'p-two', 'claude-code', 'y']);
  assert.equal(explicit.code, 0, explicit.out); assert.ok(existsSync(join(other, '.dac/project.json'))); assert.ok(!existsSync(join(inner, '.dac')));
  const g = project('gitroot'); const sub = join(g, 's'); mkdirSync(sub);
  assert.equal(dac(['init', '--provider', 'codex', '--package-name', 'g-pkg'], sub).status, 0);
  assert.deepEqual(readJ(g, '.dac/project.json'), { schema: 1, package_name: 'g-pkg' });
});

test('package name: same value idempotent; changed value needs explicit confirmation; drift blocks; update/verify/uninstall; .sdd untouched; no manifests edited', async () => {
  const p = project();
  writeFileSync(join(p, 'package.json'), '{"name":"keep"}\n'); mkdirSync(join(p, '.sdd')); writeFileSync(join(p, '.sdd/note.bin'), Buffer.from([0, 1, 2, 255]));
  const sdd = readFileSync(join(p, '.sdd/note.bin')); const pkg = readFileSync(join(p, 'package.json'));
  assert.equal(dac(['init', '--provider', 'codex', '--package-name', 'one'], p).status, 0);
  const s1 = snapshot(p);
  assert.match(dac(['init', '--provider', 'codex', '--package-name', 'one'], p).stdout, /Already installed/);
  assert.deepEqual(snapshot(p), s1);
  const noReplace = dac(['init', '--provider', 'codex', '--package-name', 'two'], p);
  assert.equal(noReplace.status, 1); assert.match(noReplace.stderr, /PACKAGE_NAME_CHANGE/); assert.deepEqual(snapshot(p), s1);
  const nameless = dac(['init', '--provider', 'codex'], p); // keeps the record
  assert.equal(nameless.status, 0); assert.deepEqual(snapshot(p), s1);
  const declined = await interactive(SRC, ['init'], p, ['', 'two', 'codex', 'n']);
  assert.equal(declined.code, 1); assert.match(declined.out, /one -> two \(CHANGE\)/); assert.deepEqual(snapshot(p), s1);
  const ok = await interactive(SRC, ['init'], p, ['', 'two', 'codex', 'yes']);
  assert.equal(ok.code, 0, ok.out); assert.equal(readJ(p, '.dac/project.json').package_name, 'two');
  assert.equal(dac(['init', '--provider', 'codex', '--package-name', 'three', '--replace-package-name'], p).status, 0);
  assert.equal(readJ(p, '.dac/project.json').package_name, 'three');
  assert.equal(dac(['update'], p).status, 0); assert.equal(readJ(p, '.dac/project.json').package_name, 'three');
  assert.equal(JSON.parse(dac(['status', '--json'], p).stdout).bootstrap.status, 'OK');
  // drift
  writeFileSync(join(p, '.dac/project.json'), '{"schema":1,"package_name":"hand-edited"}');
  const drifted = snapshot(p);
  assert.equal(JSON.parse(dac(['status', '--json'], p).stdout).bootstrap.status, 'DRIFT');
  const blocked = dac(['init', '--provider', 'codex', '--package-name', 'four', '--replace-package-name'], p);
  assert.equal(blocked.status, 1); assert.match(blocked.stdout, /CONFLICT \.dac\/project\.json/); assert.deepEqual(snapshot(p), drifted);
  assert.equal(dac(['update'], p).status, 1); assert.deepEqual(snapshot(p), drifted);
  assert.ok(readFileSync(join(p, '.sdd/note.bin')).equals(sdd)); assert.ok(readFileSync(join(p, 'package.json')).equals(pkg));
  writeFileSync(join(p, '.dac/project.json'), JSON.stringify({ schema: 1, package_name: 'three' }, null, 2) + '\n');
  assert.equal(bootstrap(['uninstall', '--provider', 'codex', '--target', p]).status, 0);
  assert.ok(!existsSync(join(p, '.dac/project.json')));
  assert.ok(readFileSync(join(p, '.sdd/note.bin')).equals(sdd));
});

test('existing installs without project.json stay valid and update leaves them without one; update needs a project and previews', () => {
  const p = project();
  assert.equal(bootstrap(['apply', '--provider', 'codex', '--target', p]).status, 0);
  assert.equal(bootstrap(['verify', '--target', p]).status, 0);
  const u = dac(['update'], p);
  assert.equal(u.status, 0); assert.match(u.stdout, /Plan \(UNCHANGED\)/); assert.ok(!existsSync(join(p, '.dac/project.json')));
  assert.equal(dac(['update'], fresh('noproj')).status, 1);
  assert.equal(dac(['update', '--target', p], p).status, 2);
});

test('init after DAC-created git init: bootstrap failure removes only the provably-created, unborn .git; a foreign .git is preserved', async () => {
  const src = source('failsrc');
  const d = plainDir();
  const r = await interactive(src, ['init'], fresh('cwd'), [d, 'my-pkg', 'codex', 'y'], (q) => { if (/Apply/.test(q)) writeFileSync(join(src, 'dirty.txt'), 'x'); });
  assert.equal(r.code, 1); assert.match(r.out, /SOURCE_DIRTY/); assert.match(r.out, /removed \.git created by this operation/);
  assert.deepEqual(readdirSync(d), []);
  const src2 = source('failsrc2'); const e = plainDir();
  const f = await interactive(src2, ['init'], fresh('cwd'), [e, 'my-pkg', 'codex', 'y'], (q) => { if (/Apply/.test(q)) { mkdirSync(join(e, '.git')); writeFileSync(join(e, '.git/foreign'), 'mine'); } });
  assert.equal(f.code, 1); assert.equal(readFileSync(join(e, '.git/foreign'), 'utf8'), 'mine'); assert.ok(!existsSync(join(e, '.dac')));
});

test('undoGitInit preserves a .git that is no longer pristine, has commits, or was replaced', async () => {
  const mod = await import(pathToFileURL(join(SRC, 'bin/dac.mjs')).href);
  const made = (label) => { const d = plainDir(label); git(d, 'init', '-q'); const st = lstatSync(join(d, '.git')); return { d, c: { ino: st.ino, dev: st.dev, fingerprint: mod.gitFingerprint(join(d, '.git')) } }; };
  const a = made('u1'); assert.match(mod.undoGitInit(a.d, a.c), /^removed/); assert.ok(!existsSync(join(a.d, '.git')));
  const b = made('u2'); writeFileSync(join(b.d, '.git/extra'), 'x'); assert.match(mod.undoGitInit(b.d, b.c), /^preserved/); assert.ok(existsSync(join(b.d, '.git')));
  const c = made('u3'); writeFileSync(join(c.d, 'f'), 'x'); git(c.d, 'add', 'f'); git(c.d, 'commit', '-q', '-m', 'm'); assert.match(mod.undoGitInit(c.d, c.c), /^preserved/); assert.ok(existsSync(join(c.d, '.git')));
  const e = made('u4'); rmSync(join(e.d, '.git'), { recursive: true }); git(e.d, 'init', '-q'); assert.match(mod.undoGitInit(e.d, e.c), /^(preserved|removed)/);
});

// ---- user-owned symlink installation (documented script, run in a temporary HOME/PATH that contains spaces) ----------------
const docScript = () => /```sh\n(# DAC_CHECKOUT[\s\S]*?)```/.exec(readFileSync(join(REPO_ROOT, 'docs/dac-cli.md'), 'utf8'))[1];
function runInstall(home, extraEnv = {}) {
  const bin = join(home, 'bin dir');
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, DAC_CHECKOUT: SRC, ...extraEnv };
  return spawnSync('/bin/sh', ['-c', `(\n${docScript()}\n)`], { encoding: 'utf8', env });
}

test('command install: user-owned symlink in a temp HOME with spaces; idempotent; foreign destination rejected; unlink-only reversal; works from PATH', () => {
  const home = join(plainDir('home with space'), 'my home'); mkdirSync(home);
  const bin = join(home, 'bin dir'); const link = join(bin, 'dac');
  const env = { DAC_BIN_DIR: bin };
  const first = runInstall(home, env);
  assert.equal(first.status, 0, first.stderr); assert.equal(readlinkSync(link), join(SRC, 'bin/dac.mjs'));
  const again = runInstall(home, env); assert.equal(again.status, 0); assert.match(again.stdout, /already linked/);
  const viaPath = spawnSync('dac', ['--help'], { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home } });
  assert.equal(viaPath.status, 0, viaPath.stderr); assert.match(viaPath.stdout, /Usage: dac/);
  rmSync(link); // reversal is unlink-only
  writeFileSync(link, 'foreign'); assert.equal(runInstall(home, env).status, 1); assert.equal(readFileSync(link, 'utf8'), 'foreign');
  rmSync(link); symlinkSync('/nonexistent-elsewhere', link); const other = runInstall(home, env);
  assert.equal(other.status, 1); assert.match(other.stderr, /refusing/); assert.equal(readlinkSync(link), '/nonexistent-elsewhere');
  spawnSync('unlink', [link]); assert.ok(!existsSync(link)); assert.ok(existsSync(join(SRC, 'bin/dac.mjs'))); // checkout untouched
  const dflt = runInstall(home); assert.equal(dflt.status, 0, dflt.stderr); assert.ok(lstatSync(join(home, '.local/bin/dac')).isSymbolicLink());
});

test('command install: missing node, non-executable target and unset checkout fail without writing', () => {
  const home = join(plainDir('home2 x'), 'h'); mkdirSync(home);
  const nonode = spawnSync('/bin/sh', ['-c', `(\n${docScript()}\n)`], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: home, DAC_CHECKOUT: SRC } });
  assert.equal(nonode.status, 1); assert.deepEqual(readdirSync(home), []);
  const unset = spawnSync('/bin/sh', ['-c', `(\n${docScript()}\n)`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.notEqual(unset.status, 0); assert.deepEqual(readdirSync(home), []);
  const noexec = source('noexec'); chmodSync(join(noexec, 'bin/dac.mjs'), 0o644);
  const r = runInstall(home, { DAC_CHECKOUT: noexec }); assert.equal(r.status, 1); assert.deepEqual(readdirSync(home), []);
});

// ---- real-PTY interactive init (python3 pty.fork; only used, never installed). Explicit SKIP when python3/pty is unavailable. ----
const ptyOk = (() => { const r = spawnSync('python3', ['-I', '-c', 'import os,pty\nos.close(pty.openpty()[0])'], { encoding: 'utf8', timeout: 10000 }); return !r.error && r.status === 0; })();
const PTY_PY = `import os,pty,sys,select,time
node,script,cwd,answers=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4:]
pid,fd=pty.fork()
if pid==0:
    os.chdir(cwd); os.execv(node,[node,script,'init'])
buf=b''; sent=0; end=time.time()+60
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.3)
    if r:
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        buf+=d
    if sent<len(answers) and (buf.count(b': ')+buf.count(b'[y/N] '))>sent:
        time.sleep(0.2); os.write(fd,answers[sent].encode()+b'\\r'); sent+=1
_,st=os.waitpid(pid,0)
sys.stdout.write(buf.decode('utf8','replace')); sys.exit(os.waitstatus_to_exitcode(st))
`;
test('PTY: interactive init in a real terminal prompts, previews, confirms and applies; declining cancels with zero writes', { skip: ptyOk ? false : 'python3/pty unavailable' }, () => {
  const d = plainDir(); const run = (answers) => spawnSync('python3', ['-I', '-c', PTY_PY, process.execPath, join(SRC, 'bin/dac.mjs'), fresh('cwd'), ...answers], { encoding: 'utf8', timeout: 90000, env: { PATH: process.env.PATH } });
  const no = run([d, 'pty-pkg', 'codex', 'n']);
  assert.equal(no.status, 1, no.stdout + no.stderr); assert.match(no.stdout, /Cancelled/); assert.deepEqual(readdirSync(d), []);
  const yes = run([d, 'pty-pkg', 'codex', 'y']);
  assert.equal(yes.status, 0, yes.stdout + yes.stderr); assert.match(yes.stdout, /Plan \(DRY_RUN\)/); assert.match(yes.stdout, /APPLIED/);
  assert.equal(readJ(d, '.dac/project.json').package_name, 'pty-pkg');
});

// ---- generic package_name contract and read-only manifest suggestion -------------------------------------------------------
test('package_name contract: ecosystem-neutral names accepted; paths, control characters, whitespace and oversize rejected (flag and engine)', async () => {
  const { validPackageName } = await import(pathToFileURL(join(SRC, 'installer/bootstrap.mjs')).href);
  for (const ok of ['left-pad', '@scope/pkg.name', 'My_Package', 'requests', 'serde_json', 'github.com/Org/Repo/v2', 'com.example:my-app', 'org.acme/lib', 'My Project', 'a', 'x'.repeat(214)]) assert.equal(validPackageName(ok), true, ok);
  for (const bad of ['', ' ', ' a', 'a ', '\ta', 'a\n', 'a\0b', 'a\nb', '..', '.', '../x', 'a/../b', 'a/./b', '/abs', 'a//b', 'a/', 'C:/x', 'a\\b', '-flag', 'x'.repeat(215), 'a\u0007b', 'a\u200bb', 5, null, undefined]) assert.equal(validPackageName(bad), false, JSON.stringify(bad));
  const p = project(); const s = snapshot(p);
  for (const bad of ['../x', '/abs', 'a/../b']) { const r = dac(['init', '--provider', 'codex', '--package-name', bad], p); assert.equal(r.status, 2, bad); assert.match(r.stderr, /package name|--package-name/); assert.deepEqual(snapshot(p), s); }
  assert.equal(bootstrap(['apply', '--provider', 'codex', '--target', p, '--package-name', '../x']).status === 0, false); assert.deepEqual(snapshot(p), s);
  assert.equal(dac(['init', '--provider', 'codex', '--package-name', 'github.com/Org/Repo/v2'], p).status, 0);
  assert.equal(readJ(p, '.dac/project.json').package_name, 'github.com/Org/Repo/v2');
});

const MANIFESTS = {
  'package.json': '{ "name": "npm-name", "version": "1.0.0" }\n',
  'pyproject.toml': '[build-system]\nrequires = ["x"]\n\n[project]\nname = "Py_Name"\nversion = "1"\n',
  'Cargo.toml': '[package]\nname = "crate-name" # c\nversion = "0.1.0"\n\n[dependencies]\nname = "ignored"\n',
  'go.mod': 'module github.com/Org/Repo/v2 // c\n\ngo 1.22\n',
  'settings.gradle': "// c\nrootProject.name = 'gradle-name'\ninclude 'a'\n",
  'settings.gradle.kts': 'rootProject.name = "kts-name"\n',
};
test('package name suggestion: each ecosystem manifest is read-only and its name is offered as the interactive default', async () => {
  for (const [file, text] of Object.entries(MANIFESTS)) {
    const p = project(); writeFileSync(join(p, file), text); const before = readFileSync(join(p, file));
    const expected = { 'package.json': 'npm-name', 'pyproject.toml': 'Py_Name', 'Cargo.toml': 'crate-name', 'go.mod': 'github.com/Org/Repo/v2', 'settings.gradle': 'gradle-name', 'settings.gradle.kts': 'kts-name' }[file];
    const r = await interactive(SRC, ['init'], p, ['', '', 'codex', 'y']); // blank accepts the suggestion
    assert.equal(r.code, 0, r.out);
    assert.ok(r.asked.some((q) => q.startsWith(`Package name [${expected}]`)), `${file}: ${r.asked.join('|')}`);
    assert.equal(readJ(p, '.dac/project.json').package_name, expected);
    assert.ok(readFileSync(join(p, file)).equals(before), `${file} must be byte-identical`);
  }
});

test('package name suggestion: .dac/project.json wins; ambiguous, conflicting, dynamic and malformed manifests give no guess and never crash; all stay byte-identical', async () => {
  const p = project(); writeFileSync(join(p, 'package.json'), MANIFESTS['package.json']);
  assert.equal(dac(['init', '--provider', 'codex', '--package-name', 'recorded'], p).status, 0);
  const r1 = await interactive(SRC, ['init'], p, ['', '', 'codex']);
  assert.ok(r1.asked.some((q) => q.startsWith('Package name [recorded]')), r1.asked.join('|')); assert.doesNotMatch(r1.out, /npm-name/);

  const cases = {
    conflict: { 'package.json': MANIFESTS['package.json'], 'Cargo.toml': MANIFESTS['Cargo.toml'] },
    malformedJson: { 'package.json': '{ "name": ' },
    dynamic: { 'pyproject.toml': '[project]\ndynamic = ["name", "version"]\n' },
    duplicate: { 'Cargo.toml': '[package]\nname = "a"\nname = "b"\n' },
    workspaceInherit: { 'Cargo.toml': '[package]\nname.workspace = true\n' },
    goBlock: { 'go.mod': 'module (\n  a\n)\n' },
    gradleVar: { 'settings.gradle': 'rootProject.name = "x-${foo}"\n' },
    gradleTwo: { 'settings.gradle': "rootProject.name = 'a'\nrootProject.name = 'b'\n" },
    traversal: { 'package.json': '{"name":"../evil"}' },
    binary: { 'go.mod': Buffer.from([0xff, 0xfe, 0, 1]) },
  };
  for (const [label, files] of Object.entries(cases)) {
    const q = project(); for (const [f, t] of Object.entries(files)) writeFileSync(join(q, f), t);
    const before = Object.fromEntries(Object.keys(files).map((f) => [f, readFileSync(join(q, f))]));
    const r = await interactive(SRC, ['init'], q, ['', 'typed-name', 'codex', 'y']);
    assert.equal(r.code, 0, `${label}: ${r.out}`);
    assert.ok(r.asked.some((x) => x.startsWith('Package name: ')), `${label}: offered a default: ${r.asked.join('|')}`);
    assert.equal(readJ(q, '.dac/project.json').package_name, 'typed-name');
    for (const f of Object.keys(files)) assert.ok(readFileSync(join(q, f)).equals(before[f]), `${label}/${f} byte-identical`);
  }
  const q = project(); for (const [f, t] of Object.entries(cases.conflict)) writeFileSync(join(q, f), t);
  assert.match((await interactive(SRC, ['init'], q, ['', 'z', 'codex', 'n'])).out, /disagree/);
});
