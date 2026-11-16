// SDD input handoff PoC 2 (Claude Code only): human-started, independent, in-memory custodian + stateless MCP proxy
// + `--handoff` in the existing writer CLI.
// Evidence classes in test names: [UNIT] in-process; [PROC] real child processes + real Unix sockets;
// [PTY] real controlling terminal via python3 pty.fork; [REAL-CLAUDE] installed `claude` CLI in the OS sandbox (no model call).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, mkdirSync, chmodSync, existsSync, symlinkSync, linkSync, renameSync, unlinkSync, readdirSync, lstatSync, readlinkSync, cpSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { plan, apply, verify } from '../adapters/shared/sdd-writer/writer.mjs';
import { createStore, HANDOFF_TTL_MS, MAX_LIVE_HANDOFFS, MAX_ENVELOPE_BYTES, parseHandoffId, ID_RE } from '../adapters/shared/sdd-handoff/core.mjs';
import { startCustodian, probeEndpoint } from '../adapters/shared/sdd-handoff/custodian.mjs';
import { peekHandoff, withLease, submitHandoff, statusOf, cancelHandoff } from '../adapters/shared/sdd-handoff/client.mjs';
import { createServer, TOOL_NAME, TOOL } from '../adapters/shared/sdd-handoff/mcp-server.mjs';
import { ensurePrivateDir, assertPrivateDir, socketPath, assertPrivateSocket, resolveRuntimeDir, metaPath, writeMetadata, readMetadata } from '../adapters/shared/sdd-handoff/endpoint.mjs';
import { targetIdentity, endpointKey } from '../adapters/shared/sdd-handoff/identity.mjs';
import { mcpServerEntry, runtimeFiles, TOOL_PERMISSION, SERVER_NAME, RUNTIME_DIR_ENV } from '../adapters/shared/sdd-handoff/claude-config.mjs';
import { createRuntime, claudeInit, verifySandbox, sandboxAvailable, isolatedBase, sandboxUnavailableReason } from './support/claude-runtime.mjs';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dac-hf-')));
// Endpoint dirs live under a SHORT base: unix socket paths are limited to ~104 bytes.
const shortBase = realpathSync(mkdtempSync('/tmp/dh-'));
const custodians = []; const children = [];
after(async () => {
  for (const c of custodians) await c.close().catch(() => {});
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(scratch, { recursive: true, force: true }); rmSync(shortBase, { recursive: true, force: true });
});
let n = 0;
const fresh = (label = 't') => { const d = join(scratch, `${label}-${n++}`); mkdirSync(d); return d; };
const freshDir = () => { const d = join(shortBase, `e${n++}`); mkdirSync(d, { mode: 0o700 }); chmodSync(d, 0o700); return d; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SRC = () => ({ head: 'a'.repeat(40) });
const PID = 'demo-project';
const MARK = 'ZZ-PAYLOAD-MARKER-9f3c';
const constitution = () => ({ kind: 'sdd-constitution', schema_version: '1.0', project_id: PID, principles: [{ id: 'p-one', statement: `Ship small, verified changes ${MARK}.` }], constraints: [{ id: 'c-one', statement: 'No secrets in the repository.' }] });
const specify = () => ({
  kind: 'sdd-specify', schema_version: '1.0', project_id: PID,
  requirements: [{ id: 'req-1', statement: 'Users can log in.', acceptance_criteria: ['ac-1'], open_questions: [] }],
  acceptance_criteria: [{ id: 'ac-1', requirement: 'req-1', statement: 'Valid credentials open a session.', verification: 'integration test' }],
});
const envelope = (o = {}) => ({ project_id: PID, operation: 'create', constitution: constitution(), specify: specify(), ...o });
const tty = (answer = true) => ({ calls: 0, confirm() { this.calls++; return answer; } });
const noSdd = (t) => assert.equal(existsSync(join(t, '.sdd')), false, '.sdd must not exist');
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
const codeOf = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };
const stubPlan = ({ target, input }) => plan({ target, input, source: SRC });
const ident = (t) => targetIdentity(t);
// In-process custodian with the real writer plan() and a stub standard source (the repo checkout may be dirty).
async function mkCust(o = {}) {
  const target = o.target ?? fresh('target'); const dir = o.dir ?? freshDir();
  const c = await startCustodian({ target, dir, writePlan: stubPlan, ...o.extra }); custodians.push(c);
  return { c, target, dir, opts: { dir } };
}

// Clean copy of the repo (own .git): child processes run the REAL writer/custodian/MCP from it, so the unmodified
// default standard-source gate (clean Git checkout) is satisfied without any test hook. The real repo is untouched.
let cloneMemo;
function clone() {
  if (cloneMemo) return cloneMemo;
  const dst = join(scratch, 'repo-copy');
  cpSync(REPO_ROOT, dst, { recursive: true, filter: (s) => { const r = relative(REPO_ROOT, s).split('/'); return r[0] !== '.git' && !r.includes('node_modules'); } });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', dst, ...a], { env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'copy');
  const A = (p) => join(dst, 'adapters/shared', p);
  return (cloneMemo = { root: dst, cli: A('sdd-writer/cli.mjs'), cust: A('sdd-handoff/custodian-cli.mjs'), mcp: A('sdd-handoff/mcp-server.mjs') });
}
// The process environment is deliberately unrelated to the endpoint: only an explicit --runtime-dir flag selects it.
const envFor = (o = {}) => ({ PATH: process.env.PATH, HOME: scratch, ...(o.tmp ? { TMPDIR: o.tmp } : {}) });
const withRt = (args, dir) => (args.includes('--runtime-dir') || !dir ? args : [...args, '--runtime-dir', dir]);
// detached => setsid => NO controlling terminal (so /dev/tty cannot be opened), regardless of how the suite was started.
const runNode = (script, args, dir, { detached = true, tmp, cwd } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [script, ...args], { env: envFor({ tmp }), cwd, stdio: ['ignore', 'pipe', 'pipe'], detached });
  let stdout = '', stderr = ''; p.stdout.on('data', (c) => { stdout += c; }); p.stderr.on('data', (c) => { stderr += c; }); p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const cli = (args, dir, o) => runNode(clone().cli, args.includes('--handoff') ? withRt(args, dir) : args, dir, o);
const custCli = (args, dir, o) => runNode(clone().cust, withRt(args, dir), dir, o);
function spawnCustodian(target, dir, o = {}) {
  const p = spawn(process.execPath, [clone().cust, 'start', '--target', target, '--runtime-dir', dir], { env: envFor(o), cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let err = ''; p.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((r) => p.once('close', (code, sig) => r({ code, sig })));
  const ready = new Promise((resolve, reject) => { const t = setInterval(() => { if (/custodian started/.test(err)) { clearInterval(t); resolve(); } }, 20); setTimeout(() => { clearInterval(t); reject(new Error(`custodian did not start: ${err}`)); }, 15000); p.once('close', () => { clearInterval(t); reject(new Error(`custodian exited early: ${err}`)); }); });
  return { p, exited, ready, err: () => err };
}
function startMcp(target, dir, o = {}) {
  const child = spawn(process.execPath, [clone().mcp, '--target', target, '--runtime-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'], env: envFor(o), cwd: o.cwd });
  children.push(child);
  let buf = ''; const waiters = new Map(); let err = '';
  child.stderr.on('data', (c) => { err += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => { const i = ++id; const t = setTimeout(() => reject(new Error(`no reply to ${method}: ${err}`)), 20000); waiters.set(i, (m) => { clearTimeout(t); resolve(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const exited = new Promise((r) => child.once('close', (code, sig) => r({ code, sig })));
  const submit = async (args) => { const r = await rpc('tools/call', { name: TOOL_NAME, arguments: args }); return { isError: r.result.isError, body: JSON.parse(r.result.content[0].text) }; };
  return { child, rpc, exited, submit, init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }) };
}

// ---- 1 store protocol -------------------------------------------------------------------------------------------------
test('1. [UNIT] store: submit/peek/lease/release/commit/cancel/replay, target mismatch, malformed or altered ids', () => {
  const T = { realpath: '/x/t', device: '1', inode: '2' };
  const s = createStore({ instanceId: 'a'.repeat(12), target: T });
  const h = s.submit({ a: 1 });
  assert.match(h.handoff_id, ID_RE); assert.equal(parseHandoffId(h.handoff_id).instanceId, 'a'.repeat(12));
  assert.equal(s.peek(h.handoff_id, T).payload_json, '{"a":1}'); assert.equal(s.size, 1, 'peek does not consume');
  assert.equal(s.peek(h.handoff_id, T).payload_json, '{"a":1}');
  const l1 = s.lease(h.handoff_id, T);
  assert.throws(() => s.lease(h.handoff_id, T), { code: 'HANDOFF_LEASED' });
  assert.throws(() => s.cancel(h.handoff_id, T), { code: 'HANDOFF_LEASED' });
  l1.release(); assert.equal(s.size, 1, 'release keeps the handoff');
  const l2 = s.lease(h.handoff_id, T); assert.equal(l2.commit(), true); assert.equal(s.size, 0);
  assert.throws(() => s.peek(h.handoff_id, T), { code: 'HANDOFF_NOT_FOUND' }, 'replay');
  assert.throws(() => s.lease(h.handoff_id, T), { code: 'HANDOFF_NOT_FOUND' });
  const h2 = s.submit({ b: 2 });
  assert.throws(() => s.peek(h2.handoff_id, { ...T, inode: '3' }), { code: 'TARGET_MISMATCH' });
  assert.throws(() => s.peek(h2.handoff_id, { ...T, realpath: '/x/u' }), { code: 'TARGET_MISMATCH' });
  for (const bad of ['', 'x', null, undefined, 42, 'sdd-h2.short.x', `${h2.handoff_id}x`, h2.handoff_id.slice(0, -1), h2.handoff_id.replace('sdd-h2', 'sdd-h1'), 'x'.repeat(200), `${h2.handoff_id}\n`]) assert.throws(() => s.peek(bad, T), { code: 'HANDOFF_ID' }, String(bad));
  const flip = h2.handoff_id.slice(0, -1) + (h2.handoff_id.endsWith('A') ? 'B' : 'A');
  assert.throws(() => s.peek(flip, T), { code: 'HANDOFF_NOT_FOUND' }, 'altered secret');
  const other = h2.handoff_id.replace(/^sdd-h2\.[0-9a-f]{12}/, 'sdd-h2.' + 'b'.repeat(12));
  assert.throws(() => s.peek(other, T), { code: 'HANDOFF_NOT_FOUND' }, 'other instance');
  assert.equal(s.cancel(h2.handoff_id, T), true); assert.throws(() => s.peek(h2.handoff_id, T), { code: 'HANDOFF_NOT_FOUND' });
  const h3 = s.submit({ c: 3 }); s.clear(); assert.throws(() => s.peek(h3.handoff_id, T), { code: 'HANDOFF_NOT_FOUND' });
});

test('2. [UNIT] TTL is exactly 600 s (live at +599999 ms, gone at +600000 ms); capacity 16/17; 512 KiB boundary', () => {
  assert.equal(HANDOFF_TTL_MS, 600000); assert.equal(MAX_LIVE_HANDOFFS, 16); assert.equal(MAX_ENVELOPE_BYTES, 524288);
  const T = { realpath: '/x/t', device: '1', inode: '2' };
  let now = 1_000_000; const s = createStore({ instanceId: 'a'.repeat(12), target: T, clock: () => now });
  const h = s.submit({ a: 1 }); assert.equal(Date.parse(h.expires_at) - Date.parse(h.created_at), 600000);
  now += 599999; assert.equal(s.peek(h.handoff_id, T).payload_json, '{"a":1}');
  now += 1; assert.throws(() => s.peek(h.handoff_id, T), { code: 'HANDOFF_NOT_FOUND' }); assert.equal(s.size, 0, 'expired payload purged from memory');
  // a lease does not extend the TTL
  const h2 = s.submit({ b: 1 }); const l = s.lease(h2.handoff_id, T); now += 600000; assert.equal(l.commit(), false); assert.equal(s.size, 0);
  // capacity
  const ids = []; for (let i = 0; i < 16; i++) ids.push(s.submit({ i }).handoff_id);
  assert.throws(() => s.submit({ i: 17 }), { code: 'HANDOFF_CAPACITY' });
  s.lease(ids[0], T).commit(); const again = s.submit({ i: 18 }); assert.ok(again.handoff_id, 'a consumed slot is reusable');
  assert.throws(() => s.submit({ i: 19 }), { code: 'HANDOFF_CAPACITY' });
  now += 600000; assert.ok(s.submit({ i: 20 }).handoff_id, 'expired slots are reusable'); assert.equal(s.size, 1);
  // size boundary: serialized JSON of exactly 512 KiB is accepted, +1 byte is rejected
  const padded = (bytes) => { const base = JSON.stringify({ p: '' }).length; return { p: 'x'.repeat(bytes - base) }; };
  const big = createStore({ instanceId: 'a'.repeat(12), target: T });
  assert.equal(Buffer.byteLength(JSON.stringify(padded(MAX_ENVELOPE_BYTES))), MAX_ENVELOPE_BYTES);
  assert.ok(big.submit(padded(MAX_ENVELOPE_BYTES)).handoff_id);
  assert.throws(() => big.submit(padded(MAX_ENVELOPE_BYTES + 1)), { code: 'HANDOFF_TOO_LARGE' });
});

// ---- 3 endpoint ---------------------------------------------------------------------------------------------------------
test('3. [UNIT] endpoint: deterministic per real target, private modes, symlink/alias/foreign/length rejection', async () => {
  const t1 = fresh('target'); const t2 = fresh('target'); const dir = freshDir();
  const a = socketPath(dir, ident(t1)); assert.equal(a, socketPath(dir, ident(t1)), 'deterministic');
  assert.notEqual(a, socketPath(dir, ident(t2))); assert.match(a, /h2-[0-9a-f]{20}\.sock$/);
  const viaLink = join(scratch, `lnk-${n++}`); symlinkSync(t1, viaLink);
  assert.throws(() => ident(viaLink), /.+/, 'a symlinked target is refused, so no alias can reach the same endpoint');
  // directory rules
  const fresh2 = join(shortBase, `d${n++}`); ensurePrivateDir(fresh2); assert.equal(lstatSync(fresh2).mode & 0o777, 0o700);
  assert.throws(() => ensurePrivateDir('relative/dir'), { code: 'HANDOFF_ENDPOINT' });
  const loose = join(shortBase, `d${n++}`); mkdirSync(loose, { mode: 0o755 }); chmodSync(loose, 0o755);
  assert.throws(() => assertPrivateDir(loose), { code: 'HANDOFF_ENDPOINT' }); assert.throws(() => ensurePrivateDir(loose), { code: 'HANDOFF_ENDPOINT' });
  const lnk = join(shortBase, `l${n++}`); symlinkSync(fresh2, lnk);
  assert.throws(() => assertPrivateDir(lnk), { code: 'HANDOFF_ENDPOINT' }, 'directory symlink');
  assert.throws(() => ensurePrivateDir(lnk), { code: 'HANDOFF_ENDPOINT' });
  assert.throws(() => assertPrivateDir(`${fresh2}/../${fresh2.split('/').pop()}`), { code: 'HANDOFF_ENDPOINT' }, 'non-canonical alias path');
  assert.throws(() => assertPrivateDir(join(shortBase, 'missing')), { code: 'HANDOFF_ENDPOINT' });
  // path length
  const deep = join(shortBase, 'd'.repeat(80)); mkdirSync(deep, { mode: 0o700 });
  assert.throws(() => socketPath(deep, ident(t1)), { code: 'HANDOFF_ENDPOINT' }, 'too long for sun_path');
  // socket rules
  const { c } = await mkCust({ target: t1, dir }); assert.equal(c.socketPath, a);
  assert.equal(lstatSync(a).mode & 0o777, 0o600); assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.ok(lstatSync(a).isSocket()); assertPrivateSocket(a);
  const fakeId = `sdd-h2.${'a'.repeat(12)}.${'A'.repeat(43)}`;
  const dir2 = freshDir(); symlinkSync(a, socketPath(dir2, ident(t1))); writeMetadata(dir2, ident(t1), { socket: basename(a), socketStat: lstatSync(a, { bigint: true }), instanceId: 'x', startedAt: 'x' });
  assert.equal(await codeOf(() => peekHandoff(fakeId, t1, { dir: dir2 })), 'HANDOFF_ENDPOINT', 'client refuses a symlinked socket');
  const dir3 = freshDir(); writeFileSync(socketPath(dir3, ident(t1)), 'x', { mode: 0o600 }); writeMetadata(dir3, ident(t1), { socket: basename(a), socketStat: lstatSync(a, { bigint: true }), instanceId: 'x', startedAt: 'x' });
  assert.equal(await codeOf(() => statusOf(t1, { dir: dir3 })), 'HANDOFF_ENDPOINT', 'client refuses a regular file');
  assert.equal(await codeOf(() => startCustodian({ target: t1, dir: dir3, writePlan: stubPlan })), 'HANDOFF_ENDPOINT', 'start never removes a non-socket');
  assert.equal(readFileSync(socketPath(dir3, ident(t1)), 'utf8'), 'x');
  chmodSync(a, 0o666); assert.equal(await codeOf(() => statusOf(t1, { dir })), 'HANDOFF_ENDPOINT', 'loose socket mode refused'); chmodSync(a, 0o600);
  chmodSync(dir, 0o755); assert.equal(await codeOf(() => statusOf(t1, { dir })), 'HANDOFF_ENDPOINT', 'loose dir mode refused'); chmodSync(dir, 0o700);
  assert.equal((await statusOf(t1, { dir })).live_handoffs, 0);
});

// ---- 4 custodian protocol (in-process) ----------------------------------------------------------------------------------
const basename = (p) => p.split('/').pop();
const markerHits = (...roots) => spawnSync('grep', ['-rl', '--binary-files=text', MARK, ...roots], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
test('4. [PROTO] custodian: submit validates with the existing plan(), peek/lease/commit/release/cancel over the socket, no disk payload', async () => {
  const { c, target, dir, opts } = await mkCust();
  const r = await submitHandoff(target, envelope(), opts);
  assert.match(r.handoff_id, ID_RE); assert.equal(r.status, 'PLANNED'); assert.match(r.plan_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.would_write, [`.sdd/artifacts/${PID}/constitution.json`, `.sdd/artifacts/${PID}/specify.json`]);
  noSdd(target);
  // existing gates apply at submit: invalid envelope rejected, nothing stored
  assert.ok(await codeOf(() => submitHandoff(target, envelope({ operation: 'bogus' }), opts)), 'invalid payload rejected'); assert.equal(c.store.size, 1);
  assert.equal(await codeOf(() => submitHandoff(target, 'not-an-object', opts)), 'INPUT');
  // peek repeatable and non-consuming
  const p1 = await peekHandoff(r.handoff_id, target, opts); const p2 = await peekHandoff(r.handoff_id, target, opts);
  assert.deepEqual(p1.payload, envelope()); assert.deepEqual(p2.payload, p1.payload); assert.equal(c.store.size, 1);
  // lease: exclusive; non-APPLIED releases; throwing writer releases; consumed only on APPLIED commit
  const run1 = await withLease(r.handoff_id, target, async () => {
    assert.equal(await codeOf(() => withLease(r.handoff_id, target, () => 'x', opts)), 'HANDOFF_LEASED');
    assert.equal(await codeOf(() => cancelHandoff(r.handoff_id, target, opts)), 'HANDOFF_LEASED');
    return { status: 'FAILED' };
  }, { ...opts, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.deepEqual(run1.handoff, { consumed: false, consumption: 'not-consumed' });
  assert.equal(await codeOf(() => withLease(r.handoff_id, target, () => { throw Object.assign(new Error('denied'), { code: 'APPROVAL_DENIED' }); }, opts)), 'APPROVAL_DENIED');
  assert.equal(c.store.size, 1, 'denial/failure releases the lease; handoff stays live');
  const done = await withLease(r.handoff_id, target, () => ({ status: 'APPLIED' }), opts); assert.deepEqual(done.handoff, { consumed: true, consumption: 'consumed' });
  assert.equal(await codeOf(() => peekHandoff(r.handoff_id, target, opts)), 'HANDOFF_NOT_FOUND', 'replay rejected');
  assert.equal(await codeOf(() => withLease(r.handoff_id, target, () => ({ status: 'APPLIED' }), opts)), 'HANDOFF_NOT_FOUND');
  // cancel
  const r2 = await submitHandoff(target, envelope(), opts); await cancelHandoff(r2.handoff_id, target, opts);
  assert.equal(await codeOf(() => peekHandoff(r2.handoff_id, target, opts)), 'HANDOFF_NOT_FOUND');
  // a lease dies with its connection
  const r3 = await submitHandoff(target, envelope(), opts);
  const raw = await new Promise((res) => { const s = net.createConnection(c.socketPath, () => res(s)); }); raw.setEncoding('utf8');
  const ask = (req) => new Promise((res) => { raw.once('data', (d) => res(JSON.parse(d))); raw.write(JSON.stringify(req) + '\n'); });
  assert.equal((await ask({ op: 'lease', target: ident(target), id: r3.handoff_id })).ok, true);
  assert.equal(await codeOf(() => peekHandoff(r3.handoff_id, target, opts)), null, 'peek works while leased');
  assert.equal(await codeOf(() => withLease(r3.handoff_id, target, () => ({ status: 'FAILED' }), opts)), 'HANDOFF_LEASED');
  raw.destroy(); await new Promise((res) => setTimeout(res, 100));
  assert.equal((await withLease(r3.handoff_id, target, () => ({ status: 'FAILED' }), { ...opts, shouldConsume: () => false })).handoff.consumption, 'not-consumed', 'lease released by the dead connection');
  // the target is fixed: the socket refuses any other target identity
  const other = fresh('other');
  const sock = await new Promise((res) => { const s = net.createConnection(c.socketPath, () => res(s)); }); sock.setEncoding('utf8');
  const ask2 = (req) => new Promise((res) => { sock.once('data', (d) => res(JSON.parse(d))); sock.write(JSON.stringify(req) + '\n'); });
  assert.equal((await ask2({ op: 'submit', target: ident(other), payload: envelope() })).code, 'TARGET_MISMATCH');
  assert.equal((await ask2({ op: 'peek', target: ident(other), id: r3.handoff_id })).code, 'TARGET_MISMATCH');
  assert.equal((await ask2({ op: 'submit', payload: envelope() })).code, 'HANDOFF_PROTOCOL');
  assert.equal((await ask2({ op: 'bogus' })).code, 'HANDOFF_PROTOCOL');
  assert.equal((await ask2([1])).code, 'HANDOFF_PROTOCOL');
  assert.equal((await ask2('x')).code, 'HANDOFF_PROTOCOL');
  assert.equal((await ask2({ op: 'status' })).target.realpath, target, 'reported target is the fixed startup target');
  sock.destroy();
  assert.equal(await codeOf(() => peekHandoff(r3.handoff_id, other, opts)), 'HANDOFF_UNAVAILABLE', 'a different target has a different endpoint; nothing is released');
  // oversize request via the socket is refused (512 KiB + 1)
  assert.equal(await codeOf(() => submitHandoff(target, { p: 'x'.repeat(MAX_ENVELOPE_BYTES) }, opts)), 'HANDOFF_TOO_LARGE');
  // no payload on disk: only the socket inode exists; nothing under the endpoint dir, target or scratch holds the payload
  assert.deepEqual(readdirSync(dir).sort(), [basename(metaPath(dir, ident(target))), basename(c.socketPath)].sort(), 'only the socket and the minimal metadata exist');
  assert.deepEqual(markerHits(dir, target, scratch), []);
  assert.equal((await statusOf(target, opts)).live_handoffs, 1);
});

// ---- 5 MCP proxy (in-process, stateless) ----------------------------------------------------------------------------------
test('5. [UNIT] MCP proxy: exactly one tool, no target/apply argument, stateless, unavailable custodian is a clear error', async () => {
  assert.equal(TOOL.name, 'sdd_handoff_submit'); assert.equal(TOOL.inputSchema.additionalProperties, false);
  assert.ok(!('target' in TOOL.inputSchema.properties) && !('handoff_id' in TOOL.inputSchema.properties));
  const { c, target, opts } = await mkCust();
  const srv = createServer({ target, runtimeDir: opts.dir });
  const list = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); assert.deepEqual(list.result.tools.map((t) => t.name), [TOOL_NAME]);
  const call = async (args, name = TOOL_NAME) => (await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }));
  for (const bad of ['sdd_handoff_apply', 'sdd_handoff_cancel', 'bash', 'write']) assert.equal((await call({}, bad)).error.code, -32602);
  const ok = await call(envelope()); assert.equal(ok.result.isError, false);
  const body = JSON.parse(ok.result.content[0].text); assert.match(body.handoff_id, ID_RE); assert.deepEqual(body.files_changed, []);
  assert.ok(body.human_commands.apply.includes(`--handoff ${body.handoff_id}`) && body.human_commands.apply.includes(target)); assert.ok(!JSON.stringify(body).includes(MARK));
  assert.equal(c.store.size, 1);
  for (const extra of [{ target: '/tmp/x' }, { handoff_id: 'x' }, { apply: true }]) { const r = await call(envelope(extra)); assert.equal(r.result.isError, true); assert.equal(JSON.parse(r.result.content[0].text).code, 'INPUT'); }
  assert.equal(c.store.size, 1, 'rejected calls store nothing');
  // proxy holds nothing: a second proxy instance sees the same custodian state; dropping the first changes nothing
  const srv2 = createServer({ target, runtimeDir: opts.dir });
  assert.equal(JSON.parse((await srv2.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: TOOL_NAME, arguments: envelope() } })).result.content[0].text).status, 'PLANNED');
  assert.equal(c.store.size, 2); assert.ok(!Object.keys(srv).some((k) => /store|broker|state/.test(k)));
  // unavailable custodian
  const lone = createServer({ target: fresh('t2'), runtimeDir: freshDir() });
  const bad = JSON.parse((await lone.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: TOOL_NAME, arguments: envelope() } })).result.content[0].text);
  assert.equal(bad.code, 'CUSTODIAN_UNAVAILABLE'); assert.match(bad.message, /custodian-cli\.mjs.*start --target/);
});

// ---- 6 real independent processes -----------------------------------------------------------------------------------------
test('6. [PROC] lifecycle: payload survives MCP exit and MCP restart; it does not survive custodian exit; new custodian instance rejects old ids', async () => {
  const target = fresh('target'); const dir = freshDir();
  const cu = spawnCustodian(target, dir); await cu.ready;
  assert.match(cu.err(), /instance: [0-9a-f]{12}/);
  const m1 = startMcp(target, dir);
  const init = await m1.init(); assert.equal(init.result.serverInfo.name, 'dac-sdd-handoff');
  const tools = (await m1.rpc('tools/list', {})).result.tools; assert.deepEqual(tools.map((t) => t.name), [TOOL_NAME]);
  const sub = await m1.submit(envelope()); assert.equal(sub.isError, false, JSON.stringify(sub.body)); const id = sub.body.handoff_id;
  noSdd(target);
  // close the MCP (stdin EOF = Claude closing the session)
  m1.child.stdin.end(); assert.equal((await m1.exited).code, 0);
  assert.equal((await peekHandoff(id, target, { dir })).payload.project_id, PID, 'payload survives MCP exit');
  // restarted MCP reconnects to the same custodian (deterministic endpoint) and adds another handoff
  const m2 = startMcp(target, dir); await m2.init();
  const sub2 = await m2.submit(envelope()); assert.equal(sub2.isError, false); assert.notEqual(sub2.body.handoff_id, id);
  assert.equal((await statusOf(target, { dir })).live_handoffs, 2);
  m2.child.kill('SIGKILL'); await m2.exited; // even a hard-killed MCP does not touch the custodian
  assert.equal((await peekHandoff(id, target, { dir })).payload.project_id, PID);
  assert.deepEqual(markerHits(dir, target, shortBase), [], 'no payload on disk while live');
  // custodian Ctrl-C (SIGINT): cleans its socket and destroys the handoffs
  cu.p.kill('SIGINT'); assert.equal((await cu.exited).code, 0);
  assert.deepEqual(readdirSync(dir), [], 'socket removed on Ctrl-C');
  assert.equal(await codeOf(() => peekHandoff(id, target, { dir })), 'HANDOFF_UNAVAILABLE');
  // restart: same endpoint, but a different instance -> old ids are gone
  const cu2 = spawnCustodian(target, dir); await cu2.ready;
  assert.equal(await codeOf(() => peekHandoff(id, target, { dir })), 'HANDOFF_NOT_FOUND', 'payload does not survive custodian exit');
  cu2.p.kill('SIGTERM'); await cu2.exited; assert.deepEqual(readdirSync(dir), []);
  // MCP started while no custodian runs: still connects (tool listing works), submit explains what the human must do
  const m3 = startMcp(target, dir); await m3.init(); assert.equal((await m3.rpc('tools/list', {})).result.tools.length, 1);
  const none = await m3.submit(envelope()); assert.equal(none.isError, true); assert.equal(none.body.code, 'CUSTODIAN_UNAVAILABLE'); m3.child.stdin.end(); await m3.exited;
  assert.equal(spawnSync(process.execPath, [clone().mcp, '--target', '/', '--runtime-dir', freshDir()], { encoding: 'utf8', env: envFor() }).status, 1, 'MCP refuses an unsafe target at startup');
  assert.equal(spawnSync(process.execPath, [clone().mcp, '--target', target], { encoding: 'utf8', env: { ...envFor(), TMPDIR: dir } }).status, 2, 'no runtime-dir flag: the environment/tmpdir is never a fallback');
  assert.equal(spawnSync(process.execPath, [clone().mcp], { encoding: 'utf8' }).status, 2);
});

test('7. [PROC] custodian CLI: start/status/stop, second start refused, SIGKILL leaves a stale socket that is cleaned only after liveness is disproved', async () => {
  const target = fresh('target'); const dir = freshDir();
  assert.equal((await custCli(['status', '--target', target], dir)).status, 1);
  assert.match((await custCli(['status', '--target', target], dir)).stdout, /not running/);
  assert.equal((await custCli(['start'], dir)).status, 2); assert.equal((await custCli(['cancel', '--target', target], dir)).status, 2);
  assert.equal((await custCli(['start', '--target', target, '--bogus'], dir)).status, 2);
  const cu = spawnCustodian(target, dir); await cu.ready;
  const st = await custCli(['status', '--target', target, '--json'], dir); const sj = JSON.parse(st.stdout);
  assert.equal(st.status, 0); assert.equal(sj.state, 'running'); assert.equal(sj.pid, cu.p.pid); assert.equal(sj.ttl_seconds, 600); assert.equal(sj.capacity, 16); assert.equal(sj.max_payload_bytes, 524288); assert.equal(sj.target, target);
  const second = await custCli(['start', '--target', target, '--json'], dir); assert.equal(second.status, 1); assert.equal(JSON.parse(second.stdout).code, 'CUSTODIAN_RUNNING');
  const sock = socketPath(dir, ident(target)); assert.ok(lstatSync(sock).isSocket(), 'the live socket was not touched by the refused second start');
  assert.equal((await custCli(['cancel', '--target', target, '--handoff', 'bad-id'], dir)).status, 1);
  // stop (human) ends the foreground process and removes the socket
  const stop = await custCli(['stop', '--target', target], dir); assert.equal(stop.status, 0); assert.equal((await cu.exited).code, 0); assert.deepEqual(readdirSync(dir), []);
  // hard kill => orphan socket; never removed by age, by status, or by a client; removed by stop/start after refused-connection proof
  const cu2 = spawnCustodian(target, dir); await cu2.ready; cu2.p.kill('SIGKILL'); await cu2.exited;
  assert.equal(readdirSync(dir).length, 2, 'orphan socket + metadata remain after SIGKILL');
  assert.equal(await probeEndpoint(sock), 'stale');
  const stale = await custCli(['status', '--target', target, '--json'], dir); assert.equal(JSON.parse(stale.stdout).state, 'stale-socket'); assert.equal(readdirSync(dir).length, 2, 'status does not delete');
  assert.equal(await codeOf(() => statusOf(target, { dir })), 'HANDOFF_UNAVAILABLE'); assert.equal(readdirSync(dir).length, 2);
  const rm = await custCli(['stop', '--target', target, '--json'], dir); assert.equal(JSON.parse(rm.stdout).state, 'stale-socket-removed'); assert.deepEqual(readdirSync(dir), []);
  const cu3 = spawnCustodian(target, dir); await cu3.ready; cu3.p.kill('SIGKILL'); await cu3.exited;
  const cu4 = spawnCustodian(target, dir); await cu4.ready; assert.equal((await statusOf(target, { dir })).pid, cu4.p.pid, 'start cleaned the stale socket and took over');
  cu4.p.kill('SIGHUP'); await cu4.exited; assert.deepEqual(readdirSync(dir), []);
  // a socket held open by a live foreign listener is never removed
  const foreign = socketPath(dir, ident(target)); const srv = net.createServer((s) => s.destroy()); await new Promise((r) => srv.listen(foreign, r)); chmodSync(foreign, 0o600);
  const refused = await custCli(['start', '--target', target, '--json'], dir); assert.equal(refused.status, 1); assert.ok(lstatSync(foreign).isSocket());
  const stopForeign = await custCli(['stop', '--target', target], dir); assert.notEqual(stopForeign.status, 0, 'a live non-custodian listener is not removed'); assert.ok(lstatSync(foreign).isSocket());
  await new Promise((r) => srv.close(r));
});

// ---- 8-10 real writer CLI against the real custodian + MCP -----------------------------------------------------------------
test('8. [PROC] writer CLI: plan --handoff is repeatable and non-consuming; apply without a TTY fails closed (no write, no consume); --input unchanged', async () => {
  const target = fresh('target'); const dir = freshDir();
  const cu = spawnCustodian(target, dir); await cu.ready;
  const m = startMcp(target, dir); await m.init(); const sub = await m.submit(envelope()); assert.equal(sub.isError, false, JSON.stringify(sub.body)); const id = sub.body.handoff_id;
  m.child.stdin.end(); await m.exited; // MCP closed before Writer runs
  const p1 = await cli(['plan', '--target', target, '--handoff', id, '--json'], dir); const p2 = await cli(['plan', '--target', target, '--handoff', id, '--json'], dir);
  assert.equal(p1.status, 0, p1.stderr); assert.equal(p2.status, 0); assert.equal(JSON.parse(p1.stdout).plan_digest, sub.body.plan_digest);
  assert.deepEqual(JSON.parse(p1.stdout).handoff, { consumed: false }); assert.equal(p1.stdout, p2.stdout); noSdd(target);
  // plan from handoff == plan from --input of the same envelope (same writer code path)
  const f = join(fresh('in'), 'in.json'); writeFileSync(f, JSON.stringify(envelope()));
  const viaInput = await cli(['plan', '--target', target, '--input', f, '--json'], dir);
  assert.equal(viaInput.status, 0); assert.equal(JSON.parse(viaInput.stdout).plan_digest, JSON.parse(p1.stdout).plan_digest);
  // apply with no controlling terminal: fail closed
  const before = snapshot(target);
  const ap = await cli(['apply', '--target', target, '--handoff', id, '--json'], dir);
  assert.equal(ap.status, 1); assert.equal(JSON.parse(ap.stdout).code, 'TTY_REQUIRED'); assert.deepEqual(snapshot(target), before); noSdd(target);
  assert.equal((await cli(['plan', '--target', target, '--handoff', id], dir)).status, 0, 'failed apply did not consume');
  assert.equal((await statusOf(target, { dir })).live_handoffs, 1);
  // flags and misuse
  for (const bad of [['plan', '--target', target, '--handoff', id, '--input', f], ['verify', '--target', target, '--project', PID, '--handoff', id], ['apply', '--target', target, '--handoff', id, '--yes'], ['plan', '--target', target, '--handoff', 'bogus'], ['plan', '--target', target]]) {
    const r = await cli(bad, dir); assert.notEqual(r.status, 0, bad.join(' ')); noSdd(target);
  }
  assert.equal(JSON.parse((await cli(['plan', '--target', target, '--handoff', 'bogus', '--json'], dir)).stdout).code, 'HANDOFF_ID');
  // wrong target for the id: a custodian for another target does not exist -> nothing released
  const other = fresh('other'); const wrong = await cli(['plan', '--target', other, '--handoff', id, '--json'], dir); assert.equal(wrong.status, 1); assert.equal(JSON.parse(wrong.stdout).code, 'HANDOFF_UNAVAILABLE'); noSdd(other);
  // custodian gone => fail closed, zero writes
  cu.p.kill('SIGINT'); await cu.exited;
  const gone = await cli(['apply', '--target', target, '--handoff', id, '--json'], dir); assert.equal(gone.status, 1); assert.equal(JSON.parse(gone.stdout).code, 'HANDOFF_UNAVAILABLE'); noSdd(target);
  // --input regression: unchanged flow, still needs the TTY, schema gates unchanged
  assert.equal((await cli(['apply', '--target', target, '--input', f, '--json'], dir)).status, 1);
  assert.equal(JSON.parse((await cli(['apply', '--target', target, '--input', f, '--json'], dir)).stdout).code, 'TTY_REQUIRED');
  assert.equal((await cli(['plan', '--target', target], dir)).status, 2); assert.equal((await cli(['plan', '--target', target, '--input', '-'], dir)).status, 2);
  noSdd(target);
});

test('9. [UNIT] commit-after-persist failure: uncertain-consumption evidence, honest status, writer is never re-run', async () => {
  const { c, target, opts } = await mkCust();
  const r = await submitHandoff(target, envelope(), opts);
  let runs = 0; let afterApply;
  const out = await withLease(r.handoff_id, target, async (payload) => {
    runs++;
    const res = apply({ target, input: payload, source: SRC, terminal: tty(true), clock: () => Date.parse('2026-11-15T12:00:00.000Z'), random: () => 'ab'.repeat(16) });
    afterApply = snapshot(target);
    await c.close(); // the custodian dies between the persisted write and the commit
    return res;
  }, { ...opts, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.equal(runs, 1, 'writer ran exactly once'); assert.equal(out.result.status, 'APPLIED');
  assert.equal(out.handoff.consumed, false); assert.equal(out.handoff.consumption, 'uncertain');
  assert.equal(out.handoff.evidence.phase, 'commit'); assert.equal(out.handoff.evidence.writer_status, 'APPLIED'); assert.equal(out.handoff.evidence.plan_digest, out.result.plan_digest);
  assert.deepEqual(out.handoff.evidence.files_changed, out.result.files_changed); assert.match(out.handoff.reason, /NOT re-run/);
  assert.deepEqual(snapshot(target), afterApply, 'no automatic rewrite after the commit failure');
  assert.equal(verify({ target, projectId: PID }).status, 'OK');
  // the "gone" variant: handoff expired while applying => definitive, not uncertain
  let now = 5_000_000; const k = await mkCust({ extra: { clock: () => now } }); const r2 = await submitHandoff(k.target, envelope(), k.opts);
  const g = await withLease(r2.handoff_id, k.target, () => { now += 600000; return { status: 'APPLIED' }; }, k.opts);
  assert.equal(g.handoff.consumption, 'gone');
});

test('9b. [UNIT] rollback failed during apply: uncertain, not consumed, writer once, no auto-retry; CLI JSON/text honest; ordinary failures stay retryable', async () => {
  const corrupt = { duringVerify: (root) => { const p = join(root, '.sdd/artifacts', PID, 'constitution.json'); rmSync(p); mkdirSync(p); } };
  const { c, target, opts } = await mkCust();
  const r = await submitHandoff(target, envelope(), opts);
  let runs = 0; let afterFail;
  const out = await withLease(r.handoff_id, target, async (payload) => {
    runs++;
    try { return apply({ target, input: payload, source: SRC, terminal: tty(true), hooks: corrupt }); } finally { afterFail = snapshot(target); }
  }, { ...opts, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.equal(runs, 1, 'writer ran exactly once'); assert.equal(out.result, null);
  assert.equal(out.failure.code, 'VERIFY_FAILED'); assert.equal(out.failure.rollback.status, 'failed');
  assert.ok(out.failure.rollback.failed_paths.includes(`.sdd/artifacts/${PID}/constitution.json`)); assert.deepEqual(out.failure.files_changed, out.failure.rollback.failed_paths);
  assert.ok(out.failure.evidence.path);
  assert.equal(out.handoff.consumed, false); assert.equal(out.handoff.consumption, 'uncertain');
  assert.equal(out.handoff.evidence.phase, 'apply'); assert.equal(out.handoff.evidence.error_code, 'VERIFY_FAILED'); assert.deepEqual(out.handoff.evidence.rollback, out.failure.rollback);
  assert.match(out.handoff.reason, /NOT re-run/); assert.match(out.handoff.evidence.next, /do NOT re-run/);
  assert.deepEqual(snapshot(target), afterFail, 'no automatic rewrite/rollback attempt after the failure');
  assert.equal((await statusOf(target, opts)).live_handoffs, 1, 'not consumed automatically; lease released for an operator decision (cancel)');

  // CLI handoff path (in-process mainHandoff with the real withLease/custodian; apply gets only a fault hook + test TTY)
  const { mainHandoff } = await import('../adapters/shared/sdd-writer/cli.mjs');
  const runCli = async (cu, o, impl) => {
    const logs = []; const errs = []; const ol = console.log; const oe = console.error;
    console.log = (...x) => logs.push(x.join(' ')); console.error = (...x) => errs.push(x.join(' '));
    try { return { code: await mainHandoff({ cmd: 'apply', target: cu.target, runtimeDir: cu.dir, ...o }, { apply: impl }), logs, errs }; } finally { console.log = ol; console.error = oe; }
  };
  let calls = 0;
  const failing = ({ target: t, input }) => { calls++; return apply({ target: t, input, source: SRC, terminal: tty(true), hooks: corrupt }); };
  const k = await mkCust(); const r2 = await submitHandoff(k.target, envelope(), k.opts);
  const j = await runCli(k, { handoff: r2.handoff_id, json: true }, failing);
  assert.equal(calls, 1); assert.equal(j.code, 3);
  const rep = JSON.parse(j.logs.join('\n'));
  assert.equal(rep.status, 'FAILED'); assert.equal(rep.code, 'VERIFY_FAILED'); assert.equal(rep.rollback.status, 'failed'); assert.ok(rep.rollback.failed_paths.length); assert.ok(rep.evidence.path);
  assert.equal(rep.handoff.consumption, 'uncertain'); assert.equal(rep.handoff.consumed, false); assert.equal(rep.handoff.evidence.phase, 'apply');
  assert.equal((await statusOf(k.target, k.opts)).live_handoffs, 1, 'handoff still held for the operator, not consumed');
  // text mode on a fresh target (the first one now has a directory in place of a file)
  const k2 = await mkCust(); const r4 = await submitHandoff(k2.target, envelope(), k2.opts);
  const t = await runCli(k2, { handoff: r4.handoff_id, json: false }, failing);
  assert.equal(calls, 2); assert.equal(t.code, 3); const txt = t.errs.join('\n');
  assert.match(txt, /VERIFY_FAILED/); assert.match(txt, /ROLLBACK FAILED for: .*constitution\.json/); assert.match(txt, /UNCERTAIN/); assert.match(txt, /Do NOT re-run apply/);

  // normal failures stay retryable with zero writes: denial (exception without rollback failure) releases the lease and is thrown
  const n1 = await mkCust(); const s1 = await submitHandoff(n1.target, envelope(), n1.opts);
  const denied = await withLease(s1.handoff_id, n1.target, () => { throw Object.assign(new Error('denied'), { code: 'APPROVAL_DENIED', details: { rollback: { status: 'not-needed', failed_paths: [] } } }); }, n1.opts).catch((e) => e);
  assert.equal(denied.code, 'APPROVAL_DENIED'); noSdd(n1.target); assert.equal((await statusOf(n1.target, n1.opts)).live_handoffs, 1);
  // clean rollback is also an ordinary retryable failure
  const clean = await withLease(s1.handoff_id, n1.target, () => apply({ target: n1.target, input: envelope(), source: SRC, terminal: tty(true), hooks: { duringVerify: (root) => writeFileSync(join(root, '.sdd/artifacts', PID, 'specify.json'), 'x') } }), n1.opts).catch((e) => e);
  assert.equal(clean.code, 'VERIFY_FAILED'); assert.equal(clean.details.rollback.status, 'clean'); noSdd(n1.target);
  const ok = await withLease(s1.handoff_id, n1.target, (p) => apply({ target: n1.target, input: p, source: SRC, terminal: tty(true) }), { ...n1.opts, shouldConsume: (x) => x.status === 'APPLIED' });
  assert.equal(ok.handoff.consumption, 'consumed'); assert.equal(verify({ target: n1.target, projectId: PID }).status, 'OK');
  void c;
});

test('10. [UNIT] TTL over the socket: handoff is live at 599999 ms and gone at 600000 ms; expired payload is purged', async () => {
  let now = 9_000_000; const { c, target, opts } = await mkCust({ extra: { clock: () => now } });
  const r = await submitHandoff(target, envelope(), opts);
  now += 599999; assert.equal((await peekHandoff(r.handoff_id, target, opts)).payload.project_id, PID);
  now += 1; assert.equal(await codeOf(() => peekHandoff(r.handoff_id, target, opts)), 'HANDOFF_NOT_FOUND'); assert.equal(c.store.size, 0);
});

// ---- 11 Claude Code config ----------------------------------------------------------------------------------------------
test('11. [UNIT] Claude Code handoff config is portable (project-relative + env reference), grants only the submit tool; example fragments match; no Codex/Cursor wiring', () => {
  assert.deepEqual(mcpServerEntry(), { command: 'node', args: ['.dac/runtime/sdd-handoff/mcp-server.mjs', '--target', '.', '--runtime-dir', `\${${RUNTIME_DIR_ENV}}`] });
  assert.equal(TOOL_PERMISSION, 'mcp__dac-sdd-handoff__sdd_handoff_submit');
  const ex = join(REPO_ROOT, 'adapters/claude-code/examples/sdd-handoff-poc');
  assert.deepEqual(JSON.parse(readFileSync(join(ex, '.mcp.json'), 'utf8')), { mcpServers: { [SERVER_NAME]: mcpServerEntry() } });
  assert.deepEqual(JSON.parse(readFileSync(join(ex, '.claude/settings.json'), 'utf8')), { permissions: { allow: [TOOL_PERMISSION] }, enabledMcpjsonServers: [SERVER_NAME] });
  for (const f of ['adapters/cursor']) assert.equal(spawnSync('grep', ['-rli', 'sdd-handoff\\|sdd_handoff', join(REPO_ROOT, f)], { encoding: 'utf8' }).stdout.trim(), '', `${f} not wired`); // Codex wiring: tests/codex-handoff-bootstrap.test.mjs
  // source-level surface check: the proxy cannot apply, write, run commands or open its own listener
  const src = readFileSync(join(REPO_ROOT, 'adapters/shared/sdd-handoff/mcp-server.mjs'), 'utf8');
  assert.ok(!/child_process|writeFile|createServer\(\(|net\.createServer|\bapply\(|openTrustedTerminal/.test(src.replace(/export function createServer/g, '')));
  // the distributed runtime is exactly the proxy and its helpers: no custodian, writer, approval or Node-fs write code
  assert.deepEqual([...runtimeFiles().keys()].map((k) => k.split('/').pop()).sort(), ['client.mjs', 'core.mjs', 'endpoint.mjs', 'errors.mjs', 'identity.mjs', 'mcp-server.mjs']);
});

// ---- 14/15 endpoint resolution: independent of TMPDIR, cwd and the process environment -----------------------------------------
const metaOf = (dir, t) => JSON.parse(readFileSync(metaPath(dir, ident(t)), 'utf8'));
test('14. [PROC] custodian TMPDIR=A, writer TMPDIR=B, MCP TMPDIR=C, different cwds, MCP restart and Claude-close: same endpoint, plan stays read-only', async () => {
  const target = fresh('target'); const dir = freshDir();
  const A = fresh('tmpA'); const B = fresh('tmpB'); const C = fresh('tmpC'); const C2 = fresh('tmpC2'); const cwdA = fresh('cwdA'); const cwdB = fresh('cwdB'); const cwdC = fresh('cwdC');
  const cu = spawnCustodian(target, dir, { tmp: A, cwd: cwdA }); await cu.ready;
  const m1 = startMcp(target, dir, { tmp: C, cwd: cwdC }); await m1.init();
  const sub = await m1.submit(envelope()); assert.equal(sub.isError, false, JSON.stringify(sub.body)); const id = sub.body.handoff_id;
  assert.ok(sub.body.human_commands.plan.includes(`--runtime-dir '${dir}'`), 'the human command carries the fixed runtime dir');
  // minimal metadata: exact keys, 0600, no payload/capability/approval material, nothing else in the directory
  const meta = metaOf(dir, target); assert.deepEqual(Object.keys(meta).sort(), ['instance_id', 'pid', 'runtime_dir', 'schema', 'socket', 'started_at', 'target', 'version']);
  assert.equal(lstatSync(metaPath(dir, ident(target))).mode & 0o777, 0o600); assert.equal(meta.pid, cu.p.pid); assert.equal(meta.runtime_dir, dir);
  const raw = readFileSync(metaPath(dir, ident(target)), 'utf8'); assert.ok(!raw.includes(MARK) && !raw.includes(id) && !/phrase|approv|capabilit|payload|secret/i.test(raw));
  assert.deepEqual(markerHits(dir, shortBase), []);
  // writer in yet another TMPDIR/cwd, with a bogus legacy env override that must be ignored
  const before = snapshot(target);
  const w = (args, o) => runNode(clone().cli, withRt(args, dir), dir, { tmp: B, cwd: cwdB, ...o });
  const p1 = await w(['plan', '--target', target, '--handoff', id, '--json']); assert.equal(p1.status, 0, p1.stdout + p1.stderr); const p2 = await w(['plan', '--target', target, '--handoff', id, '--json']);
  assert.equal(JSON.parse(p1.stdout).plan_digest, sub.body.plan_digest); assert.equal(JSON.parse(p2.stdout).handoff.consumed, false);
  assert.deepEqual(snapshot(target), before, 'plan wrote nothing'); noSdd(target); assert.equal((await statusOf(target, { dir })).live_handoffs, 1, 'plan did not consume');
  // Claude-close equivalent: SIGKILL the MCP; then a restarted MCP in another TMPDIR/cwd reaches the same custodian
  m1.child.kill('SIGKILL'); await m1.exited;
  const m2 = startMcp(target, dir, { tmp: C2, cwd: cwdB }); await m2.init();
  const sub2 = await m2.submit(envelope({ operation: 'create' })); assert.equal(sub2.isError, false, JSON.stringify(sub2.body));
  assert.equal((await statusOf(target, { dir })).live_handoffs, 2); assert.equal((await w(['plan', '--target', target, '--handoff', id, '--json'])).status, 0, 'first handoff survived MCP kill and restart');
  m2.child.stdin.end(); await m2.exited;
  // the operator CLI and an in-process client in this (different) TMPDIR/cwd agree too; legacy env var and TMPDIR are inert
  const st = await custCli(['status', '--target', target, '--json'], dir, { tmp: fresh('tmpD'), cwd: cwdA }); assert.equal(JSON.parse(st.stdout).pid, cu.p.pid);
  const prevT = process.env.TMPDIR; const prevD = process.env.DAC_SDD_HANDOFF_DIR; process.env.TMPDIR = fresh('tmpE'); process.env.DAC_SDD_HANDOFF_DIR = fresh('bogus');
  try { assert.equal((await statusOf(target, { dir })).pid, cu.p.pid); } finally { if (prevT === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevT; if (prevD === undefined) delete process.env.DAC_SDD_HANDOFF_DIR; else process.env.DAC_SDD_HANDOFF_DIR = prevD; }
  // no runtime dir => fail closed, never a tmpdir fallback (writer usage error; client/CLI error)
  assert.equal((await runNode(clone().cli, ['plan', '--target', target, '--handoff', id], dir, { tmp: dir })).status, 2);
  assert.equal((await runNode(clone().cust, ['status', '--target', target], dir, { tmp: dir })).status, 2);
  assert.equal(await codeOf(() => statusOf(target)), 'HANDOFF_ENDPOINT'); assert.equal(await codeOf(() => statusOf(target, { dir: 'rel' })), 'HANDOFF_ENDPOINT');
  assert.deepEqual(snapshot(target), before); noSdd(target);
  // custodian exit removes socket and metadata; clients then fail closed
  cu.p.kill('SIGTERM'); await cu.exited; assert.deepEqual(readdirSync(dir), []);
  assert.equal(await codeOf(() => statusOf(target, { dir })), 'HANDOFF_UNAVAILABLE');
});

test('15. [UNIT] discovery hardening: metadata/socket substitution, symlink, mode, link count, schema, target, instance, dir validation, one custodian per target', async () => {
  const { c, target, dir, opts } = await mkCust(); const id = ident(target); const mp = metaPath(dir, id); const good = readFileSync(mp, 'utf8');
  assert.equal((await statusOf(target, opts)).pid, process.pid);
  // metadata attacks (each leaves the custodian untouched and is refused before any request)
  const replace = (txt) => { writeFileSync(`${mp}.n`, txt, { mode: 0o600 }); renameSync(`${mp}.n`, mp); };
  const attack = async (name, mut) => { replace(typeof mut === 'string' ? mut : JSON.stringify(mut(JSON.parse(good)))); assert.equal(await codeOf(() => statusOf(target, opts)), 'HANDOFF_ENDPOINT', name); replace(good); assert.equal((await statusOf(target, opts)).pid, process.pid, `${name}: restored`); };
  await attack('malformed json', '{not json'); await attack('extra field (payload smuggling)', (m) => ({ ...m, payload: 'x' })); await attack('bad version', (m) => ({ ...m, version: 2 })); await attack('bad schema', (m) => ({ ...m, schema: 'x' }));
  await attack('wrong target identity', (m) => ({ ...m, target: { ...m.target, inode: '1' } })); await attack('wrong runtime dir', (m) => ({ ...m, runtime_dir: `${dir}x` }));
  await attack('wrong socket name', (m) => ({ ...m, socket: { ...m.socket, name: 'h2-x.sock' } })); await attack('wrong socket inode', (m) => ({ ...m, socket: { ...m.socket, ino: '1' } }));
  await attack('wrong instance', (m) => ({ ...m, instance_id: 'deadbeef0000' })); await attack('wrong pid', (m) => ({ ...m, pid: process.pid + 1 }));
  chmodSync(mp, 0o644); assert.equal(await codeOf(() => statusOf(target, opts)), 'HANDOFF_ENDPOINT', 'loose metadata mode'); chmodSync(mp, 0o600);
  const other = join(dir, 'other.json'); writeFileSync(other, good, { mode: 0o600 }); unlinkSync(mp); symlinkSync(other, mp);
  assert.equal(await codeOf(() => statusOf(target, opts)), 'HANDOFF_ENDPOINT', 'symlinked metadata'); unlinkSync(mp); unlinkSync(other); replace(good);
  linkSync(mp, other); assert.equal(await codeOf(() => statusOf(target, opts)), 'HANDOFF_ENDPOINT', 'hard-linked metadata'); unlinkSync(other);
  assert.equal(readMetadata(dir, id).instance_id, c.instanceId);
  // wrong target: another target has no metadata (UNAVAILABLE); a copy of ours under its name is refused (target-bound)
  const wrong = fresh('wrong'); assert.equal(await codeOf(() => statusOf(wrong, opts)), 'HANDOFF_UNAVAILABLE');
  writeFileSync(metaPath(dir, ident(wrong)), good, { mode: 0o600 }); assert.equal(await codeOf(() => statusOf(wrong, opts)), 'HANDOFF_ENDPOINT'); unlinkSync(metaPath(dir, ident(wrong)));
  // socket substitution: the impostor owns a perfectly private 0600 socket at the right path, but not the recorded inode -> never contacted
  const sock = socketPath(dir, id); const sockMeta = readFileSync(mp, 'utf8'); let impostorSaw = 0;
  const live = await submitHandoff(target, envelope(), opts); renameSync(sock, `${sock}.real`);
  const imp = net.createServer((s) => { impostorSaw++; s.on('data', () => { impostorSaw++; }); }); await new Promise((r) => imp.listen(sock, r)); chmodSync(sock, 0o600);
  assert.equal(await codeOf(() => submitHandoff(target, envelope(), opts)), 'HANDOFF_ENDPOINT'); assert.equal(await codeOf(() => peekHandoff(live.handoff_id, target, opts)), 'HANDOFF_ENDPOINT'); assert.equal(impostorSaw, 0, 'impostor never received a connection, let alone a payload');
  assert.equal(await codeOf(() => startCustodian({ target, dir, writePlan: stubPlan })), 'CUSTODIAN_RUNNING', 'start never replaces a live (even impostor) listener');
  await new Promise((r) => imp.close(r)); try { unlinkSync(sock); } catch { /* closed server removed it */ } renameSync(`${sock}.real`, sock); assert.equal(readFileSync(mp, 'utf8'), sockMeta);
  assert.equal((await peekHandoff(live.handoff_id, target, opts)).payload.project_id, PID, 'original custodian intact after the substitution attempt');
  // one custodian per target (same runtime dir); metadata unchanged by the refused second start
  assert.equal(await codeOf(() => startCustodian({ target, dir, writePlan: stubPlan })), 'CUSTODIAN_RUNNING'); assert.equal(readFileSync(mp, 'utf8'), good);
  // a custodian in a different runtime dir is a separate, unreachable-from-here endpoint: clients only ever use their configured dir
  const k = await mkCust({ target }); const inK = await submitHandoff(target, envelope(), k.opts);
  assert.equal(await codeOf(() => peekHandoff(inK.handoff_id, target, opts)), 'HANDOFF_NOT_FOUND'); assert.equal(c.store.size, 1);
  // runtime dir validation
  for (const bad of [undefined, '', 'rel/dir', '/', `${dir}/`, `${dir}/../x`, `${dir}/./y`, `${dir}\0x`]) assert.throws(() => resolveRuntimeDir(bad), { code: 'HANDOFF_ENDPOINT' }, String(bad));
  assert.equal(await codeOf(() => startCustodian({ target: fresh('t'), writePlan: stubPlan })), 'HANDOFF_ENDPOINT', 'no implicit default directory');
  const viaLink = join(shortBase, `rl${n++}`); symlinkSync(dir, viaLink); assert.equal(await codeOf(() => statusOf(target, { dir: viaLink })), 'HANDOFF_ENDPOINT'); assert.equal(await codeOf(() => startCustodian({ target: fresh('t'), dir: viaLink, writePlan: stubPlan })), 'HANDOFF_ENDPOINT');
  const open777 = join(shortBase, `w${n++}`); mkdirSync(open777); chmodSync(open777, 0o777); const under = join(open777, 'rt'); mkdirSync(under, { mode: 0o700 });
  assert.equal(await codeOf(() => startCustodian({ target: fresh('t'), dir: under, writePlan: stubPlan })), 'HANDOFF_ENDPOINT', 'group/world-writable non-sticky ancestor');
  assert.equal(await codeOf(() => statusOf(target, { dir: join(shortBase, 'missing-rt') })), 'HANDOFF_ENDPOINT');
  // owner checks need a second uid (not testable unprivileged): assert the code path exists and the current-uid happy path passes
  assert.equal(lstatSync(mp).uid, process.getuid()); assert.match(readFileSync(new URL('../adapters/shared/sdd-handoff/endpoint.mjs', import.meta.url), 'utf8'), /not owned by the current user/);
  // the proxy accepts no endpoint/runtime/target selection through tool arguments
  const srv = createServer({ target, runtimeDir: dir });
  for (const extra of [{ runtime_dir: '/tmp/x' }, { runtimeDir: '/tmp/x' }, { endpoint: '/tmp/x.sock' }, { socket: 'x' }, { target: '/tmp/x' }]) { const r = await srv.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: TOOL_NAME, arguments: envelope(extra) } }); assert.equal(JSON.parse(r.result.content[0].text).code, 'INPUT'); }
  assert.equal(c.store.size, 1, 'rejected calls stored nothing');
  // distributed adapters hold no machine-specific path and no tmpdir/env endpoint derivation
  const files = ['adapters/shared/sdd-handoff', 'adapters/claude-code/examples/sdd-handoff-poc'].flatMap((d) => spawnSync('grep', ['-rlE', `/${'Users'}/|/${'home'}/|os\\.tmpdir|tmpdir\\(|DAC_SDD_HANDOFF_DIR|process\\.env|process\\.cwd`, join(REPO_ROOT, d)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  assert.deepEqual(files, []);
});

// ---- 12 REAL Claude Code discovery (no model call) ------------------------------------------------------------------------
const haveClaude = spawnSync('which', ['claude'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status === 0;
const SANDBOX = sandboxAvailable() && isolatedBase() !== null;
const skipClaude = (!SANDBOX && `BLOCKED, runtime unverified: ${isolatedBase() === null ? 'no temp base outside the real home' : sandboxUnavailableReason()}`) || (!haveClaude && 'claude CLI not installed');
test('12. [REAL-CLAUDE] installed Claude Code starts the stateless MCP proxy from project config (no credentials, no model call), connects, exposes exactly the one tool', { skip: skipClaude }, () => {
  const rt = createRuntime();
  try {
    const proven = verifySandbox(rt); assert.ok(proven.ok, JSON.stringify(proven));
    const target = join(rt.ws, 'target'); mkdirSync(target);
    // Concrete (machine-local) resolution of the portable entry, written only into this disposable sandbox workspace.
    const entry = mcpServerEntry(); const args = [clone().mcp, '--target', realpathSync(target), '--runtime-dir', freshDir()];
    assert.equal(entry.args.length, args.length);
    writeFileSync(join(rt.ws, '.mcp.json'), JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: process.execPath, args } } }));
    mkdirSync(join(rt.ws, '.claude')); writeFileSync(join(rt.ws, '.claude/settings.json'), JSON.stringify({ permissions: { allow: [TOOL_PERMISSION] }, enabledMcpjsonServers: [SERVER_NAME] }));
    const { init, result } = claudeInit(rt, ['--tools', '']);
    assert.ok(init, `no init event: ${result.stderr}`);
    const srv = init.mcp_servers.find((s) => s.name === SERVER_NAME);
    assert.equal(srv?.status, 'connected', JSON.stringify(init.mcp_servers));
    assert.deepEqual(init.tools.filter((x) => x.startsWith('mcp__')), [TOOL_PERMISSION]);
    for (const w of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.ok(!init.tools.includes(w), `${w} must not be available with --tools ""`);
    assert.ok(!init.tools.some((x) => /apply|cancel/i.test(x)));
    noSdd(target);
  } finally { rt.dispose(); }
});

// ---- 13 PTY end to end through the real CLI ---------------------------------------------------------------------------------
const REQUIRE_PTY = process.env.DAC_REQUIRE_PTY === '1';
const ptyProbe = (() => { const r = spawnSync('python3', ['-I', '-c', 'import os,pty\nos.close(pty.openpty()[0])'], { timeout: 10000 }); return r.error || r.status !== 0 ? 'python3/pty unavailable' : ''; })();
const PTY = `import os,pty,sys,select,time
args=sys.argv[1:-1]; mode=sys.argv[-1]
pid,fd=pty.fork()
if pid==0:
    os.execv(args[0],args)
out=b'';end=time.time()+40;sent=False
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.05)
    if r:
        try: d=os.read(fd,4096)
        except OSError: break
        if not d: break
        out+=d
    txt=out.decode('utf8','replace')
    if not sent and 'Type exactly "' in txt and '" within' in txt:
        phrase=txt.split('Type exactly "',1)[1].split('" within',1)[0]
        time.sleep(0.2); os.write(fd,((phrase if mode=='approve' else 'no')+'\\n').encode()); sent=True
_,st=os.waitpid(pid,0)
sys.stdout.write(out.decode('utf8','replace')); sys.stdout.write('\\nEXIT %d\\n'%(os.waitstatus_to_exitcode(st)))`;
const ptyCli = (args, dir, mode) => new Promise((resolve) => {
  const p = spawn('python3', ['-I', '-c', PTY, process.execPath, clone().cli, ...withRt(args, dir), mode], { env: envFor() });
  let out = ''; p.stdout.on('data', (c) => { out += c; }); p.on('close', () => resolve({ out, exit: Number(/EXIT (-?\d+)/.exec(out)?.[1] ?? NaN) }));
});
test('13. [PTY] full flow with real processes on a real /dev/tty: custodian -> MCP submit -> MCP closed -> plan -> denial keeps handoff -> approval applies+consumes -> verify -> replay rejected', { skip: !REQUIRE_PTY && ptyProbe ? ptyProbe : false }, async () => {
  if (ptyProbe) assert.fail(`mandatory PTY prerequisite missing: ${ptyProbe}`);
  const target = fresh('target'); const dir = freshDir();
  const cu = spawnCustodian(target, dir); await cu.ready;
  const m = startMcp(target, dir); await m.init(); const sub = await m.submit(envelope()); assert.equal(sub.isError, false, JSON.stringify(sub.body));
  m.child.stdin.end(); await m.exited;
  const id = sub.body.handoff_id;
  assert.equal((await cli(['plan', '--target', target, '--handoff', id], dir)).status, 0); noSdd(target);
  const denied = await ptyCli(['apply', '--target', target, '--handoff', id], dir, 'deny');
  assert.match(denied.out, /APPROVAL_DENIED/); assert.notEqual(denied.exit, 0); noSdd(target);
  assert.equal((await cli(['plan', '--target', target, '--handoff', id], dir)).status, 0, 'denial did not consume');
  assert.equal((await statusOf(target, { dir })).live_handoffs, 1, 'lease released after denial');
  const ok = await ptyCli(['apply', '--target', target, '--handoff', id], dir, 'approve');
  assert.equal(ok.exit, 0, ok.out); assert.match(ok.out, /APPLIED/); assert.match(ok.out, /handoff consumed/);
  const ver = await cli(['verify', '--target', target, '--project', PID, '--json'], dir); assert.equal(ver.status, 0, ver.stdout + ver.stderr); assert.equal(JSON.parse(ver.stdout).status, 'OK');
  const snap = snapshot(target);
  const replay = await cli(['apply', '--target', target, '--handoff', id, '--json'], dir);
  assert.equal(replay.status, 1); assert.equal(JSON.parse(replay.stdout).code, 'HANDOFF_NOT_FOUND'); assert.deepEqual(snapshot(target), snap);
  assert.equal((await cli(['plan', '--target', target, '--handoff', id], dir)).status, 1, 'consumed handoff cannot be planned either');
  assert.equal((await statusOf(target, { dir })).live_handoffs, 0);
  assert.deepEqual(markerHits(dir), [], 'no payload in the endpoint directory');
  cu.p.kill('SIGINT'); await cu.exited;
});

// ---- 16/17 review follow-ups (LOW findings) -------------------------------------------------------------------------------------
import { probeEndpoint as probe, cleanStaleSocket } from '../adapters/shared/sdd-handoff/custodian.mjs';
import { sanitizeErrors, MAX_FORWARDED_ERRORS } from '../adapters/shared/sdd-handoff/errors.mjs';
import { HandoffError as HandoffErr } from '../adapters/shared/sdd-handoff/core.mjs';

test('16. [UNIT] probeEndpoint is coupled to the private-socket checks: it never connects to, nor reports on, an unverified path, so it cannot be reused unsafely', async () => {
  const dir = freshDir(); let saw = 0;
  const listen = async (p, mode) => { const s = net.createServer((c) => { saw++; c.destroy(); }); await new Promise((r) => s.listen(p, r)); chmodSync(p, mode); return s; };
  // regular file, dangling path, loose-mode live socket, symlink to a perfectly private live socket
  writeFileSync(join(dir, 'file.sock'), 'x'); assert.equal(await codeOf(() => probe(join(dir, 'file.sock'))), 'HANDOFF_ENDPOINT');
  assert.equal(await probe(join(dir, 'missing.sock')), 'absent');
  const loose = await listen(join(dir, 'loose.sock'), 0o666); assert.equal(await codeOf(() => probe(join(dir, 'loose.sock'))), 'HANDOFF_ENDPOINT'); assert.equal(saw, 0, 'loose socket never contacted');
  const priv = await listen(join(dir, 'priv.sock'), 0o600); symlinkSync(join(dir, 'priv.sock'), join(dir, 'ln.sock')); assert.equal(await codeOf(() => probe(join(dir, 'ln.sock'))), 'HANDOFF_ENDPOINT'); assert.equal(saw, 0, 'symlinked endpoint never contacted');
  assert.equal(await probe(join(dir, 'priv.sock')), 'live'); await new Promise((r) => loose.close(r));
  // cleanStaleSocket refuses (and never unlinks) anything that is not a verified private socket, and never unlinks a live one
  assert.equal(await codeOf(() => cleanStaleSocket(join(dir, 'file.sock'), {})), 'HANDOFF_ENDPOINT'); assert.ok(existsSync(join(dir, 'file.sock')));
  assert.equal(await cleanStaleSocket(join(dir, 'priv.sock'), {}), 'live'); assert.ok(existsSync(join(dir, 'priv.sock'))); await new Promise((r) => priv.close(r));
  // the invariant is in the function itself (not only in its callers): the check precedes any connect
  const src = readFileSync(new URL('../adapters/shared/sdd-handoff/custodian.mjs', import.meta.url), 'utf8'); const fn = src.slice(src.indexOf('export function probeEndpoint'), src.indexOf('// Removes a stale socket'));
  assert.ok(fn.indexOf('assertPrivateSocket(path)') > 0 && fn.indexOf('assertPrivateSocket(path)') < fn.indexOf('createConnection'));
  assert.match(src, /SAFETY INVARIANT/);
  // and every production call site is a direct use of the coupled function
  for (const f of ['custodian.mjs', 'custodian-cli.mjs']) assert.ok(!/net\.createConnection\(\s*socketPath/.test(readFileSync(new URL(`../adapters/shared/sdd-handoff/${f}`, import.meta.url), 'utf8')));
});

test('17. [UNIT] validation errors forwarded to the agent never echo submitted content (adversarial ids, keys, paths, control characters, floods)', async () => {
  const EVIL = 'zzevilmarker'; const evilId = 'zz-evil-id-9f3c';
  const { c, target, dir } = await mkCust(); const srv = createServer({ target, runtimeDir: dir });
  const call = async (args) => { const r = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: args } }); return { isError: r.result.isError, text: r.result.content[0].text, body: JSON.parse(r.result.content[0].text) }; };
  const hostile = [
    envelope({ constitution: { ...constitution(), [EVIL]: 'x' } }), // unknown field NAME
    envelope({ constitution: { ...constitution(), [`${EVIL}\u001b[31m`]: 'x' } }), // ANSI in key
    envelope({ constitution: { ...constitution(), principles: [{ id: evilId, statement: 'a' }, { id: evilId, statement: 'b' }] } }), // duplicate id echo
    envelope({ specify: { ...specify(), acceptance_criteria: [{ id: 'ac-1', requirement: evilId, statement: 's', verification: 'v' }] } }), // dangling reference echo
    envelope({ specify: { ...specify(), requirements: [{ id: 'req-1', statement: 'ok', acceptance_criteria: [evilId], open_questions: [] }] } }), // broken ref echo
    envelope({ constitution: { ...constitution(), principles: [{ id: 'p-one', statement: `${EVIL}‮` }] } }), // bidi in a value
    envelope({ constitution: { ...constitution(), kind: EVIL } }), envelope({ project_id: EVIL.toUpperCase() }),
  ];
  for (const h of hostile) { const r = await call(h); assert.equal(r.isError, true); assert.ok(!r.text.includes(EVIL) && !r.text.includes(evilId) && !r.text.includes('\u001b') && !r.text.includes('‮'), r.text); for (const e of r.body.errors ?? []) assert.deepEqual(Object.keys(e), ['code', 'rule', 'path', 'message']); }
  assert.equal(c.store.size, 0, 'nothing stored for rejected submissions');
  // the custodian also redacts on the wire (a different proxy/consumer of the socket sees the same projection)
  const wire = await submitHandoff(target, hostile[2], { dir }).catch((e) => e); assert.ok(!JSON.stringify(wire.details ?? {}).includes(evilId));
  // the unit projection: fixed shape, bounded, quoted/unknown/odd content removed
  const out = sanitizeErrors([
    { code: 'SDD_ARTIFACT', rule: 'duplicate-id', path: '$.principles', message: `duplicate id "${evilId}"` },
    { code: 'SCHEMA_UNKNOWN_FIELD', path: `$.constitution.${EVIL}`, message: `unknown field "${EVIL}"` },
    { code: 'SCHEMA_MISSING_FIELD', path: '$.constitution', message: 'missing required field "principles"' },
    { code: 'SCHEMA_MISSING_FIELD', path: '$.constitution', message: `missing required field "${EVIL}-x"` },
    { code: 'bad code <script>', rule: 'RULE\u001b', path: `$.a["${EVIL}"].b[99999999]\u0000`, message: `bad "${EVIL}\u001b[2J" ${'A'.repeat(5000)}` },
    { code: 'X', path: 'not-a-path', message: { toString() { return EVIL; } } }, null, 'str', 7,
    ...Array.from({ length: 500 }, (_, i) => ({ code: 'SDD_ARTIFACT', rule: 'r', path: '$', message: `m${i}` })),
  ]);
  assert.equal(out.length, MAX_FORWARDED_ERRORS); const text = JSON.stringify(out);
  assert.ok(!text.includes(evilId) && !text.includes(EVIL) && !/[\u0000-\u001f]/.test(text.replace(/\\u[0-9a-f]{4}/gi, '')), text);
  assert.deepEqual(out[0], { code: 'SDD_ARTIFACT', rule: 'duplicate-id', path: '$.principles', message: 'duplicate id "<redacted>"' });
  assert.equal(out[1].path, '$.constitution.<unknown-field>'); assert.equal(out[2].message, 'missing required field "principles"');
  assert.ok(!out[3].message.includes(EVIL)); assert.equal(out[4].code, 'INVALID'); assert.ok(out[4].message.length <= 170); assert.equal(sanitizeErrors('x').length, 0);
  for (const e of out) assert.deepEqual(Object.keys(e), ['code', 'rule', 'path', 'message']);
  // contract the redaction relies on: every writer message that embeds submitted content embeds it inside double quotes
  const art = readFileSync(new URL('../adapters/shared/sdd-writer/artifacts.mjs', import.meta.url), 'utf8').split('\n').filter((l) => /\bsem\(/.test(l) && l.includes('${'));
  assert.ok(art.length >= 5); for (const l of art) { const msg = l.match(/`[^`]*`/g).pop(); for (const m of msg.matchAll(/\$\{[^}]*\}/g)) assert.equal(msg[m.index - 1], '"', `unquoted interpolation in writer message: ${l.trim()}`); }
  const sch = readFileSync(new URL('../installer/lib/schema.mjs', import.meta.url), 'utf8').split('\n').filter((l) => /message|add\(/.test(l) && l.includes('${') && /\bkey\b/.test(l)); assert.ok(sch.length >= 2); for (const l of sch) { const msg = l.match(/`[^`]*`/g).pop(); for (const m of msg.matchAll(/\$\{key\}/g)) assert.equal(msg[m.index - 1], '"', `unquoted key in schema message: ${l.trim()}`); }
  // the installed proxy ships the same redaction (defence in depth if a custodian ever returned raw errors)
  const fake = createServer({ target, runtimeDir: dir, submit: async () => { throw Object.assign(new HandoffErr('VALIDATION', 'x'), { details: { errors: [{ code: 'SDD_ARTIFACT', rule: 'duplicate-id', path: `$.${EVIL}`, message: `duplicate id "${evilId}"` }] } }); } });
  const fr = await fake.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL_NAME, arguments: envelope() } }); assert.ok(!fr.result.content[0].text.includes(evilId));
});

test('17b. [UNIT] metadata failure after listen closes and removes the socket with no discoverable stale state', async () => {
  const target = fresh('metadata-failure-target'); const dir = freshDir();
  const identity = ident(target); const path = socketPath(dir, identity);
  await assert.rejects(
    startCustodian({ target, dir, writePlan: stubPlan, writeDiscovery() { throw new Error('injected metadata failure'); } }),
    /injected metadata failure/,
  );
  assert.equal(existsSync(path), false, 'listening socket removed after discovery metadata failure');
  assert.equal(existsSync(metaPath(dir, identity)), false, 'no discovery metadata left behind');
  assert.deepEqual(readdirSync(dir), [], 'runtime directory has no stale endpoint state');
});

// ---- 18 REAL Claude Code with the PORTABLE generated config (no model call) -----------------------------------------------------
import { generate as generateClaudeFiles } from '../adapters/claude-code/lib/generate.mjs';
test('18. [REAL-CLAUDE] the bootstrap-generated portable config (relative script, --target ., ${DAC_SDD_RUNTIME_DIR}) is started by installed Claude Code from the project root; unset variable => server does not connect', { skip: skipClaude }, () => {
  const place = (rt) => { for (const [p, buf] of generateClaudeFiles({ sddHandoff: true }).files) { mkdirSync(join(rt.ws, p, '..'), { recursive: true }); writeFileSync(join(rt.ws, p), buf); } };
  const rtDir = join(shortBase, `claude-rt-${n++}`); // only needs to be syntactically valid for startup; no custodian is contacted
  const withVar = createRuntime({ extraEnv: { DAC_SDD_RUNTIME_DIR: rtDir } });
  try {
    assert.ok(verifySandbox(withVar).ok); place(withVar);
    const { init, result } = claudeInit(withVar, ['--tools', '']); assert.ok(init, `no init event: ${result.stderr}`);
    const srv = init.mcp_servers.find((s) => s.name === SERVER_NAME); assert.equal(srv?.status, 'connected', JSON.stringify(init.mcp_servers));
    assert.deepEqual(init.tools.filter((x) => x.startsWith('mcp__')), [TOOL_PERMISSION]);
    assert.ok(!existsSync(join(withVar.ws, '.sdd')) && !existsSync(rtDir), 'nothing created by startup');
  } finally { withVar.dispose(); }
  const noVar = createRuntime();
  try {
    place(noVar); const { init } = claudeInit(noVar, ['--tools', '']);
    // fail closed: whichever way Claude reports the unresolved variable, the submit tool must not be available
    assert.ok(!init || !init.tools.includes(TOOL_PERMISSION) || init.mcp_servers.find((s) => s.name === SERVER_NAME)?.status !== 'connected', 'unset DAC_SDD_RUNTIME_DIR must not yield a working proxy');
  } finally { noVar.dispose(); }
});
