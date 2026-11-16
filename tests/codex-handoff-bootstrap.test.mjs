// Codex SDD-handoff integration through the existing project bootstrap (createInstaller / executeActions journal, manifests, .dac records).
// It reuses the runtime already integrated for Claude Code (.dac/runtime/sdd-handoff, custodian, Writer); there is no Codex-specific broker or writer.
// Disposable projects only; the standards checkout is a throw-away Git copy (clean-source gate). This file never installs or executes a Codex binary:
// runtime compatibility with a real Codex session is UNVERIFIED. What is proven here is the generated native config text, ownership, restrictions,
// and that the exact launcher recorded in `.codex/config.toml` starts the real proxy and talks to a real custodian.
// Evidence classes: [BOOT] bootstrap API on a disposable project, [PROC] real child processes + real Unix sockets, [UNIT] in-process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, cpSync, existsSync, readlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { startCustodian } from '../adapters/shared/sdd-handoff/custodian.mjs';
import { withLease } from '../adapters/shared/sdd-handoff/client.mjs';
import { plan as writerPlan, apply as writerApply, verify as writerVerify } from '../adapters/shared/sdd-writer/writer.mjs';
import { generatePortable, verifyPortable } from '../adapters/shared/portable.mjs';
import { RUNTIME_DIR, RUNTIME_DIR_ENV, SERVER_NAME, runtimeFiles } from '../adapters/shared/sdd-handoff/claude-config.mjs';
import { CODEX_TOOL, codexServerToml, handoffInstructions } from '../adapters/shared/sdd-handoff/codex-config.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-xh-')));
const shortBase = realpathSync(mkdtempSync('/tmp/dx-'));
const closers = []; const children = [];
after(async () => {
  for (const c of closers) await c().catch(() => {});
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true }); rmSync(shortBase, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label) => { const d = join(scratch, `${label}-${counter++}`); mkdirSync(d); return d; };
const runtimeDir = () => { const d = join(shortBase, `r${counter++}`); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); return d; };
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const template = fresh('template');
for (const f of execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (!existsSync(join(REPO_ROOT, f))) continue;
  mkdirSync(dirname(join(template, f)), { recursive: true });
  cpSync(join(REPO_ROOT, f), join(template, f));
}
git(template, 'init', '-q', '-b', 'main'); git(template, 'add', '-A'); git(template, 'commit', '-q', '-m', 'base');

async function source() {
  const dir = fresh('src');
  cpSync(template, dir, { recursive: true });
  const api = await import(pathToFileURL(join(dir, 'installer/bootstrap.mjs')).href);
  const cli = (args, env = {}) => spawnSync(process.execPath, [join(dir, 'installer/bootstrap.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const change = (file, fn, msg = 'change') => { writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8'))); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
  return { dir, api, cli, change };
}
const target = () => fresh('target');
const sha = (b) => createHash('sha256').update(b).digest('hex');
function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n); const r = rel ? `${rel}/${n}` : n; const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(p)}`;
      else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = sha(readFileSync(p));
    }
  };
  walk(root, '');
  return out;
}
const only = (snap, prefix) => Object.fromEntries(Object.entries(snap).filter(([k]) => k === prefix || k.startsWith(`${prefix}/`)));
const without = (snap, ...prefixes) => Object.fromEntries(Object.entries(snap).filter(([k]) => !prefixes.some((p) => k === p || k.startsWith(`${p}/`))));
const read = (root, p) => readFileSync(join(root, p), 'utf8');
const readJ = (root, p) => JSON.parse(read(root, p));
const codexApply = (s, t, o = {}, extra = {}) => s.api.apply({ target: t, providers: ['codex'], options: { sddHandoff: true, ...o }, ...extra });
const RT_FILES = ['client.mjs', 'core.mjs', 'endpoint.mjs', 'errors.mjs', 'identity.mjs', 'mcp-server.mjs'];
const RUNTIME = RT_FILES.map((f) => `${RUNTIME_DIR}/${f}`);
const PID = 'demo-project';
const constitution = () => ({ kind: 'sdd-constitution', schema_version: '1.0', project_id: PID, principles: [{ id: 'p-one', statement: 'Ship small, verified changes.' }], constraints: [{ id: 'c-one', statement: 'No secrets in the repository.' }] });
const specify = () => ({ kind: 'sdd-specify', schema_version: '1.0', project_id: PID, requirements: [{ id: 'req-1', statement: 'Users can log in.', acceptance_criteria: ['ac-1'], open_questions: [] }], acceptance_criteria: [{ id: 'ac-1', requirement: 'req-1', statement: 'Valid credentials open a session.', verification: 'integration test' }] });
const envelope = () => ({ project_id: PID, operation: 'create', constitution: constitution(), specify: specify() });
const projectOwnedSdd = (t) => { mkdirSync(join(t, '.sdd/notes'), { recursive: true }); writeFileSync(join(t, '.sdd/notes/keep.md'), 'project-owned é\r\n\u0000bytes'); writeFileSync(join(t, '.sdd/README'), 'x'); };
// The `[mcp_servers.dac-sdd-handoff]` table of the generated config (values are JSON-compatible TOML basic strings/arrays).
const serverTable = (cfg) => { const m = /^\[mcp_servers\.dac-sdd-handoff\]\n((?:[^\[\n][^\n]*\n)*)/m.exec(cfg); assert.ok(m, 'server table present'); return Object.fromEntries(m[1].trim().split('\n').map((l) => { const i = l.indexOf(' = '); return [l.slice(0, i), JSON.parse(l.slice(i + 3))]; })); };

// ---- 1 clean install lifecycle ------------------------------------------------------------------------------------------------
test('[BOOT] clean project: plan -> apply -> verify -> idempotent re-apply -> update -> uninstall; runtime owned by the codex manifest; no writes outside the managed scope', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t); const home = fresh('home'); const homeBefore = snapshot(home);
  const sddBefore = only(snapshot(t), '.sdd');
  const p = s.api.plan({ providers: ['codex'], options: { sddHandoff: true }, target: t });
  for (const f of RUNTIME) assert.ok(p.files.codex.includes(f), f);
  assert.ok(p.files.codex.includes('.codex/config.toml')); assert.equal(p.target.status, 'DRY_RUN'); assert.deepEqual(snapshot(t), sddBefore, 'plan writes nothing');
  assert.equal(s.api.plan({ providers: ['codex'], target: t }).files.codex.some((f) => f.startsWith('.dac/runtime')), false, 'not part of the default install');
  // [BOOT] via the CLI with a clean env and a throw-away HOME: no global writes, no manual sdd-input.json
  const cli = s.cli(['apply', '--provider', 'codex', '--sdd-handoff', '--target', t], { HOME: home }); assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(snapshot(home), homeBefore, 'no global/user profile writes'); assert.equal(git(s.dir, 'status', '--porcelain'), '', 'standards checkout untouched');
  assert.equal(existsSync(join(t, 'sdd-input.json')), false, 'no manual sdd-input.json is created or required');
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  const man = readJ(t, '.codex/dac-manifest.json'); assert.equal(man.sdd_handoff, true); assert.deepEqual(man.shared_paths, ['AGENTS.md']);
  for (const f of [...RUNTIME, '.codex/config.toml']) assert.ok(man.files.some((x) => x.path === f && x.sha256 === sha(readFileSync(join(t, f)))), f);
  assert.equal(readJ(t, '.dac/standard.json').providers.codex.sdd_handoff, true);
  assert.deepEqual(readdirSync(join(t, RUNTIME_DIR)).sort(), RT_FILES);
  // the complete set of written paths = manifest files + manifest + shared AGENTS.md + .dac records (+ .sdd untouched)
  const allowed = new Set([...man.files.map((f) => f.path), '.codex/dac-manifest.json', 'AGENTS.md', '.dac/standard.json', '.dac/shared.json']);
  for (const [f, v] of Object.entries(without(snapshot(t), '.sdd'))) if (v !== 'dir') assert.ok(allowed.has(f), `unexpected file ${f}`);
  assert.equal(existsSync(join(t, '.mcp.json')) || existsSync(join(t, '.claude')) || existsSync(join(t, '.cursor')), false, 'no other provider files');
  // idempotence, update keeps the recorded option
  const before = snapshot(t); assert.equal(codexApply(s, t).status, 'UNCHANGED'); assert.deepEqual(snapshot(t), before);
  assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
  s.change('VERSION', (x) => x.trim() + '.1\n'); const u = s.api.update({ target: t }); assert.equal(u.status, 'APPLIED'); assert.ok(u.updated.includes('.dac/standard.json'));
  assert.equal(s.api.verify({ target: t }).status, 'OK'); assert.equal(readJ(t, '.codex/dac-manifest.json').sdd_handoff, true);
  assert.deepEqual(only(snapshot(t), '.sdd'), sddBefore, '.sdd untouched by apply/update');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED');
  assert.deepEqual(snapshot(t), sddBefore, 'only .sdd remains, byte-for-byte'); assert.equal(existsSync(join(t, '.dac')), false);
});

test('[BOOT] update of an existing Codex project (installed without handoff): update never enables it; explicit apply adds it; disabling restores the exact prior bytes', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t);
  assert.equal(s.api.apply({ target: t, providers: ['codex'], options: { context7: true } }).status, 'APPLIED');
  const plain = snapshot(t); assert.equal(existsSync(join(t, RUNTIME_DIR)), false); const sdd = only(plain, '.sdd');
  s.change('VERSION', (x) => x.trim() + '.2\n'); assert.equal(s.api.update({ target: t }).status, 'APPLIED'); assert.equal(existsSync(join(t, RUNTIME_DIR)), false, 'update does not opt in');
  const plainAfterUpdate = snapshot(t);
  const add = codexApply(s, t, { context7: true }); assert.equal(add.status, 'APPLIED', JSON.stringify(add.conflicts));
  assert.ok(add.updated.includes('.codex/config.toml') && add.updated.includes('.codex/agents/technical-planner.toml') && add.updated.includes('.codex/dac-manifest.json'));
  assert.deepEqual(add.created.sort(), RUNTIME.slice().sort());
  const cfg = read(t, '.codex/config.toml');
  assert.match(cfg, /^\[mcp_servers\.context7\]\nurl = "https:\/\/[^"]+"\nenabled = false$/m, 'context7 stays an inert, disabled template');
  assert.deepEqual([...cfg.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)].map((m) => m[1]).sort(), ['context7', SERVER_NAME]);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  const off = s.api.apply({ target: t, providers: ['codex'], options: { context7: true } }); assert.equal(off.status, 'APPLIED');
  assert.deepEqual(off.removed.sort(), RUNTIME.slice().sort()); assert.equal(existsSync(join(t, '.dac/runtime')), false, 'emptied runtime dirs are pruned');
  assert.deepEqual(snapshot(t), plainAfterUpdate, 'disabling returns every managed byte to the pre-handoff state');
  assert.equal(readJ(t, '.dac/standard.json').providers.codex.sdd_handoff, undefined); assert.equal(s.api.verify({ target: t }).status, 'OK');
  assert.deepEqual(only(snapshot(t), '.sdd'), sdd);
});

// ---- 2 config and tool restrictions --------------------------------------------------------------------------------------------
test('[UNIT] native Codex config: exactly one MCP server, fixed launcher and runtime from the environment, one exposed tool, read-only defaults, no extra grant', () => {
  const p = generatePortable('codex', { sddHandoff: true }); const base = generatePortable('codex');
  assert.equal(verifyPortable('codex', p), true); assert.deepEqual(p, generatePortable('codex', { sddHandoff: true }), 'deterministic');
  const cfg = p.files.get('.codex/config.toml').toString();
  assert.equal(cfg, base.files.get('.codex/config.toml').toString() + '\n' + codexServerToml(), 'the option only appends the one server table');
  assert.deepEqual([...cfg.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)].map((m) => m[1]), [SERVER_NAME]);
  const t = serverTable(cfg);
  assert.deepEqual(t, { command: 'sh', args: ['-c', `exec node ${RUNTIME_DIR}/mcp-server.mjs --target . --runtime-dir "$${RUNTIME_DIR_ENV}"`], env_vars: [RUNTIME_DIR_ENV], enabled: true, enabled_tools: [CODEX_TOOL] });
  assert.equal(CODEX_TOOL, 'sdd_handoff_submit'); assert.deepEqual(t.enabled_tools, ['sdd_handoff_submit']);
  // target is fixed `.`, runtime dir is an env reference: neither is a model argument; no endpoint/target is configurable by the model
  assert.ok(t.args[1].includes('--target .') && t.args[1].includes(`"$${RUNTIME_DIR_ENV}"`)); assert.ok(!/\/(Users|home|private|var\/folders|tmp)\//.test(cfg));
  // read-only defaults of the pre-existing config are unchanged and nothing grants shell/write/apply/approval
  assert.match(cfg, /^sandbox_mode = "read-only"$/m); assert.match(cfg, /^approval_policy = "never"$/m); assert.match(cfg, /^shell_tool = false$/m); assert.match(cfg, /^web_search = "disabled"$/m);
  assert.doesNotMatch(cfg, /danger-full-access|workspace-write|approval_policy = "(on-|untrusted|always)|shell_tool = true|bypass|sandbox_mode = "(?!read-only)/);
  assert.doesNotMatch(cfg, /^(tools|allowed_tools|approval_mode|auto_approve)\b/m); assert.doesNotMatch(cfg, /apply_patch|approve_all|\bWrite\b|\bEdit\b/);
  // every Codex agent stays read-only; only technical-planner gains the handoff instruction; all others are byte-identical to the default install
  for (const [f, b] of p.files) {
    if (!/^\.codex\/agents\/.+\.toml$/.test(f)) continue;
    assert.match(b.toString(), /^sandbox_mode = "read-only"$/m, f); assert.match(b.toString(), /^approval_policy = "never"$/m, f); assert.match(b.toString(), /^shell_tool = false$/m, f);
    if (f === '.codex/agents/technical-planner.toml') { assert.notDeepEqual(b, base.files.get(f)); assert.ok(b.toString().includes(CODEX_TOOL)); assert.ok(b.toString().includes('never run, paraphrase or auto-confirm')); } else assert.deepEqual(b, base.files.get(f), f);
  }
  assert.match(handoffInstructions(), /BLOCKED/);
  // outside the handoff files and these two Codex files, the plan equals the default plan
  const diff = [...p.files.keys()].filter((k) => !base.files.has(k) || !base.files.get(k).equals(p.files.get(k))).sort();
  assert.deepEqual(diff, ['.codex/agents/technical-planner.toml', '.codex/config.toml', '.codex/dac-manifest.json', ...RUNTIME].sort());
  assert.deepEqual(base.files.get('AGENTS.md'), p.files.get('AGENTS.md'));
  assert.ok(!/handoff/i.test(p.files.get('AGENTS.md').toString()) && !generatePortable('codex', { neutralAgents: true, sddHandoff: true }).files.has('AGENTS.md'));
  // the runtime is byte-identical to what Claude Code installs (no provider-specific copy, broker or writer)
  for (const [path, buf] of runtimeFiles()) assert.deepEqual(p.files.get(path), buf, path);
  assert.deepEqual([...p.files.keys()].filter((k) => k.startsWith('.dac/')).sort(), RUNTIME.slice().sort());
  // option validation
  assert.throws(() => generatePortable('codex', { sddHandoff: 'yes' }), { code: 'OPTIONS' }); assert.throws(() => generatePortable('codex', { handoff: true }), { code: 'OPTIONS' });
});

test('[UNIT] tampering with the handoff plan is rejected by the canonical verifier (extra server, widened tool list, extra file, forged flag)', () => {
  const good = generatePortable('codex', { sddHandoff: true });
  const mutate = (fn) => { const p = generatePortable('codex', { sddHandoff: true }); fn(p); return p; };
  const cfgOf = (p) => p.files.get('.codex/config.toml').toString();
  const cases = [
    (p) => p.files.set('.codex/config.toml', Buffer.from(cfgOf(p).replace('enabled_tools = ["sdd_handoff_submit"]', 'enabled_tools = ["sdd_handoff_submit", "other"]'))),
    (p) => p.files.set('.codex/config.toml', Buffer.from(cfgOf(p) + '\n[mcp_servers.evil]\ncommand = "sh"\n')),
    (p) => p.files.set('.codex/config.toml', Buffer.from(cfgOf(p).replace('sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'))),
    (p) => p.files.set(`${RUNTIME_DIR}/extra.mjs`, Buffer.from('x')),
    (p) => p.files.set(`${RUNTIME_DIR}/client.mjs`, Buffer.from('// replaced\n')),
    (p) => { p.manifest.sdd_handoff = false; },
  ];
  for (const [i, fn] of cases.entries()) assert.throws(() => verifyPortable('codex', mutate(fn)), { code: 'PLAN_INVALID' }, `case ${i}`);
  assert.equal(verifyPortable('codex', good), true);
});

test('[PROC] the exact generated launcher starts the real proxy from the project root: one tool, no target/runtime argument, fail closed without the environment variable', async () => {
  const s = await source(); const t = realpathSync(target()); assert.equal(codexApply(s, t).status, 'APPLIED');
  const tbl = serverTable(read(t, '.codex/config.toml')); const rt = runtimeDir();
  const launch = (env) => spawn(tbl.command, tbl.args, { cwd: t, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: scratch, ...env } });
  const rpcOn = (child) => {
    children.push(child); let buf = ''; let err = ''; let id = 0; const waiters = new Map();
    child.stderr.on('data', (c) => { err += c; }); child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
    const exited = new Promise((r) => child.once('close', (code) => r({ code, err })));
    const rpc = (method, params) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error(`no reply to ${method}: ${err}`)), 20000); waiters.set(i, (m) => { clearTimeout(to); res(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`); });
    return { rpc, exited, child };
  };
  // unset variable => the proxy never starts (empty --runtime-dir); relative => refuses; nothing is written
  assert.equal((await rpcOn(launch({})).exited).code, 2);
  assert.equal((await rpcOn(launch({ [RUNTIME_DIR_ENV]: 'relative/dir' })).exited).code, 1);
  assert.equal(existsSync(join(t, '.sdd')), false);
  const m = rpcOn(launch({ [RUNTIME_DIR_ENV]: rt }));
  const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }); assert.equal(init.result.serverInfo.name, SERVER_NAME);
  const tl = await m.rpc('tools/list', {}); assert.deepEqual(tl.result.tools.map((x) => x.name), [CODEX_TOOL]);
  const props = Object.keys(tl.result.tools[0].inputSchema.properties).sort(); assert.deepEqual(props, ['constitution', 'markdown', 'operation', 'project_id', 'specify']);
  assert.equal(tl.result.tools[0].inputSchema.additionalProperties, false);
  for (const bad of [{ ...envelope(), target: '/etc' }, { ...envelope(), runtime_dir: '/tmp' }, { ...envelope(), apply: true }]) { const r = await m.rpc('tools/call', { name: CODEX_TOOL, arguments: bad }); assert.equal(r.result.isError, true); assert.equal(JSON.parse(r.result.content[0].text).code, 'INPUT'); }
  for (const other of ['sdd_handoff_apply', 'shell', 'write_file']) assert.equal((await m.rpc('tools/call', { name: other, arguments: {} })).error.code, -32602);
  m.child.stdin.end(); await m.exited; assert.equal(existsSync(join(t, '.sdd')), false);
});

// ---- 3 end to end with no manual sdd-input.json ---------------------------------------------------------------------------------
test('[PROC] Codex project end to end with no sdd-input.json: bootstrap -> custodian -> launcher from config.toml -> submit -> Writer apply (--handoff) -> verify; Writer never touches .dac/.codex', async () => {
  const s = await source(); const t = realpathSync(target()); const rt = runtimeDir();
  assert.equal(codexApply(s, t).status, 'APPLIED'); const installed = without(snapshot(t), '.sdd');
  assert.equal(existsSync(join(t, 'sdd-input.json')), false);
  const stub = ({ target, input }) => writerPlan({ target, input, source: () => ({ head: 'a'.repeat(40) }) });
  const c = await startCustodian({ target: t, dir: rt, writePlan: stub }); closers.push(() => c.close());
  const tbl = serverTable(read(t, '.codex/config.toml'));
  const child = spawn(tbl.command, tbl.args, { cwd: t, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: scratch, [RUNTIME_DIR_ENV]: rt } }); children.push(child);
  let buf = ''; let err = ''; const waiters = new Map(); let id = 0; child.stderr.on('data', (x) => { err += x; }); child.stdout.setEncoding('utf8');
  child.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const closed = new Promise((r) => child.once('close', r));
  const rpc = (method, params) => new Promise((res, rej) => { const i = ++id; const to = setTimeout(() => rej(new Error(`no reply to ${method}: ${err}`)), 20000); waiters.set(i, (m) => { clearTimeout(to); res(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const call = await rpc('tools/call', { name: CODEX_TOOL, arguments: envelope() }); assert.equal(call.result.isError, false, JSON.stringify(call.result));
  const body = JSON.parse(call.result.content[0].text); assert.match(body.handoff_id, /^sdd-h2\./); assert.deepEqual(body.files_changed, []);
  assert.ok(body.human_commands.apply.includes('<DAC_CHECKOUT>') && !body.human_commands.apply.includes(REPO_ROOT));
  assert.equal(existsSync(join(t, '.sdd')), false, 'submit writes nothing'); assert.deepEqual(without(snapshot(t), '.sdd'), installed);
  child.stdin.end(); await closed;
  const tty = { calls: 0, confirm() { this.calls++; return true; } };
  const out = await withLease(body.handoff_id, t, (payload) => writerApply({ target: t, input: payload, source: () => ({ head: 'a'.repeat(40) }), terminal: tty }), { dir: rt, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.equal(out.handoff.consumption, 'consumed'); assert.equal(tty.calls, 1, 'approval stays on the human terminal');
  assert.equal(writerVerify({ target: t, projectId: PID }).status, 'OK');
  assert.deepEqual(without(snapshot(t), '.sdd'), installed, 'the Writer changed nothing outside .sdd (.dac and .codex byte-identical)');
  const sdd = only(snapshot(t), '.sdd'); assert.equal(s.api.verify({ target: t }).status, 'OK'); assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED'); assert.deepEqual(snapshot(t), sdd, '.sdd preserved byte-for-byte');
});

test('[UNIT] --input behaviour is unchanged: the Writer CLI still takes --input, rejects --input with --handoff, and approval is not available through the proxy', () => {
  const cli = (...a) => spawnSync(process.execPath, [join(REPO_ROOT, 'adapters/shared/sdd-writer/cli.mjs'), ...a], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: scratch } });
  const t = target(); const f = join(fresh('in'), 'input.json'); writeFileSync(f, JSON.stringify(envelope()));
  const both = cli('plan', '--target', t, '--input', f, '--handoff', 'x'); assert.notEqual(both.status, 0);
  assert.match(cli('--help').stdout + cli('--help').stderr, /--input/);
  assert.equal(existsSync(join(t, '.sdd')), false);
  const proxy = readFileSync(join(REPO_ROOT, 'adapters/shared/sdd-handoff/mcp-server.mjs'), 'utf8');
  assert.ok(!/child_process|writeFile|net\.createServer|\bapply\(|openTrustedTerminal/.test(proxy.replace(/export function createServer/g, '')));
});

// ---- 4 conflicts, rollback, ownership ------------------------------------------------------------------------------------------
test('[BOOT] conflicts fail closed with zero writes: foreign .codex/config.toml, foreign file at a runtime path, symlinked runtime dir, locally edited managed config/runtime file', async () => {
  const s = await source();
  const foreignCfg = target(); mkdirSync(join(foreignCfg, '.codex')); writeFileSync(join(foreignCfg, '.codex/config.toml'), '[mcp_servers.mine]\ncommand = "x"\n');
  const b1 = snapshot(foreignCfg); const r1 = codexApply(s, foreignCfg); assert.equal(r1.status, 'CONFLICT'); assert.ok(r1.conflicts.some((c) => c.path === '.codex/config.toml')); assert.deepEqual(snapshot(foreignCfg), b1);
  const foreignFile = target(); mkdirSync(join(foreignFile, RUNTIME_DIR), { recursive: true }); writeFileSync(join(foreignFile, `${RUNTIME_DIR}/mcp-server.mjs`), '// mine\n');
  const b2 = snapshot(foreignFile); const r2 = codexApply(s, foreignFile); assert.equal(r2.status, 'CONFLICT'); assert.ok(r2.conflicts.some((c) => c.path === `${RUNTIME_DIR}/mcp-server.mjs`)); assert.deepEqual(snapshot(foreignFile), b2);
  const linked = target(); const elsewhere = fresh('elsewhere'); mkdirSync(join(linked, '.dac')); execFileSync('ln', ['-s', elsewhere, join(linked, '.dac/runtime')]);
  const r3 = codexApply(s, linked); assert.equal(r3.status, 'CONFLICT'); assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the symlink');
  const t = target(); assert.equal(codexApply(s, t).status, 'APPLIED');
  for (const f of [`${RUNTIME_DIR}/client.mjs`, '.codex/config.toml']) {
    const abs = join(t, f); const orig = readFileSync(abs); writeFileSync(abs, `${orig}\n# local edit\n`); const b3 = snapshot(t);
    assert.equal(s.api.verify({ target: t }).status, 'DRIFT');
    for (const r of [s.api.update({ target: t }), codexApply(s, t), s.api.uninstall({ target: t, provider: 'codex' })]) { assert.equal(r.status, 'CONFLICT'); assert.ok(r.conflicts.some((c) => c.path === f), f); }
    assert.deepEqual(snapshot(t), b3); writeFileSync(abs, orig);
  }
  assert.equal(s.api.verify({ target: t }).status, 'OK');
});

test('[BOOT] journaled rollback: an injected fault at every step restores the pre-apply state exactly (apply, update, uninstall, disable)', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t);
  const clean = snapshot(t);
  for (const n of [1, 3, 8, 14, 20]) {
    assert.throws(() => codexApply(s, t, {}, { faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true, `apply fault ${n}`);
    assert.deepEqual(snapshot(t), clean, `apply fault ${n}`);
  }
  assert.equal(codexApply(s, t).status, 'APPLIED'); const installed = snapshot(t);
  s.change('VERSION', (x) => x.trim() + '.3\n');
  assert.throws(() => s.api.update({ target: t, faultAfter: 1 }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), installed, 'update fault');
  for (const n of [1, 6, 12]) { assert.throws(() => s.api.uninstall({ target: t, provider: 'codex', faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), installed, `uninstall fault ${n}`); }
  assert.equal(s.api.update({ target: t }).status, 'APPLIED'); const current = snapshot(t); // apply requires the recorded commit, so move to the new commit first
  for (const n of [1, 4]) { assert.throws(() => s.api.apply({ target: t, providers: ['codex'], faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), current, `disable fault ${n}`); }
});

// ---- 5 shared AGENTS.md ownership, other providers, scope ---------------------------------------------------------------------
test('[BOOT] Codex + Cursor share the neutral AGENTS.md: the handoff never changes it; the ledger keeps both owners; uninstall order is correct; Cursor gets nothing', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t); const ref = target();
  assert.equal(s.api.apply({ target: ref, providers: ['codex', 'cursor'] }).status, 'APPLIED'); const agents = read(ref, 'AGENTS.md'); const cursorFiles = only(snapshot(ref), '.cursor');
  const r = s.api.apply({ target: t, providers: ['codex', 'cursor'], options: { sddHandoff: true } }); assert.equal(r.status, 'APPLIED', JSON.stringify(r.conflicts));
  assert.equal(read(t, 'AGENTS.md'), agents, 'AGENTS.md identical with and without the handoff'); assert.deepEqual(only(snapshot(t), '.cursor'), cursorFiles, 'Cursor files byte-identical');
  assert.deepEqual(readJ(t, '.dac/shared.json').files[0].owners, ['codex', 'cursor']); assert.equal(readJ(t, '.dac/shared.json').files[0].sha256, sha(Buffer.from(agents)));
  const std = readJ(t, '.dac/standard.json').providers; assert.equal(std.codex.sdd_handoff, true); assert.equal(std.cursor.sdd_handoff, undefined);
  const cm = readJ(t, '.cursor/dac-manifest.json'); assert.ok(!JSON.stringify(cm).includes('sdd_handoff') && !JSON.stringify(cm).includes('sdd-handoff'));
  for (const f of Object.keys(snapshot(t))) if ((f.startsWith('.cursor/') || f === 'AGENTS.md') && !lstatSync(join(t, f)).isDirectory()) assert.ok(!/sdd[-_]handoff/i.test(read(t, f)), `${f} has no handoff wiring`);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  // uninstalling codex keeps the shared file for cursor, byte-for-byte, and removes every handoff file
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED');
  assert.equal(read(t, 'AGENTS.md'), agents); assert.deepEqual(readJ(t, '.dac/shared.json').files[0].owners, ['cursor']); assert.equal(existsSync(join(t, '.dac/runtime')), false); assert.equal(existsSync(join(t, '.codex')), false);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  // removing the other owner first also works: cursor goes, codex (with handoff) keeps AGENTS.md
  const t2 = target(); s.api.apply({ target: t2, providers: ['codex', 'cursor'], options: { sddHandoff: true } });
  assert.equal(s.api.uninstall({ target: t2, provider: 'cursor' }).status, 'REMOVED'); assert.equal(read(t2, 'AGENTS.md'), agents); assert.equal(s.api.verify({ target: t2 }).status, 'OK'); assert.equal(readJ(t2, '.dac/standard.json').providers.codex.sdd_handoff, true);
  assert.equal(s.api.uninstall({ target: t2, provider: 'codex' }).status, 'REMOVED'); assert.equal(existsSync(join(t2, 'AGENTS.md')), false);
  // a hand-edited shared AGENTS.md still blocks codex uninstall (existing ownership rule)
  const t3 = target(); codexApply(s, t3); writeFileSync(join(t3, 'AGENTS.md'), `${read(t3, 'AGENTS.md')}local\n`); const b = snapshot(t3);
  assert.equal(s.api.uninstall({ target: t3, provider: 'codex' }).status, 'CONFLICT'); assert.deepEqual(snapshot(t3), b);
});

test('[BOOT] Cursor never receives the runtime; one provider owns .dac/runtime per project; Claude behaviour is unchanged', async () => {
  const s = await source();
  for (const bad of [() => s.api.apply({ target: target(), providers: ['cursor'], options: { sddHandoff: true } }), () => s.api.plan({ providers: ['cursor'], options: { sddHandoff: true } }), () => generatePortable('cursor', { sddHandoff: true })]) assert.throws(bad, { code: 'OPTIONS' });
  assert.equal(s.cli(['apply', '--provider', 'cursor', '--sdd-handoff', '--target', target()]).status, 1);
  // with a handoff-capable provider, the flag applies to it only (cursor output is unchanged)
  const p = s.api.plan({ providers: ['codex', 'cursor'], options: { sddHandoff: true } }); assert.ok(p.files.codex.some((f) => f.startsWith('.dac/runtime'))); assert.equal(p.files.cursor.some((f) => f.startsWith('.dac/')), false);
  assert.deepEqual(p.files.cursor, s.api.plan({ providers: ['cursor'] }).files.cursor);
  // two owners of the same runtime path are refused up front (never half-installed)
  assert.throws(() => s.api.plan({ providers: ['claude-code', 'codex'], options: { sddHandoff: true } }), { code: 'OPTIONS' });
  const t = target(); assert.equal(s.api.apply({ target: t, providers: ['claude-code'], options: { sddHandoff: true } }).status, 'APPLIED'); const claude = snapshot(t);
  assert.throws(() => codexApply(s, t), { code: 'OPTIONS' }); assert.deepEqual(snapshot(t), claude, 'refused with zero writes');
  // Codex without the option coexists with a Claude handoff install and does not touch Claude's files
  assert.equal(s.api.apply({ target: t, providers: ['codex'] }).status, 'APPLIED'); assert.deepEqual(only(snapshot(t), '.claude'), only(claude, '.claude')); assert.deepEqual(only(snapshot(t), '.dac/runtime'), only(claude, '.dac/runtime')); assert.equal(s.api.verify({ target: t }).status, 'OK');
  assert.equal(s.api.uninstall({ target: t, provider: 'codex' }).status, 'REMOVED'); assert.equal(s.api.uninstall({ target: t, provider: 'claude-code' }).status, 'REMOVED');
  // the Claude install is byte-identical to a Claude install made without this feature being involved
  const a = target(); const b = target(); s.api.apply({ target: a, providers: ['claude-code'], options: { sddHandoff: true } }); s.api.apply({ target: b, providers: ['claude-code', 'cursor'], options: { sddHandoff: true } });
  assert.deepEqual(only(snapshot(a), '.claude'), only(snapshot(b), '.claude')); assert.deepEqual(only(snapshot(a), '.dac/runtime'), only(snapshot(b), '.dac/runtime'));
  assert.equal(spawnSync('grep', ['-rli', 'handoff', join(REPO_ROOT, 'adapters/cursor')], { encoding: 'utf8' }).stdout.trim(), '', 'the Cursor adapter source is not touched');});

test('[PROC] adapter CLI (adapters/codex/cli.mjs) supports --sdd-handoff: plan lists the runtime, apply installs it, uninstall removes it; user-level config is never touched', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [join(REPO_ROOT, 'adapters/codex/cli.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const t = realpathSync(target()); const home = fresh('home'); const homeBefore = snapshot(home);
  assert.ok(run(['plan', '--sdd-handoff', '--json']).stdout.includes('.dac/runtime/sdd-handoff/mcp-server.mjs')); assert.ok(!run(['plan']).stdout.includes('.dac/runtime'));
  const a = run(['apply', '--sdd-handoff', '--target', t], { HOME: home }); assert.equal(a.status, 0, a.stdout + a.stderr); assert.match(a.stdout, /^APPLIED/);
  for (const f of RUNTIME) assert.ok(existsSync(join(t, f)), f);
  assert.equal(readJ(t, '.codex/dac-manifest.json').sdd_handoff, true);
  const u = run(['uninstall', '--target', t], { HOME: home }); assert.equal(u.status, 0, u.stdout + u.stderr); assert.deepEqual(snapshot(t), {}, 'uninstall removes exactly what was installed');
  assert.equal(existsSync(join(t, '.dac')), false); assert.deepEqual(snapshot(home), homeBefore);
});
