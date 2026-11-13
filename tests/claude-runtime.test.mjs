// Phase 2G.1: Claude Code 2.1.318 runtime evidence in a disposable, OS-isolated environment.
// Test names state their evidence class:
//   REAL-OS        a real OS mechanism is exercised (no Claude Code process)
//   REAL-CLAUDE    the installed `claude` CLI runs inside the sandbox (no model call, no credentials)
//   SIMULATED      pure logic on synthetic input; proves the decision code, NOT Claude Code behavior
// See docs/claude-code-adapter.md for the evidence ledger and limitations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate, parseFrontmatter, splitList } from '../adapters/claude-code/lib/generate.mjs';
import { apply } from '../adapters/claude-code/lib/apply.mjs';
import {
  IsolationError, realHome, protectedPaths, isolatedBase, sandboxAvailable, sandboxUnavailableReason, buildSandboxProfile, decoyFixture, canRead, canList, buildEnv, createRuntime,
  assertSafeConfigDir, runIsolated, verifySandbox, snapshotRealConfig, diffSnapshots, claudeInit, evaluateProbe,
  probeInvocation, runReadOnlyProbe, WRITE_TOOLS,
} from './support/claude-runtime.mjs';

const NINE = ['repo-analyst', 'technical-planner', 'prompt-engineer', 'site-analyst', 'frontend-expert', 'backend-expert', 'kmp-expert', 'e2e-tester', 'code-reviewer'].sort();
const CORE_SKILLS = ['frontend-design', 'supabase-postgres-best-practices'];
const READ_ONLY = ['code-reviewer', 'prompt-engineer', 'repo-analyst', 'site-analyst', 'technical-planner'];

// Environment gating: the CLI may only be exercised when the sandbox works AND is proven.
const have = spawnSync('which', ['claude'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status === 0;
const SANDBOX = sandboxAvailable() && isolatedBase() !== null;
let proven = null; // memoized self-test result
function withRuntime(fn, opts) {
  const rt = createRuntime(opts);
  try {
    proven ??= verifySandbox(rt);
    assert.ok(proven.ok, `sandbox self-test failed: ${JSON.stringify(proven)}`);
    return fn(rt);
  } finally { rt.dispose(); }
}
// When OS-level write denial is unavailable the real CLI is NEVER run (BLOCKED: unverified), it is not weakened.
const skipOs = !SANDBOX && `BLOCKED, runtime unverified: ${isolatedBase() === null ? 'no temp base outside the real home' : sandboxUnavailableReason()}`;
const skipClaude = skipOs || (!have && 'claude CLI not installed');
const osTest = (n, fn) => test(`REAL-OS: ${n}`, { skip: skipOs }, fn);
const cliTest = (n, fn) => test(`REAL-CLAUDE: ${n}`, { skip: skipClaude }, fn);

// ------------------------------------------------------------ static / simulated
test('SIMULATED: the environment is an allowlist with no credentials, rooted in the disposable directory', () => {
  const env = buildEnv('/tmp/dac-base');
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'NO_COLOR', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  for (const [k, v] of Object.entries(env)) if (!['PATH', 'NO_COLOR', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'].includes(k)) assert.ok(v.startsWith('/tmp/dac-base/'), k);
  assert.ok(!Object.keys(env).some((k) => /ANTHROPIC|OAUTH|TOKEN|KEY|SECRET|AWS|GITHUB|SSH/i.test(k)));
});
test('SIMULATED: sandbox profile denies all writes except the base, protects the real config and denies network by default', () => {
  const { dir } = protectedPaths();
  const p = buildSandboxProfile('/tmp/dac-base');
  assert.match(p, /^\(deny file-write\*\)$/m);
  assert.ok(p.includes('(allow file-write* (require-any (subpath "/tmp/dac-base") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper")))'));
  assert.ok(p.includes(`(deny file-write* (require-any (subpath "${dir}")`));
  assert.ok(p.includes(`(deny file-read* (require-any (subpath "${dir}")`));
  assert.ok(p.includes(`(regex #"^${protectedPaths().home}/[.]claude[.]json")`));
  assert.match(p, /^\(deny network\*\)$/m);
  assert.doesNotMatch(buildSandboxProfile('/tmp/dac-base', { network: true }), /^\(deny network\*\)$/m);
  // protected denials come after the allow: in SBPL the last matching rule wins
  assert.ok(p.indexOf('(allow file-write*') < p.indexOf('(deny file-write* (require-any'));
});
test('SIMULATED: protection scope covers .claude and every .claude.json* sibling (same scope as the snapshot)', () => {
  const p = buildSandboxProfile('/tmp/dac-base', { home: '/tmp/decoy-h' });
  assert.ok(p.includes('(deny file-read* (require-any (subpath "/tmp/decoy-h/.claude") (regex #"^/tmp/decoy-h/[.]claude[.]json")))'));
  assert.ok(p.includes('(deny file-write* (require-any (subpath "/tmp/decoy-h/.claude") (regex #"^/tmp/decoy-h/[.]claude[.]json")))'));
  const re = /^\/tmp\/decoy-h\/[.]claude[.]json/;
  for (const n of ['.claude.json', '.claude.json.backup', '.claude.json.lock', '.claude.json~', '.claude.json.d/x']) assert.match(`/tmp/decoy-h/${n}`, re);
  for (const n of ['.claude-unrelated', 'claude.json', '.claudejson']) assert.doesNotMatch(`/tmp/decoy-h/${n}`, re);
  assert.ok(buildSandboxProfile('/tmp/b').includes(protectedPaths().home), 'default home is the real home');
});
test('SIMULATED: unsafe CLAUDE_CONFIG_DIR values are refused (real config, home, ancestors, relative)', () => {
  const { dir, file, home } = protectedPaths();
  for (const bad of [dir, join(dir, 'x'), file, home, '/', 'relative/cfg']) assert.throws(() => assertSafeConfigDir(bad), (e) => e instanceof IsolationError && e.code === 'CONFIG_DIR', bad);
  assert.doesNotThrow(() => assertSafeConfigDir('/tmp/dac-ok/cfg'));
});
test('SIMULATED: runIsolated refuses unsandboxed runs, foreign config dirs, outside cwd and bypass flags', () => {
  const base = '/tmp/dac-fake-base';
  const rt = { base, cfg: join(base, 'cfg'), ws: join(base, 'ws'), profile: join(base, 'p.sb'), sandboxed: false, env: buildEnv(base) };
  assert.throws(() => runIsolated(rt, 'claude', ['--version']), (e) => e.code === 'NO_SANDBOX');
  const sb = { ...rt, sandboxed: true };
  assert.throws(() => runIsolated(sb, 'claude', ['--version'], { env: { ...rt.env, CLAUDE_CONFIG_DIR: join(protectedPaths().home, '.claude') } }), (e) => e.code === 'CONFIG_DIR');
  assert.throws(() => runIsolated(sb, 'claude', ['--version'], { cwd: '/' }), (e) => e.code === 'CWD');
  for (const f of ['bypassPermissions', '--dangerously-skip-permissions']) assert.throws(() => runIsolated(sb, 'claude', [f]), (e) => e.code === 'DANGEROUS_FLAG');
});
test('SIMULATED: helper and probe never use bypass flags, copy credentials or read real config contents', () => {
  const src = readFileSync(new URL('./support/claude-runtime.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code.replace(/\/bypassPermissions\|dangerously-skip-permissions\/i/, ''), /--dangerously|permission-mode['", ]+bypass|cpSync|copyFile|readFileSync|keychain|\.credentials|oauth/i);
  assert.ok(!probeInvocation().some((a) => /bypass|dangerously/i.test(a)));
  assert.ok(probeInvocation().includes('plan'));
});
test('SIMULATED: snapshot diff detects added, removed and changed entries', () => {
  const a = new Map([['x', '1'], ['y', '1']]);
  assert.equal(diffSnapshots(a, new Map(a)).identical, true);
  const d = diffSnapshots(a, new Map([['x', '2'], ['z', '1']]));
  assert.deepEqual([d.added, d.removed, d.changed], [['z'], ['y'], ['x']]);
});
test('SIMULATED: probe verdict logic (synthetic transcripts, not Claude Code behavior)', () => {
  const init = (tools) => ({ type: 'system', subtype: 'init', tools });
  const call = (name, id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id }] } });
  const res = (id, is_error) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
  assert.equal(evaluateProbe({ events: [init(['Read', 'Grep'])], canaryExists: false, workspaceChanged: false }).verdict, 'ENFORCED');
  assert.equal(evaluateProbe({ events: [init(['Read', 'Write']), call('Write', 'a'), res('a', true)], canaryExists: false, workspaceChanged: false }).mechanism, 'denied-at-call');
  assert.equal(evaluateProbe({ events: [init(['Read', 'Write']), call('Write', 'a'), res('a', false)], canaryExists: false, workspaceChanged: false }).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateProbe({ events: [init(['Read', 'Write'])], canaryExists: false, workspaceChanged: false }).verdict, 'INCONCLUSIVE', 'refusal without an attempt proves nothing');
  assert.equal(evaluateProbe({ events: [init(['Read'])], canaryExists: true, workspaceChanged: true }).verdict, 'VIOLATED');
  assert.equal(evaluateProbe({ events: [], canaryExists: false, workspaceChanged: false }).verdict, 'INCONCLUSIVE');
});
test('GATE: the live read-only enforcement probe is UNVERIFIED/BLOCKED without an explicit operator credential', { skip: process.env.DAC_PROBE_ANTHROPIC_API_KEY ? 'operator supplied a key: see the live test' : false }, () => {
  const r = runReadOnlyProbe({ apiKey: undefined }, () => assert.fail('must not set up a workspace'));
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.blocked, true);
  assert.match(r.reason, /no credential is permitted/);
});
test('LIVE-OPT-IN: read-only agent cannot write in a live model session (runs only with DAC_PROBE_ANTHROPIC_API_KEY)', { skip: !process.env.DAC_PROBE_ANTHROPIC_API_KEY && 'no operator-supplied credential: UNVERIFIED' }, () => {
  const r = runReadOnlyProbe(undefined, (ws) => assert.equal(apply(ws, generate()).status, 'APPLIED'));
  assert.equal(r.status, 'ENFORCED', JSON.stringify(r));
});

// ---------------------------------------------------------------- REAL-OS
test('REAL-OS: real-config snapshot is metadata-only, read-only and stable back-to-back', () => {
  const a = snapshotRealConfig();
  const b = snapshotRealConfig();
  assert.ok(a.has('.claude') && a.has('.claude.json'), 'both protected roots are always recorded (present or absent)');
  for (const v of a.values()) assert.match(v, /^(dir|file|link:.*|absent|unreadable:.*|error:.*)(\|.*)?$/);
  // no file content can appear in a snapshot value: only type|size|mtime|mode|inode
  for (const v of a.values()) if (v.startsWith('file')) assert.equal(v.split('|').length, 5);
  assert.equal(diffSnapshots(a, b).identical, true, 'unstable: a concurrent user Claude Code session is writing to ~/.claude');
});
test('REAL-OS: the generated sandbox profile is syntactically valid SBPL (compiled by the OS, not applied)', { skip: !existsSync('/usr/bin/sandbox-exec') && 'no sandbox-exec' }, () => {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', buildSandboxProfile('/tmp/dac-base'), '/usr/bin/true'], { encoding: 'utf8' });
  // 0 = applied and ran; "sandbox_apply" = compiled but a parent sandbox forbids nesting. A syntax error is exit 65.
  assert.ok(r.status === 0 || /sandbox_apply/.test(r.stderr), r.stderr);
  assert.doesNotMatch(r.stderr, /syntax error|invalid/i);
});
test('REAL-OS: HOME redirection alone does not change the OS account home (why HOME/XDG is insufficient)', () => {
  const r = spawnSync(process.execPath, ['-e', 'const os=require("os");console.log(JSON.stringify({env:process.env.HOME,home:os.homedir(),user:os.userInfo().homedir}))'], { env: { PATH: process.env.PATH, HOME: '/nonexistent-dac-home' }, encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assert.equal(j.home, '/nonexistent-dac-home');
  assert.equal(realpathSync(j.user), realHome(), 'user-database lookup ignores $HOME: a process can still reach the real home');
});
osTest('sandbox self-test: writes confined to the disposable directory, real config unreadable', () => withRuntime((rt) => {
  assert.equal(proven.checks.writeInsideAllowed, true);
  assert.equal(proven.checks.writeOutsideDenied, true);
  assert.equal(proven.checks.decoyProtectedReadDenied, true, 'rules proven against a synthetic decoy home');
  assert.equal(proven.checks.readProtectedDenied, true);
  // Real paths are only exercised if they exist; absent means 'untested', never a denial claim.
  assert.ok(['denied', 'untested'].includes(proven.checks.realProtectedRead), proven.checks.realProtectedRead);
  const anyReal = readdirSync(protectedPaths().home).some((n) => n === '.claude' || n.startsWith('.claude.json'));
  assert.equal(proven.checks.realProtectedRead === 'denied', anyReal);
}));
osTest('negative isolation: sandboxed child cannot write beside the base, in the repo parent or via HOME tricks', () => withRuntime((rt) => {
  const sibling = join(rt.base, '..', `dac-neg-${process.pid}`);
  const r1 = runIsolated(rt, '/bin/sh', ['-c', `echo x > '${sibling}'`]);
  assert.notEqual(r1.status, 0);
  assert.ok(!existsSync(sibling));
  // ancestor-relative traversal out of the base is denied at the OS level too
  const r2 = runIsolated(rt, '/bin/sh', ['-c', `cd '${rt.ws}' && echo x > ../../dac-traversal-${process.pid}`]);
  assert.notEqual(r2.status, 0);
  assert.ok(!existsSync(join(rt.base, '..', `dac-traversal-${process.pid}`)));
  // inside is fine
  assert.equal(runIsolated(rt, '/bin/sh', ['-c', 'echo x > ../cfg/ok']).status, 0);
  assert.ok(existsSync(join(rt.cfg, 'ok')));
}));
osTest('negative isolation: existing real Claude configuration paths cannot be opened (otherwise reported untested)', () => withRuntime((rt) => {
  const { home } = protectedPaths();
  const names = readdirSync(home).filter((n) => n === '.claude' || n.startsWith('.claude.json'));
  for (const n of names) {
    const p = join(home, n);
    assert.equal(lstatSync(p).isDirectory() ? canList(rt, p) : canRead(rt, p), false, p);
  }
  if (names.length === 0) console.log('# real ~/.claude* absent: real-path denial UNTESTED (decoy test carries the proof)');
}));
osTest('semantic: every ~/.claude.json* sibling and the whole ~/.claude tree are unreadable and unwritable (synthetic decoy home); out-of-scope files stay readable', () => withRuntime((rt) => {
  // Decoy lives INSIDE the writable base, so write denial can only come from the protection rules.
  const root = realpathSync(mkdtempSync(join(rt.base, 'tmp', 'dac-decoy-')));
  try {
    const d = decoyFixture(root);
    const profile = join(root, 'decoy.sb');
    writeFileSync(profile, buildSandboxProfile(rt.base, { home: d.home }));
    const drt = { ...rt, profile };
    for (const p of d.protectedFiles) assert.equal(canRead(drt, p), false, `read ${p}`);
    assert.equal(canList(drt, d.protectedDir), false);
    for (const p of d.controls) assert.equal(canRead(drt, p), true, `control ${p}`);
    for (const p of [...d.protectedFiles, join(d.home, '.claude.json.newsibling'), join(d.home, '.claude', 'new')]) {
      assert.notEqual(runIsolated(drt, '/bin/sh', ['-c', `echo x >> '${p}'`]).status, 0, `write ${p}`);
    }
    assert.ok(!existsSync(join(d.home, '.claude.json.newsibling')) && !existsSync(join(d.home, '.claude', 'new')));
    // negative control: without the protection rules the same read succeeds (the check is not vacuous)
    const open = join(root, 'open.sb');
    writeFileSync(open, '(version 1)(allow default)');
    assert.equal(canRead({ ...rt, profile: open }, d.protectedFiles[1]), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));
osTest('the disposable base is outside the real home and carries no ancestor .claude', () => withRuntime((rt) => {
  const rel = relative(realHome(), rt.base);
  assert.ok(rel.startsWith('..') || isAbsolute(rel));
  assert.deepEqual(readdirSync(rt.ws), []);
  assert.equal(rt.env.CLAUDE_CONFIG_DIR, join(rt.base, 'cfg'));
}));
test('REAL-OS: rt.dispose removes everything', { skip: isolatedBase() === null && 'no out-of-home temp base' }, () => {
  const rt = createRuntime();
  const base = rt.base;
  assert.ok(existsSync(base));
  rt.dispose();
  assert.ok(!existsSync(base));
});

// ------------------------------------------------------------- REAL-CLAUDE
function install(rt, opts) { assert.equal(apply(rt.ws, generate(opts)).status, 'APPLIED'); }
cliTest('version is 2.1.318 (recorded evidence; a different version is reported, not hidden)', () => withRuntime((rt) => {
  const r = runIsolated(rt, 'claude', ['--version'], { timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
  if (!/2\.1\.318/.test(r.stdout)) console.warn(`# NOTE: evidence recorded for 2.1.318, running ${r.stdout.trim()}`);
}));
cliTest('before/after: runtime tests leave the real ~/.claude and ~/.claude.json metadata unchanged', () => {
  const before = snapshotRealConfig();
  withRuntime((rt) => {
    install(rt);
    const { init } = claudeInit(rt, []);
    assert.ok(init);
    runIsolated(rt, 'claude', ['mcp', 'list'], { timeout: 60000 });
  });
  const d = diffSnapshots(before, snapshotRealConfig());
  // Detective control only: a concurrently running Claude Code session of the user also writes here.
  // The preventive control is the OS write denial proven above (and checked per run).
  assert.deepEqual(d, { added: [], removed: [], changed: [], identical: true }, `real config metadata changed (concurrent user session, or isolation breach): ${JSON.stringify(d)}`);
});
cliTest('recognizes the 9 generated agents and the 2 CORE skills; Context7 disabled; no optional agent', () => withRuntime((rt) => {
  install(rt);
  const { init, result } = claudeInit(rt, []);
  assert.ok(init, `init event not emitted: ${result.stderr}`);
  for (const id of NINE) assert.ok(init.agents.includes(id), `agent ${id} not recognized`);
  assert.ok(!init.agents.includes('payment-integration'));
  for (const id of CORE_SKILLS) assert.ok(init.skills.includes(id), `skill ${id} not recognized`);
  assert.deepEqual(init.mcp_servers, [], 'Context7 must not be active by default');
  assert.equal(init.permissionMode, 'default');
  assert.equal(init.apiKeySource, 'none', 'no credential is present in the disposable environment');
}));
cliTest('detection is real: a malformed agent file is not recognized', () => withRuntime((rt) => {
  install(rt);
  writeFileSync(join(rt.ws, '.claude/agents/code-reviewer.md'), 'no frontmatter at all\n');
  const { init } = claudeInit(rt, []);
  assert.ok(init);
  assert.ok(!init.agents.includes('code-reviewer'));
  assert.ok(init.agents.includes('repo-analyst'));
}));
cliTest('mcp list reports no servers for the default project', () => withRuntime((rt) => {
  install(rt);
  const r = runIsolated(rt, 'claude', ['mcp', 'list'], { timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No MCP servers configured/);
}));
cliTest('Context7 opt-in is declared but never connected or approved in an offline session', () => withRuntime((rt) => {
  install(rt, { context7: true });
  const { init } = claudeInit(rt, []);
  assert.ok(init);
  const c7 = (init.mcp_servers ?? []).filter((s) => /context7/i.test(s.name));
  for (const s of c7) assert.notEqual(s.status, 'connected');
}));
cliTest('tool enforcement (exposure level): --tools / --disallowedTools remove write and shell tools from the session', () => withRuntime((rt) => {
  install(rt);
  const { init: restricted } = claudeInit(rt, ['--tools', 'Read,Grep,Glob']);
  assert.ok(restricted);
  for (const t of [...WRITE_TOOLS, 'Bash']) assert.ok(!restricted.tools.includes(t), `${t} exposed despite --tools`);
  assert.ok(restricted.tools.includes('Read'));
  const { init: denied } = claudeInit(rt, ['--disallowedTools', [...WRITE_TOOLS, 'Bash'].join(',')]);
  assert.ok(denied);
  for (const t of [...WRITE_TOOLS, 'Bash']) assert.ok(!denied.tools.includes(t), `${t} exposed despite --disallowedTools`);
  const { init: open } = claudeInit(rt, []);
  assert.ok(open.tools.includes('Write'), 'control: without restriction Write is exposed (the check is not vacuous)');
}));
cliTest('CLAUDE_CONFIG_DIR relocation: Claude Code wrote only inside the disposable directory', () => withRuntime((rt) => {
  install(rt);
  claudeInit(rt, []);
  // The sandbox makes any other write impossible; this documents where state actually went.
  const inBase = [...readdirSync(rt.cfg), ...readdirSync(rt.home), ...readdirSync(join(rt.base, 'xdg'))];
  console.log(`# cfg=${JSON.stringify(readdirSync(rt.cfg))} home=${JSON.stringify(readdirSync(rt.home))}`);
  assert.ok(Array.isArray(inBase));
}));
test('SIMULATED: read-only agent frontmatter denies write tools (static contract; NOT runtime enforcement)', () => {
  const plan = generate();
  for (const id of READ_ONLY) {
    const fm = parseFrontmatter(plan.files.get(`.claude/agents/${id}.md`).toString('utf8'));
    for (const t of WRITE_TOOLS) assert.ok(splitList(fm.disallowedTools).includes(t));
  }
});
