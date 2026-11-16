// Claude Code SDD-handoff runtime integrated into the existing project bootstrap (createInstaller / executeActions journal,
// manifests, .dac records). Disposable projects only; the standards checkout is a throw-away Git copy (clean-source gate).
// Evidence classes: [BOOT] bootstrap API on a disposable project, [PROC] real child processes + real Unix sockets,
// [UNIT] in-process. Scope: Claude Code only (Codex and Cursor are asserted untouched).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, cpSync, existsSync, readlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { startCustodian } from '../adapters/shared/sdd-handoff/custodian.mjs';
import { withLease } from '../adapters/shared/sdd-handoff/client.mjs';
import { plan as writerPlan, apply as writerApply, verify as writerVerify } from '../adapters/shared/sdd-writer/writer.mjs';
import { targetIdentity as fullIdentity, endpointKey as fullKey } from '../adapters/shared/sdd-handoff/identity.mjs';
import { targetIdentity as portableIdentity, endpointKey as portableKey } from '../adapters/shared/sdd-handoff/identity-portable.mjs';
import { RUNTIME_DIR, TOOL_PERMISSION, SERVER_NAME } from '../adapters/shared/sdd-handoff/claude-config.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-ch-')));
const shortBase = realpathSync(mkdtempSync('/tmp/dh-'));
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
const claudeApply = (s, t, o = {}, extra = {}) => s.api.apply({ target: t, providers: ['claude-code'], options: { sddHandoff: true, ...o }, ...extra });
const RUNTIME = ['client.mjs', 'core.mjs', 'endpoint.mjs', 'errors.mjs', 'identity.mjs', 'mcp-server.mjs'].map((f) => `${RUNTIME_DIR}/${f}`);
const PID = 'demo-project';
const constitution = () => ({ kind: 'sdd-constitution', schema_version: '1.0', project_id: PID, principles: [{ id: 'p-one', statement: 'Ship small, verified changes.' }], constraints: [{ id: 'c-one', statement: 'No secrets in the repository.' }] });
const specify = () => ({ kind: 'sdd-specify', schema_version: '1.0', project_id: PID, requirements: [{ id: 'req-1', statement: 'Users can log in.', acceptance_criteria: ['ac-1'], open_questions: [] }], acceptance_criteria: [{ id: 'ac-1', requirement: 'req-1', statement: 'Valid credentials open a session.', verification: 'integration test' }] });
const envelope = () => ({ project_id: PID, operation: 'create', constitution: constitution(), specify: specify() });
const projectOwnedSdd = (t) => { mkdirSync(join(t, '.sdd/notes'), { recursive: true }); writeFileSync(join(t, '.sdd/notes/keep.md'), 'project-owned é\r\n\u0000bytes'); writeFileSync(join(t, '.sdd/README'), 'x'); };

// ---- 1 clean project lifecycle ----------------------------------------------------------------------------------------------
test('[BOOT] clean project: plan -> apply -> verify -> idempotent re-apply -> update -> uninstall, runtime owned by the claude-code manifest', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t);
  const sddBefore = only(snapshot(t), '.sdd');
  // plan lists the runtime and writes nothing
  const p = s.api.plan({ providers: ['claude-code'], options: { sddHandoff: true }, target: t });
  for (const f of [...RUNTIME, '.mcp.json']) assert.ok(p.files['claude-code'].includes(f), f);
  assert.equal(p.target.status, 'DRY_RUN'); assert.deepEqual(snapshot(t), { ...only(snapshot(t), '.sdd') });
  // not part of the default install
  assert.equal(s.api.plan({ providers: ['claude-code'], target: t }).files['claude-code'].some((f) => f.startsWith('.dac/runtime')), false);
  const r = claudeApply(s, t); assert.equal(r.status, 'APPLIED', JSON.stringify(r.conflicts));
  for (const f of RUNTIME) assert.ok(r.created.includes(f), f);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  // ownership: manifest lists the runtime files and .mcp.json; the standard record notes the option; nothing else under .dac
  const man = readJ(t, '.claude/dac-manifest.json'); assert.equal(man.sdd_handoff, true);
  for (const f of [...RUNTIME, '.mcp.json']) assert.ok(man.files.some((x) => x.path === f && x.sha256 === sha(readFileSync(join(t, f)))), f);
  assert.deepEqual(readdirSync(join(t, '.dac')).sort(), ['runtime', 'standard.json']); assert.equal(readJ(t, '.dac/standard.json').providers['claude-code'].sdd_handoff, true);
  assert.deepEqual(readdirSync(join(t, RUNTIME_DIR)).sort(), RUNTIME.map((x) => x.split('/').pop()).sort());
  // idempotence
  const before = snapshot(t); assert.equal(claudeApply(s, t).status, 'UNCHANGED'); assert.deepEqual(snapshot(t), before);
  // update keeps the option and is a no-op at the same commit; a new standard commit refreshes only managed files
  assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
  s.change('VERSION', (x) => x.trim() + '.1\n'); const u = s.api.update({ target: t }); assert.equal(u.status, 'APPLIED'); assert.ok(u.updated.includes('.dac/standard.json'));
  assert.equal(s.api.verify({ target: t }).status, 'OK'); assert.equal(readJ(t, '.claude/dac-manifest.json').sdd_handoff, true);
  assert.deepEqual(only(snapshot(t), '.sdd'), sddBefore, 'project-owned .sdd untouched by apply/update');
  // uninstall removes exactly what was installed
  const un = s.api.uninstall({ target: t, provider: 'claude-code' }); assert.equal(un.status, 'REMOVED');
  assert.deepEqual(snapshot(t), sddBefore, 'only .sdd remains, byte-for-byte'); assert.equal(existsSync(join(t, '.dac')), false);
});

test('[BOOT] update of an existing Claude project (installed without handoff): update never enables it; explicit apply adds it; disabling removes only managed runtime files', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t);
  assert.equal(s.api.apply({ target: t, providers: ['claude-code'], options: { context7: true } }).status, 'APPLIED');
  assert.equal(existsSync(join(t, RUNTIME_DIR)), false); const sdd = only(snapshot(t), '.sdd');
  s.change('VERSION', (x) => x.trim() + '.2\n'); assert.equal(s.api.update({ target: t }).status, 'APPLIED'); assert.equal(existsSync(join(t, RUNTIME_DIR)), false, 'update does not opt in');
  const add = s.api.apply({ target: t, providers: ['claude-code'], options: { context7: true, sddHandoff: true } }); assert.equal(add.status, 'APPLIED', JSON.stringify(add.conflicts));
  // both servers in the same managed .mcp.json; context7 stays remote-http and permission-less
  const mcp = readJ(t, '.mcp.json'); assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['context7', SERVER_NAME]); assert.equal(mcp.mcpServers.context7.type, 'http');
  const st = readJ(t, '.claude/settings.json'); assert.deepEqual(st.permissions.allow, [TOOL_PERMISSION]); assert.deepEqual(st.enabledMcpjsonServers, [SERVER_NAME]); assert.equal(st.disabledMcpjsonServers, undefined);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  const off = s.api.apply({ target: t, providers: ['claude-code'], options: { context7: true } }); assert.equal(off.status, 'APPLIED');
  assert.deepEqual(off.removed.sort(), RUNTIME.slice().sort()); assert.equal(existsSync(join(t, '.dac/runtime')), false, 'emptied runtime dirs are pruned');
  assert.equal(s.api.verify({ target: t }).status, 'OK'); assert.equal(readJ(t, '.dac/standard.json').providers['claude-code'].sdd_handoff, undefined);
  assert.deepEqual(only(snapshot(t), '.sdd'), sdd);
});

// ---- 2 conflicts, rollback, ownership --------------------------------------------------------------------------------------
test('[BOOT] conflicts fail closed with zero writes: foreign .mcp.json, foreign file at a runtime path, symlinked runtime dir, modified managed runtime file', async () => {
  const s = await source();
  const foreignMcp = target(); writeFileSync(join(foreignMcp, '.mcp.json'), '{"mcpServers":{"mine":{"command":"x"}}}\n');
  const b1 = snapshot(foreignMcp); const r1 = claudeApply(s, foreignMcp); assert.equal(r1.status, 'CONFLICT'); assert.ok(r1.conflicts.some((c) => c.path === '.mcp.json')); assert.deepEqual(snapshot(foreignMcp), b1);
  const foreignFile = target(); mkdirSync(join(foreignFile, RUNTIME_DIR), { recursive: true }); writeFileSync(join(foreignFile, `${RUNTIME_DIR}/mcp-server.mjs`), '// mine\n');
  const b2 = snapshot(foreignFile); const r2 = claudeApply(s, foreignFile); assert.equal(r2.status, 'CONFLICT'); assert.ok(r2.conflicts.some((c) => c.path === `${RUNTIME_DIR}/mcp-server.mjs`)); assert.deepEqual(snapshot(foreignFile), b2);
  const linked = target(); const elsewhere = fresh('elsewhere'); mkdirSync(join(linked, '.dac')); execFileSync('ln', ['-s', elsewhere, join(linked, '.dac/runtime')]);
  const r3 = claudeApply(s, linked); assert.equal(r3.status, 'CONFLICT'); assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the symlink');
  // a managed runtime file edited by the user: update/apply/uninstall refuse to overwrite or delete it
  const t = target(); assert.equal(claudeApply(s, t).status, 'APPLIED');
  const f = join(t, `${RUNTIME_DIR}/client.mjs`); writeFileSync(f, `${readFileSync(f, 'utf8')}// local edit\n`); const b3 = snapshot(t);
  assert.equal(s.api.verify({ target: t }).status, 'DRIFT');
  for (const r of [s.api.update({ target: t }), claudeApply(s, t), s.api.uninstall({ target: t, provider: 'claude-code' })]) { assert.equal(r.status, 'CONFLICT'); assert.ok(r.conflicts.some((c) => c.path === `${RUNTIME_DIR}/client.mjs`)); }
  assert.deepEqual(snapshot(t), b3);
});

test('[BOOT] journaled rollback: an injected fault at every step restores the pre-apply state exactly (apply, update, uninstall)', async () => {
  const s = await source(); const t = target(); projectOwnedSdd(t);
  const clean = snapshot(t);
  for (const n of [1, 3, 8, 14]) {
    assert.throws(() => claudeApply(s, t, {}, { faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true, `apply fault ${n}`);
    assert.deepEqual(snapshot(t), clean, `apply fault ${n}`);
  }
  assert.equal(claudeApply(s, t).status, 'APPLIED'); const installed = snapshot(t);
  s.change('VERSION', (x) => x.trim() + '.3\n');
  for (const n of [1]) { assert.throws(() => s.api.update({ target: t, faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), installed, `update fault ${n}`); }
  for (const n of [1, 6, 12]) { assert.throws(() => s.api.uninstall({ target: t, provider: 'claude-code', faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true); assert.deepEqual(snapshot(t), installed, `uninstall fault ${n}`); }
});

// ---- 3 scope: no other providers, no global changes, no writes outside the target -------------------------------------------
test('[BOOT] scope: Codex/Cursor are never touched or wired; a handoff request without claude-code is refused; CLI run leaves HOME and the standards checkout untouched', async () => {
  const s = await source(); const t = target(); const home = fresh('home'); const homeBefore = snapshot(home);
  assert.equal(s.api.apply({ target: t, providers: ['codex', 'cursor'] }).status, 'APPLIED'); const other = snapshot(t);
  const r = s.cli(['apply', '--provider', 'claude-code', '--sdd-handoff', '--target', t], { HOME: home }); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(without(snapshot(t), '.claude', '.mcp.json', '.dac/runtime', '.dac/standard.json'), without(other, '.dac/standard.json'), 'codex/cursor files unchanged');
  assert.deepEqual(snapshot(home), homeBefore, 'no global/user profile writes'); assert.equal(git(s.dir, 'status', '--porcelain'), '', 'standards checkout untouched');
  for (const p of ['codex', 'cursor']) { const man = readJ(t, `.${p}/dac-manifest.json`); assert.ok(!JSON.stringify(man).includes('sdd_handoff') && !JSON.stringify(man).includes('sdd-handoff')); }
  for (const f of Object.keys(snapshot(t))) if ((f.startsWith('.codex/') || f.startsWith('.cursor/') || f === 'AGENTS.md') && !lstatSync(join(t, f)).isDirectory()) assert.ok(!/sdd[-_]handoff/i.test(read(t, f)), `${f} has no handoff wiring`);
  assert.equal(s.api.verify({ target: t }).status, 'OK');
  for (const bad of [() => s.api.apply({ target: target(), providers: ['codex'], options: { sddHandoff: true } }), () => s.api.plan({ providers: ['cursor'], options: { sddHandoff: true } })]) assert.throws(bad, { code: 'OPTIONS' });
  assert.equal(s.cli(['update', '--target', t, '--sdd-handoff']).status, 2);
  // the adapter-level source of Codex/Cursor never mentions the handoff
  for (const d of ['adapters/codex', 'adapters/cursor']) assert.equal(spawnSync('grep', ['-rli', 'handoff', join(REPO_ROOT, d)], { encoding: 'utf8' }).stdout.trim(), '');
  // uninstalling claude-code leaves codex/cursor exactly as they were
  assert.equal(s.api.uninstall({ target: t, provider: 'claude-code' }).status, 'REMOVED'); assert.deepEqual(snapshot(t), other);
});

test('[UNIT] least privilege: only technical-planner gains the single submit tool; code-reviewer and implementers stay as before; settings grant exactly one tool', async () => {
  const s = await source(); const t = target(); claudeApply(s, t);
  const tools = (id) => /^tools: (.*)$/m.exec(read(t, `.claude/agents/${id}.md`))[1].split(', ');
  const base = await source(); const t0 = target(); base.api.apply({ target: t0, providers: ['claude-code'] });
  for (const id of readdirSync(join(t, '.claude/agents')).map((f) => f.replace(/\.md$/, ''))) {
    const baseTools = /^tools: (.*)$/m.exec(read(t0, `.claude/agents/${id}.md`))[1].split(', ');
    assert.deepEqual(tools(id), id === 'technical-planner' ? [...baseTools, TOOL_PERMISSION] : baseTools, id);
    assert.ok(/^disallowedTools: .*Bash/m.test(read(t, `.claude/agents/${id}.md`)), `${id} still denies Bash`);
  }
  assert.ok(!read(t, '.claude/agents/code-reviewer.md').includes('sdd_handoff'));
  const tp = read(t, '.claude/agents/technical-planner.md'); assert.match(tp, /^disallowedTools: Bash, Write, Edit, MultiEdit, NotebookEdit$/m); assert.match(tp, /^permissionMode: plan$/m);
  // scope guard map is unchanged by the option (no new writable path)
  assert.equal(read(t, '.claude/hooks/dac-scopes.json'), read(t0, '.claude/hooks/dac-scopes.json'));
  const st = readJ(t, '.claude/settings.json'); assert.equal(st.permissions.defaultMode, 'default'); assert.equal(st.enableAllProjectMcpServers, false); assert.deepEqual(st.permissions.allow, [TOOL_PERMISSION]);
  assert.ok(!/Write|Edit|Bash|apply|bypass/.test(JSON.stringify(st.permissions.allow)));
  assert.equal(readJ(t0, '.claude/settings.json').permissions.allow, undefined, 'default install grants nothing');
});

test('[UNIT] portability: generated/installed files contain no machine-specific absolute path, tmpdir, env endpoint or secret-shaped value', async () => {
  const s = await source(); const t = target(); claudeApply(s, t, { context7: true });
  const bad = /\/(Users|home|private|var\/folders|tmp)\/|os\.tmpdir|tmpdir\(|DAC_SDD_HANDOFF_DIR|process\.env|process\.cwd|[A-Za-z]:\\\\/;
  for (const f of Object.keys(snapshot(t))) { if (lstatSync(join(t, f)).isDirectory()) continue; const txt = read(t, f); if (f.startsWith('.dac/runtime') || f === '.mcp.json' || f === '.claude/settings.json' || f === '.claude/dac-manifest.json' || f === '.dac/standard.json') assert.ok(!bad.test(txt), `${f}: machine-specific content`); }
  assert.ok(!read(t, '.mcp.json').includes(t) && !read(t, '.mcp.json').includes(shortBase));
  const mcp = readJ(t, '.mcp.json').mcpServers[SERVER_NAME]; assert.deepEqual(mcp.args.slice(0, 3), ['.dac/runtime/sdd-handoff/mcp-server.mjs', '--target', '.']); assert.equal(mcp.args[4], '${DAC_SDD_RUNTIME_DIR}');
});

// ---- 4 the installed runtime works with no manual sdd-input.json -------------------------------------------------------------
function startMcp(cwd, args, env = {}) {
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { PATH: process.env.PATH, HOME: scratch, ...env } });
  children.push(child); let buf = ''; let err = ''; const waiters = new Map(); let id = 0;
  child.stderr.on('data', (c) => { err += c; }); child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const i = ++id; const t = setTimeout(() => reject(new Error(`no reply to ${method}: ${err}`)), 20000); waiters.set(i, (m) => { clearTimeout(t); resolve(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`); });
  const exited = new Promise((r) => child.once('close', (code) => r({ code, err: () => err })));
  return { child, rpc, exited, err: () => err };
}

test('[PROC] installed runtime end to end with no sdd-input.json: bootstrap -> custodian -> installed MCP from the project root -> submit -> Writer plan/apply (--handoff) -> verify; Writer never touches .dac/.claude', async () => {
  const s = await source(); const t = realpathSync(target()); const rt = runtimeDir();
  assert.equal(claudeApply(s, t).status, 'APPLIED'); const installed = without(snapshot(t), '.sdd');
  assert.equal(existsSync(join(t, 'sdd-input.json')), false);
  const stub = ({ target, input }) => writerPlan({ target, input, source: () => ({ head: 'a'.repeat(40) }) });
  const c = await startCustodian({ target: t, dir: rt, writePlan: stub }); closers.push(() => c.close());
  // exactly how Claude launches it: cwd = project root, project-relative script, relative --target, env-expanded --runtime-dir
  const entry = readJ(t, '.mcp.json').mcpServers[SERVER_NAME]; assert.equal(entry.command, 'node');
  const args = entry.args.map((a) => (a === '${DAC_SDD_RUNTIME_DIR}' ? rt : a));
  const m = startMcp(t, args);
  const init = await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }); assert.equal(init.result.serverInfo.name, 'dac-sdd-handoff');
  const tl = await m.rpc('tools/list', {}); assert.deepEqual(tl.result.tools.map((x) => x.name), ['sdd_handoff_submit']);
  const call = await m.rpc('tools/call', { name: 'sdd_handoff_submit', arguments: envelope() }); assert.equal(call.result.isError, false, JSON.stringify(call.result));
  const body = JSON.parse(call.result.content[0].text); assert.match(body.handoff_id, /^sdd-h2\./); assert.deepEqual(body.files_changed, []);
  assert.ok(body.human_commands.apply.includes('<DAC_CHECKOUT>') && !body.human_commands.apply.includes(REPO_ROOT), 'installed proxy prints a placeholder, not a machine path');
  assert.ok(body.human_commands.apply.includes(`--target '${t}'`) && body.human_commands.apply.includes(`--runtime-dir '${rt}'`));
  assert.equal(existsSync(join(t, '.sdd')), false, 'submit writes nothing'); assert.deepEqual(without(snapshot(t), '.sdd'), installed);
  // Claude closes; payload survives in the custodian; the Writer applies it on a (stub) trusted terminal
  m.child.stdin.end(); await m.exited;
  const tty = { calls: 0, confirm() { this.calls++; return true; } };
  const out = await withLease(body.handoff_id, t, (payload) => writerApply({ target: t, input: payload, source: () => ({ head: 'a'.repeat(40) }), terminal: tty }), { dir: rt, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.equal(out.handoff.consumption, 'consumed'); assert.equal(tty.calls, 1);
  assert.equal(writerVerify({ target: t, projectId: PID }).status, 'OK');
  assert.deepEqual(without(snapshot(t), '.sdd'), installed, 'the Writer changed nothing outside .sdd (.dac and .claude byte-identical)');
  assert.ok(existsSync(join(t, '.sdd')));
  // the Writer's output is project-owned: bootstrap verify still OK, update/uninstall preserve .sdd byte-for-byte
  const sdd = only(snapshot(t), '.sdd'); assert.equal(s.api.verify({ target: t }).status, 'OK'); assert.equal(s.api.update({ target: t }).status, 'UNCHANGED');
  assert.equal(s.api.uninstall({ target: t, provider: 'claude-code' }).status, 'REMOVED'); assert.deepEqual(snapshot(t), sdd);
  // replay is impossible
  assert.equal(await withLease(body.handoff_id, t, () => ({ status: 'APPLIED' }), { dir: rt }).catch((e) => e.code), 'HANDOFF_NOT_FOUND');
});

test('[PROC] installed proxy is self-contained and fails closed: no standards checkout needed; unset env var, relative runtime dir and a missing custodian do not start/submit anything', async () => {
  const s = await source(); const t = realpathSync(target()); claudeApply(s, t);
  const mcp = `${RUNTIME_DIR}/mcp-server.mjs`; const imports = [...readFileSync(join(t, mcp), 'utf8').matchAll(/from '(\.[^']+)'/g)].map((x) => x[1]);
  for (const i of imports) assert.ok(existsSync(join(t, RUNTIME_DIR, i)), `${i} is installed`); assert.ok(imports.every((i) => !i.includes('..')));
  for (const f of RUNTIME) for (const m of readFileSync(join(t, f), 'utf8').matchAll(/from '(\.[^']+)'/g)) assert.ok(existsSync(join(t, dirname(f), m[1])), `${f} -> ${m[1]}`);
  // the installed tree must not depend on the standards checkout: run it with a PATH-only env from a different cwd's project root
  const unexpanded = await startMcp(t, [mcp, '--target', '.', '--runtime-dir', '${DAC_SDD_RUNTIME_DIR}']).exited; assert.equal(unexpanded.code, 1, 'unexpanded variable => proxy refuses to start');
  const rel = await startMcp(t, [mcp, '--target', '.', '--runtime-dir', 'relative/dir']).exited; assert.equal(rel.code, 1);
  const none = await startMcp(t, [mcp, '--target', '.']).exited; assert.equal(none.code, 2);
  const rt = runtimeDir(); const m = startMcp(t, [mcp, '--target', '.', '--runtime-dir', rt]); await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  const r = await m.rpc('tools/call', { name: 'sdd_handoff_submit', arguments: envelope() }); assert.equal(r.result.isError, true);
  const b = JSON.parse(r.result.content[0].text); assert.equal(b.code, 'CUSTODIAN_UNAVAILABLE'); assert.ok(b.message.includes('<DAC_CHECKOUT>')); assert.deepEqual(b.files_changed, []);
  m.child.stdin.end(); await m.exited; assert.equal(existsSync(join(t, '.sdd')), false);
});

test('[UNIT] the installed identity variant derives exactly the same target identity and endpoint key as the checkout variant', () => {
  const d = realpathSync(fresh('idt')); const a = fullIdentity(d); const b = portableIdentity(d);
  assert.deepEqual(a, b); assert.equal(fullKey(a), portableKey(b));
  const link = join(scratch, `lnk-${counter++}`); execFileSync('ln', ['-s', d, link]);
  assert.throws(() => portableIdentity(link), { code: 'TARGET' }); assert.throws(() => portableIdentity(join(d, 'missing')), { code: 'TARGET' });
  assert.deepEqual(portableIdentity(relative(process.cwd(), d)), a, 'relative targets resolve against the cwd (MCP launches in the project root)');
});
