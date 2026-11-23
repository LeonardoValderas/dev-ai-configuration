// Authorized npm provisioning + verified private cache + offline install for `dac review` independent validation.
// EVERYTHING is local and deterministic: the provisioner and the validator are injected simulations (a fake cacache built from a
// local lockfile fixture). No npm package is downloaded, no provider is probed, and the trusted terminal is always injected
// (`openTerminal` defaults to a throwing stub so a real /dev/tty is never opened). Real macOS sandbox checks live in the second half.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as H from './support/run-harness.mjs';
import { makeProject, persist, projectDoc, task, impl, runs, reviewRunner, validationSim, implRunner, quiet, tty, noTty, write, okResult } from './support/run-harness.mjs';
import { reviewTask } from '../adapters/shared/sdd-run/review.mjs';
import { runIndependentValidation } from '../adapters/shared/sdd-run/validation.mjs';
import { digestOf } from '../adapters/shared/sdd-writer/artifacts.mjs';
import { exactPlanOf, reuseGrantOf, indexKey, indexPath, CACACHE_DIR, analyzeLock, cacheManifest, cacheCoverage, detectNpm, planNpm, provisionerRunner, assertSafeProvisionerProfile, npmCommandProblem, stageCache, PROVISION_ARGV, OFFLINE_INSTALL_ARGV, OFFLINE_INSTALL_COMMAND, PROVISION_PROFILE } from '../adapters/shared/sdd-run/npm-provision.mjs';

after(() => { rmSync(H.scratch, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------------- fixtures
const TOOL = { node: 'v22.11.0', npm: '10.9.0', platform: 'darwin', arch: 'arm64', libc: null };
const tarball = (name) => Buffer.from(`fake tarball bytes for ${name}\n`);
const integrity = (name) => `sha512-${createHash('sha512').update(tarball(name)).digest('base64')}`;
const entry = (name, version, extra = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: integrity(`${name}@${version}`), ...extra });
const PKG = { name: 'vite-react-app', version: '0.0.0', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', test: 'node --test' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0', '@vitejs/plugin-react': '^4.3.0' } };
const lockFor = (pkg = PKG, over = {}) => ({
  name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
  packages: {
    '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
    'node_modules/react': entry('react', '18.3.1'), 'node_modules/react-dom': entry('react-dom', '18.3.1', { dependencies: { react: '^18.3.1' } }),
    'node_modules/vite': entry('vite', '5.4.0', { dev: true, hasInstallScript: false, optionalDependencies: { fsevents: '~2.3.3' } }),
    'node_modules/@vitejs/plugin-react': entry('@vitejs/plugin-react', '4.3.0', { dev: true }),
    'node_modules/esbuild': entry('esbuild', '0.21.5', { dev: true, hasInstallScript: true }),
    'node_modules/@esbuild/darwin-arm64': entry('@esbuild/darwin-arm64', '0.21.5', { dev: true, optional: true, os: ['darwin'], cpu: ['arm64'] }),
    'node_modules/@esbuild/linux-x64': entry('@esbuild/linux-x64', '0.21.5', { dev: true, optional: true, os: ['linux'], cpu: ['x64'] }),
  }, ...over,
});
const text = (o) => `${JSON.stringify(o, null, 2)}\n`;
const NPM_COMMANDS = ['npm test', 'npm run build'];

// A project whose implementation run produced package.json + package-lock.json + src (React/Vite-like).
async function readyNpm({ pkg = PKG, lock = lockFor(pkg), extraFiles = {}, commands = NPM_COMMANDS, withLock = true } = {}) {
  const root = makeProject({ persistDocs: false });
  const paths = ['package.json', 'package-lock.json', 'src', ...Object.keys(extraFiles)];
  persist(root, { project: projectDoc({ scope: { allowed_paths: ['package.json', 'package-lock.json', 'src', 'test', 'README.md', '.gitignore', ...Object.keys(extraFiles)], prohibited_paths: ['secrets'] }, tasks: [task({ paths, validation_commands: commands }), task({ id: 't-feature', title: 'Add the feature', paths: ['src'], depends_on: ['t-scaffold'], validation_commands: [] })] }) });
  const effect = (cwd) => { write(cwd, 'package.json', typeof pkg === 'string' ? pkg : text(pkg)); if (withLock) write(cwd, 'package-lock.json', typeof lock === 'string' ? lock : text(lock)); write(cwd, 'src/main.jsx', 'export const App = () => null;\n'); for (const [f, c] of Object.entries(extraFiles)) write(cwd, f, c); };
  const files = ['package.json', 'src/main.jsx', ...(withLock ? ['package-lock.json'] : []), ...Object.keys(extraFiles)];
  const r = await impl(root, { runner: implRunner(effect, okResult(files)) });
  assert.equal(r.code, 0, r.out);
  const [run] = runs(root, r.st);
  return { root, st: r.st, run, lock };
}

// Writes ONE tarball into a cache the way npm's cacache does: <cache>/_cacache/content-v2/sha512/aa/bb/<rest> + a sha1-checked index line in
// <cache>/_cacache/index-v5/<sha256(key) 2/2/rest>. layout 'legacy-fake' reproduces the OLD wrong layout (no _cacache) to prove it is rejected;
// 'no-index' writes the real content path but no index metadata.
export function writeCacache(cache, q, body, layout = 'real') {
  const hex = Buffer.from(q.integrity.slice(7), 'base64').toString('hex'); const root = layout === 'legacy-fake' ? cache : join(cache, CACACHE_DIR);
  mkdirSync(join(root, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4)), { recursive: true });
  writeFileSync(join(root, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), body);
  if (layout === 'no-index') return;
  const entry = JSON.stringify({ key: indexKey(q.resolved), integrity: q.integrity, time: 1, size: body.length, metadata: {} });
  const ip = layout === 'legacy-fake' ? join(cache, 'index-v5', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)) : indexPath(cache, indexKey(q.resolved));
  mkdirSync(join(ip, '..'), { recursive: true });
  writeFileSync(ip, `${createHash('sha1').update(entry).digest('hex')}\t${entry}\n`);
}
// Fake provisioner: writes a cacache-shaped private cache for the tarballs the lock requires on `toolchain`.
function provSim({ id = 'sim-npm-provisioner', outcome = () => ({}), skip = () => false, toolchain = TOOL, layout = 'real' } = {}) {
  const r = { id, role: 'provision', calls: [],
    describe: () => ({ id, role: 'provision', kind: 'simulated', shell: false, bypass: false }),
    async run(args) {
      r.calls.push(args);
      const x = (await outcome(args, r.calls.length)) ?? {};
      if (x.status === undefined || x.status === 0) {
        const lock = JSON.parse(readFileSync(join(args.workspace, 'package-lock.json'), 'utf8'));
        for (const q of analyzeLock(lock, JSON.parse(readFileSync(join(args.workspace, 'package.json'), 'utf8')), toolchain).required) {
          if (skip(q)) continue;
          const name = Object.keys(lock.packages).find((k) => lock.packages[k].integrity === q.integrity);
          const body = tarball(`${name.replace(/^.*node_modules\//, '')}@${lock.packages[name].version}`);
          writeCacache(args.cache, q, body, layout);
        }
      }
      return { argv: args.argv, status: 0, signal: null, error: null, stdout: 'added fake packages\n', stderr: '', ...x };
    } };
  return r;
}
// Fake validator: `npm ci --offline` installs from the STAGED cache; anything else is an authorized command.
function valSim({ outcome = () => ({}), installOutcome = () => null } = {}) {
  const seen = { installs: [], staged: [] };
  const v = validationSim((argv, c, n) => {
    if (argv.join(' ') === OFFLINE_INSTALL_COMMAND) {
      seen.installs.push(c); seen.staged.push(existsSync(join(c.cwd, '.dac-validation', 'npm-cache', '_cacache', 'content-v2')));
      const x = installOutcome(argv, c); if (x) return x;
      write(c.cwd, 'node_modules/.package-lock.json', '{}\n'); write(c.cwd, 'node_modules/react/index.js', 'module.exports = {};\n');
      write(c.cwd, 'node_modules/.bin/vite', '#!/bin/sh\n'); return {};
    }
    write(c.cwd, 'dist/index.html', '<html></html>\n'); write(c.cwd, 'coverage/lcov.info', 'x\n'); return outcome(argv, c, n) ?? {};
  });
  v.seen = seen; return v;
}
const throwingTerminal = () => { throw new Error('the trusted terminal must NOT be opened in this scenario'); };
async function rv(root, st, { runner = reviewRunner(), validator = valSim(), prov = provSim(), terminal, openTerminal = noTty, toolchain = TOOL, probe, timeoutMs, clock } = {}) {
  const q = quiet();
  const deps = { reviewRunner: runner, validationRunner: validator, npmProvisioner: prov, npmProbe: probe ?? (() => toolchain), stateDir: st, log: q.log, ...(terminal ? { terminal } : { openTerminal }), ...(timeoutMs ? { confirmTimeoutMs: timeoutMs } : {}), ...(clock ? { clock } : {}) };
  try { const code = await reviewTask({ root, taskId: 't-scaffold', flags: {}, deps }); return { code, out: q.out.join('\n'), runner, validator, prov }; } catch (e) { return { error: e, code: e.code, out: q.out.join('\n'), runner, validator, prov }; }
}
const idDirs = (run) => { const d = join(run.dir, 'npm-provision'); return existsSync(d) ? readdirSync(d).filter((n) => /^[0-9a-f]{64}$/.test(n)).map((n) => join(d, n)) : []; };
const attempts = (idDir) => readdirSync(idDir).filter((n) => n.startsWith('attempt-')).sort();
const rec = (dir) => JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
const vrec = (run, n = 1) => JSON.parse(readFileSync(join(run.dir, 'validation', `attempt-${n}`, 'record.json'), 'utf8'));
const lastReview = (root, st) => runs(root, st)[0].reviews.at(-1);
const treeOf = (dir) => H.snapshot(dir, []);

// ---------------------------------------------------------------------------------------------------------- positive flow
test('React/Vite-like flow: dedicated approval -> provision (network phase only) -> offline npm ci from the staged verified cache -> authorized commands -> reviewer', async () => {
  const { root, st, run } = await readyNpm(); const wt = run.run.worktree.path; const before = treeOf(wt); const rootBefore = treeOf(root);
  const term = tty(true); const rvr = reviewRunner(); const prov = provSim(); const val = valSim();
  const r = await rv(root, st, { runner: rvr, validator: val, prov, terminal: term });
  assert.equal(r.code, 0, r.out);
  // one dedicated approval, bound to the exact identity
  assert.equal(term.calls.length, 1);
  const t = term.calls[0].text; const id = idDirs(run); assert.equal(id.length, 1);
  for (const must of [run.audit.audit_hash, run.audit.result_tree, run.audit.content_hash, H.sha(readFileSync(join(wt, 'package.json'))), H.sha(readFileSync(join(wt, 'package-lock.json'))), 'node v22.11.0', 'npm 10.9.0', 'darwin/arm64', '--ignore-scripts', 'npm test | npm run build', id[0].split('/').pop(), 'NOT be run']) assert.ok(t.includes(must), `approval text must show ${must}`);
  assert.match(term.calls[0].phrase, /^approve [0-9a-f]{12} [0-9a-f]{8}$/);
  // provisioning: exact argv, only package.json + lock in its disposable workspace, private paths
  assert.equal(prov.calls.length, 1); assert.deepEqual(prov.calls[0].argv, PROVISION_ARGV); assert.ok(prov.calls[0].argv.includes('--ignore-scripts'));
  assert.ok(prov.calls[0].cache.startsWith(run.dir) && prov.calls[0].home.startsWith(run.dir) && prov.calls[0].tmp.startsWith(run.dir), 'everything private lives in the run evidence area');
  // validation: offline install first (separate step), then ONLY the authorized commands
  assert.deepEqual(val.calls.map((c) => c.argv.join(' ')), [OFFLINE_INSTALL_COMMAND, 'npm test', 'npm run build']);
  assert.deepEqual(OFFLINE_INSTALL_ARGV, ['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(val.seen.staged, [true], 'the verified cache was staged into the writable private cache of the workspace');
  assert.equal(rvr.calls.length, 1);
  // evidence: provisioning record, approval, manifest; install separate from commands
  const a = join(id[0], 'attempt-1'); const pr = rec(a);
  assert.equal(pr.status, 'PASS'); assert.equal(pr.identity.package_lock_sha256, H.sha(readFileSync(join(wt, 'package-lock.json'))));
  assert.equal(pr.command.exit_code, 0); assert.ok(pr.command.stdout.sha256 && pr.command.stderr.sha256); assert.match(pr.network_phase, /provisioning-only/);
  assert.equal(pr.enforcement.level, 'configured-only', 'a simulated provisioner has CONFIGURATION only, never "verified"');
  const env = JSON.parse(readFileSync(join(a, 'approval.json'), 'utf8')); assert.equal(env.cache_reuse_grant.identity_digest, pr.identity_digest); assert.equal(env.authorization.plan_digest, pr.identity_digest);
  assert.equal(JSON.parse(readFileSync(join(a, 'cache-manifest.json'), 'utf8')).cache_hash, pr.cache_hash);
  assert.equal(readdirSync(a).includes('workspace'), false, 'provisioning workspace removed after recording');
  const v = vrec(run); assert.equal(v.overall, 'PASS'); assert.equal(v.commands.length, 2, 'install is NOT counted among the authorized commands');
  assert.deepEqual(v.authorized_commands, NPM_COMMANDS);
  assert.equal(v.npm.install.exit_code, 0); assert.equal(v.npm.install.binding_before, 'equal'); assert.equal(v.npm.install.binding_after, 'equal');
  assert.equal(v.npm.install.cache_identity.cache_hash, pr.cache_hash); assert.equal(v.npm.install.cache_identity.staged_cache_hash, pr.cache_hash);
  assert.ok(v.npm.install.stdout.sha256 && v.npm.install.workspace_outputs.counts.generated > 0);
  assert.match(v.npm.enforcement_note, /CONFIGURATION/);
  // node_modules/cache/dist are validation byproducts only: nothing leaked into the audited worktree, the project or the diff
  assert.deepEqual(treeOf(wt), before); assert.deepEqual(treeOf(root), rootBefore);
  for (const n of ['node_modules', 'dist', 'coverage', '.dac-validation']) assert.equal(existsSync(join(wt, n)), false);
  const out = JSON.parse(readFileSync(v.workspace_outputs.file, 'utf8')); assert.ok(out.generated.some((e) => e.path === 'node_modules/react/index.js'));
  assert.equal(lastReview(root, st).verdict, 'PASS');
  assert.ok(rvr.calls[0].prompt.includes('npm ci --offline --ignore-scripts') &&rvr.calls[0].prompt.includes(pr.cache_hash), 'the reviewer sees the npm evidence');
});

test('without npm dependencies (or without an npm validation command) the current semantics apply: no probe, no terminal, no provisioner', async () => {
  for (const [pkg, commands] of [[{ name: 'demo' }, ['npm test']], [PKG, ['node --test']]]) {
    const { root, st } = await readyNpm({ pkg, lock: lockFor(PKG), withLock: false, commands });
    const prov = provSim(); const r = await rv(root, st, { prov, openTerminal: throwingTerminal, probe: () => { throw new Error('the toolchain must not be probed'); } });
    assert.equal(r.code, 0, r.out); assert.equal(prov.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------------------------------------- approval
test('no trusted terminal: BLOCKED, nothing downloaded, validator and reviewer never run, attempt recorded', async () => {
  const { root, st, run } = await readyNpm(); const rvr = reviewRunner(); const val = valSim(); const prov = provSim();
  const r = await rv(root, st, { runner: rvr, validator: val, prov });
  assert.equal(r.code, 1); assert.equal(prov.calls.length, 0); assert.equal(val.calls.length, 0); assert.equal(rvr.calls.length, 0);
  assert.match(r.out, /trusted interactive terminal is required/);
  const [id] = idDirs(run); assert.equal(rec(join(id, 'attempt-1')).status, 'NO_TTY'); assert.equal(rec(join(id, 'attempt-1')).network_phase, 'not-started');
  assert.equal(lastReview(root, st).verdict, 'BLOCKED'); assert.equal(lastReview(root, st).reviewer_invoked, false);
  assert.equal(vrec(run).overall, 'BLOCKED');
});

test('cancellation and timeout on the trusted terminal block; evidence of each numbered attempt is preserved and never overwritten', async () => {
  const { root, st, run } = await readyNpm(); const prov = provSim();
  const denied = await rv(root, st, { prov, terminal: tty(false) }); assert.equal(denied.code, 1);
  const timeout = await rv(root, st, { prov, terminal: { confirm() { throw Object.assign(new Error('late'), { code: 'APPROVAL_TIMEOUT' }); } } }); assert.equal(timeout.code, 1);
  const [id] = idDirs(run); assert.deepEqual(attempts(id), ['attempt-1', 'attempt-2']);
  assert.equal(rec(join(id, 'attempt-1')).status, 'APPROVAL_DENIED'); assert.equal(rec(join(id, 'attempt-2')).status, 'APPROVAL_TIMEOUT');
  assert.equal(prov.calls.length, 0); assert.equal(existsSync(join(id, 'attempt-1', 'cache')), false);
  // approval can never come from the environment, stdin or a flag: the prompt is the only door (ask again -> asked again)
  const term = tty(true); const ok = await rv(root, st, { prov, terminal: term }); assert.equal(ok.code, 0, ok.out); assert.equal(term.calls.length, 1);
  assert.equal(rec(join(id, 'attempt-1')).status, 'APPROVAL_DENIED', 'earlier evidence untouched');
});

test('an approval of a different identity cannot be used: drift while the human was reading blocks before any download', async () => {
  const { root, st, run } = await readyNpm(); const wt = run.run.worktree.path; const prov = provSim(); const val = valSim();
  const term = { calls: [], confirm() { write(wt, 'package.json', text({ ...PKG, version: '9.9.9' })); return true; } };
  const r = await rv(root, st, { prov, validator: val, terminal: term });
  assert.equal(r.code, 1); assert.equal(prov.calls.length, 0); assert.equal(val.calls.length, 0);
  const [id] = idDirs(run); assert.equal(rec(join(id, 'attempt-1')).status, 'DRIFT'); assert.equal(existsSync(join(id, 'attempt-1', 'approval.json')), false, 'a stale approval is never recorded');
});

// ---------------------------------------------------------------------------------------------------------- reuse / identity
test('exact-identity cache reuse needs NO new approval and no network; a changed identity requires a new approval', async () => {
  const { root, st, run } = await readyNpm(); const prov = provSim();
  assert.equal((await rv(root, st, { prov, terminal: tty(true) })).code, 0); assert.equal(prov.calls.length, 1);
  const [id1] = idDirs(run); const approval = readFileSync(join(id1, 'attempt-1', 'approval.json'), 'utf8');
  const val = valSim(); const again = await rv(root, st, { prov, validator: val, openTerminal: throwingTerminal });
  assert.equal(again.code, 0, again.out); assert.equal(prov.calls.length, 1, 'no second download'); assert.match(again.out, /reusing the verified private cache/);
  assert.deepEqual(val.seen.staged, [true]); assert.equal(vrec(run, 2).npm.cache.reused, true); assert.equal(vrec(run, 2).npm.cache.cache_hash, rec(join(id1, 'attempt-1')).cache_hash);
  assert.equal(readFileSync(join(id1, 'attempt-1', 'approval.json'), 'utf8'), approval, 'approval record is write-once');
  // changed Node/npm/platform => different identity => a NEW trusted-terminal approval (and no reuse of the other cache)
  for (const change of [{ node: 'v22.12.0' }, { npm: '10.9.1' }, { platform: 'linux', arch: 'x64', libc: 'glibc' }, { arch: 'x64' }]) {
    const tc = { ...TOOL, ...change }; const p2 = provSim({ toolchain: tc });
    const blocked = await rv(root, st, { prov: p2, toolchain: tc });
    assert.equal(blocked.code, 1, JSON.stringify(change)); assert.equal(p2.calls.length, 0); assert.match(blocked.out, /trusted interactive terminal is required/);
    const term = tty(true); const approved = await rv(root, st, { prov: p2, toolchain: tc, terminal: term });
    assert.equal(approved.code, 0, approved.out); assert.equal(term.calls.length, 1); assert.equal(p2.calls.length, 1);
  }
  assert.equal(idDirs(run).length, 5, 'one cache identity per toolchain');
});

test('a cache directory planted under another identity (directory names are not trusted) is rejected', async () => {
  const { root, st, run } = await readyNpm(); const prov = provSim();
  assert.equal((await rv(root, st, { prov, terminal: tty(true) })).code, 0);
  const [a] = idDirs(run); const tc = { ...TOOL, node: 'v20.0.0' };
  assert.equal((await rv(root, st, { prov, toolchain: tc })).code, 1); // creates the identity directory for the new toolchain
  const b = idDirs(run).find((d) => d !== a); rmSync(b, { recursive: true, force: true }); cpSync(a, b, { recursive: true });
  const r = await rv(root, st, { prov, toolchain: tc, openTerminal: throwingTerminal });
  assert.equal(r.code, 1); assert.match(r.out, /does not match its directory|different identity/); assert.equal(prov.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------------------- tampering
async function provisioned() { const x = await readyNpm(); const prov = provSim(); assert.equal((await rv(x.root, x.st, { prov, terminal: tty(true) })).code, 0); const [id] = idDirs(x.run); return { ...x, prov, id, a: join(id, 'attempt-1') }; }
const editEnvelope = (a, edit) => { const p = JSON.parse(readFileSync(join(a, 'approval.json'), 'utf8')); edit(p); const { record_digest, ...e } = p; writeFileSync(join(a, 'approval.json'), JSON.stringify({ ...e, record_digest: digestOf({ kind: e.kind, schema: e.schema, channel: e.channel, authorization: e.authorization, cache_reuse_grant: e.cache_reuse_grant }) })); };
const tamper = {
  'cache file modified': (a) => { const f = cacheManifest(join(a, 'cache')).entries.find((e) => e.type === 'file' && e.path.startsWith('_cacache/content-v2')); writeFileSync(join(a, 'cache', f.path), 'evil'); },
  'cache file deleted (incomplete)': (a) => { const f = cacheManifest(join(a, 'cache')).entries.find((e) => e.type === 'file' && e.path.startsWith('_cacache/content-v2')); rmSync(join(a, 'cache', f.path)); },
  'cache file added': (a) => writeFileSync(join(a, 'cache', 'extra.bin'), 'x'),
  'symlink planted in the cache': (a) => symlinkSync('/etc/hosts', join(a, 'cache', 'link')),
  'cache directory removed': (a) => rmSync(join(a, 'cache'), { recursive: true, force: true }),
  'manifest edited consistently with the cache (record hash no longer matches)': (a) => { writeFileSync(join(a, 'cache', 'extra.bin'), 'x'); const m = JSON.parse(readFileSync(join(a, 'cache-manifest.json'), 'utf8')); const n = cacheManifest(join(a, 'cache')); m.entries = n.entries; m.cache_hash = n.hash; writeFileSync(join(a, 'cache-manifest.json'), JSON.stringify(m)); },
  'approval record edited': (a) => { const p = JSON.parse(readFileSync(join(a, 'approval.json'), 'utf8')); p.cache_reuse_grant.identity_digest = 'f'.repeat(64); writeFileSync(join(a, 'approval.json'), JSON.stringify(p)); },
  'reuse grant widened (re-provisioning) without re-digesting': (a) => { const p = JSON.parse(readFileSync(join(a, 'approval.json'), 'utf8')); p.cache_reuse_grant.allows_reprovisioning = true; writeFileSync(join(a, 'approval.json'), JSON.stringify(p)); },
  'reuse grant widened (network) and envelope re-digested': (a) => editEnvelope(a, (p) => { p.cache_reuse_grant.allows_network = true; }),
  'authorization lifetime extended and envelope re-digested (TTL is not exactly 600 s)': (a) => editEnvelope(a, (p) => { p.authorization.expires_at = new Date(Date.parse(p.authorization.expires_at) + 86400000).toISOString(); }),
  'authorization rebound to another operation and re-digested': (a) => editEnvelope(a, (p) => { p.authorization.operation = 'apply'; }),
  'extra field added to the envelope and re-digested': (a) => editEnvelope(a, (p) => { p.extra = 1; }),
  'cache index metadata removed (npm ci --offline could not find it)': (a) => { rmSync(join(a, 'cache', '_cacache', 'index-v5'), { recursive: true, force: true }); },
  'approval removed': (a) => rmSync(join(a, 'approval.json')),
  'record identity edited': (a) => { const p = rec(a); p.identity_digest = 'e'.repeat(64); writeFileSync(join(a, 'record.json'), JSON.stringify(p)); },
};
for (const [name, mutate] of Object.entries(tamper)) {
  test(`tampering blocks and is never silently repaired: ${name}`, async () => {
    const { root, st, run, prov, a } = await provisioned(); mutate(a);
    const val = valSim(); const rvr = reviewRunner();
    const r = await rv(root, st, { prov, validator: val, runner: rvr, openTerminal: throwingTerminal });
    assert.equal(r.code, 1, r.out); assert.match(r.out, /cannot be reused/); assert.equal(prov.calls.length, 1, 'no re-provisioning'); assert.equal(val.calls.length, 0); assert.equal(rvr.calls.length, 0);
    assert.equal(lastReview(root, st).verdict, 'BLOCKED'); assert.equal(vrec(run, 2).overall, 'BLOCKED');
  });
}

// ---------------------------------------------------------------------------------------------------------- download / incomplete / drift
test('download failure blocks; evidence (record, stdout/stderr hashes, cleanup) is preserved; the cache is never reusable; retry is a new numbered attempt needing new approval', async () => {
  const { root, st, run } = await readyNpm(); const failing = provSim({ outcome: () => ({ status: 1, stdout: 'x\n', stderr: 'npm error code ENOTFOUND\n' }) });
  const val = valSim(); const rvr = reviewRunner();
  const r = await rv(root, st, { prov: failing, validator: val, runner: rvr, terminal: tty(true) });
  assert.equal(r.code, 1); assert.equal(val.calls.length, 0); assert.equal(rvr.calls.length, 0); assert.match(r.out, /provisioning failed/);
  const [id] = idDirs(run); const a1 = join(id, 'attempt-1'); const p = rec(a1);
  assert.equal(p.status, 'DOWNLOAD_FAILED'); assert.equal(p.command.exit_code, 1); assert.ok(readFileSync(join(a1, 'provision.stderr.txt'), 'utf8').includes('ENOTFOUND'));
  assert.equal(p.command.stderr.sha256, H.sha(readFileSync(join(a1, 'provision.stderr.txt'))));
  assert.ok(existsSync(join(a1, 'cleanup.json')) && existsSync(join(a1, 'approval.json')) && !existsSync(join(a1, 'cache-manifest.json')));
  const frozen = treeOf(a1);
  const retry = await rv(root, st, { prov: provSim(), openTerminal: throwingTerminal });
  assert.equal(retry.code, 1, 'a failed attempt never authorizes reuse'); assert.match(retry.out, /trusted interactive terminal is required/);
  assert.deepEqual(treeOf(a1), frozen, 'earlier evidence byte-identical'); assert.deepEqual(attempts(id), ['attempt-1', 'attempt-2']);
  const ok = await rv(root, st, { prov: provSim(), terminal: tty(true) }); assert.equal(ok.code, 0, ok.out); assert.equal(rec(join(id, 'attempt-3')).status, 'PASS');
  // a runner that throws is a failure too
  const { root: r2, st: s2, run: run2 } = await readyNpm(); const t = await rv(r2, s2, { prov: provSim({ outcome: () => { throw new Error('network unreachable'); } }), terminal: tty(true) });
  assert.equal(t.code, 1); assert.equal(rec(join(idDirs(run2)[0], 'attempt-1')).status, 'DOWNLOAD_FAILED');
});

test('incomplete cache (tarball missing although npm "succeeded") blocks before validation', async () => {
  const { root, st, run } = await readyNpm(); const val = valSim();
  const r = await rv(root, st, { prov: provSim({ skip: (q) => q.path.endsWith('react-dom') }), validator: val, terminal: tty(true) });
  assert.equal(r.code, 1); assert.equal(val.calls.length, 0); assert.match(r.out, /incomplete|missing cached tarball/);
  const [id] = idDirs(run); assert.equal(rec(join(id, 'attempt-1')).status, 'CACHE_INCOMPLETE'); assert.equal(existsSync(join(id, 'attempt-1', 'cache-manifest.json')), false);
  // a tarball whose bytes do not match the lock integrity is rejected too (the content is verified, not the name)
  const { root: r2, st: s2 } = await readyNpm(); const evil = provSim({ outcome: () => ({}) });
  const origRun = evil.run.bind(evil); evil.run = async (args) => { const x = await origRun(args); for (const f of cacheManifest(args.cache).entries.filter((e) => e.type === 'file' && e.path.startsWith('_cacache/content-v2'))) writeFileSync(join(args.cache, f.path), 'wrong bytes'); return x; };
  const r3 = await rv(r2, s2, { prov: evil, terminal: tty(true) }); assert.equal(r3.code, 1); assert.match(r3.out, /does not match the lockfile integrity/);
});

test('provisioning that writes into the audited worktree or the project is detected as drift: no cache is accepted', async () => {
  for (const where of ['worktree', 'project']) {
    const { root, st, run } = await readyNpm(); const target = where === 'worktree' ? run.run.worktree.path : root;
    const r = await rv(root, st, { prov: provSim({ outcome: () => { write(target, 'leak.txt', 'x\n'); } }), terminal: tty(true) });
    assert.equal(r.code, 1, where); assert.match(r.out, /state drift after provisioning/);
    assert.equal(rec(join(idDirs(run)[0], 'attempt-1')).status, 'DRIFT'); assert.equal(existsSync(join(idDirs(run)[0], 'attempt-1', 'cache-manifest.json')), false);
  }
});

test('provisioning that modifies package.json/package-lock.json in its workspace is rejected', async () => {
  const { root, st, run } = await readyNpm();
  const r = await rv(root, st, { prov: provSim({ outcome: (a) => { writeFileSync(join(a.workspace, 'package-lock.json'), '{"lockfileVersion":3}\n'); return { status: 0 }; } }), terminal: tty(true) });
  assert.equal(r.code, 1); assert.equal(rec(join(idDirs(run)[0], 'attempt-1')).status, 'LOCK_CHANGED');
});

// ---------------------------------------------------------------------------------------------------------- offline validation failures
test('install scripts stay disabled: both npm invocations carry --ignore-scripts; a package that needs a script fails the offline install and blocks', async () => {
  const { root, st, run } = await readyNpm(); const prov = provSim();
  const val = valSim({ installOutcome: () => ({ status: 1, stderr: 'Error: esbuild binary missing (postinstall did not run: --ignore-scripts)\n' }) });
  const rvr = reviewRunner(); const r = await rv(root, st, { prov, validator: val, runner: rvr, terminal: tty(true) });
  assert.equal(r.code, 1); assert.equal(rvr.calls.length, 0); assert.equal(val.calls.length, 1, 'authorized commands are not run after a failed install');
  for (const argv of [prov.calls[0].argv, val.calls[0].argv]) assert.ok(argv.includes('--ignore-scripts'));
  const v = vrec(run); assert.equal(v.npm.install.exit_code, 1); assert.equal(v.complete, false); assert.equal(v.commands.length, 0); assert.equal(v.commands_not_run, 2); assert.match(v.reasons.join(), /install scripts, which never run/);
  const id = rec(join(idDirs(run)[0], 'attempt-1')).identity.lock_summary; assert.deepEqual(id.install_script_packages, [{ path: 'node_modules/esbuild', version: '0.21.5' }]); assert.match(id.install_scripts_note, /NEVER run/);
  assert.ok(existsSync(join(run.dir, 'validation', 'attempt-1', 'install.stderr.txt')));
});

test('validation commands cannot install, rebuild or reconfigure npm', () => {
  for (const c of ['npm install', 'npm i', 'npm ci', 'npm rebuild', 'npm update', 'npm exec vite', 'npm config set registry x', 'npm publish', 'npm test --ignore-scripts=false', 'npm run build --registry=https://evil', 'npm run', 'npm']) assert.ok(npmCommandProblem(c.split(' ')), c);
  for (const c of ['npm test', 'npm t', 'npm run build', 'npm run-script lint', 'npm test -- --watch=false', 'npm run build -- --mode production']) assert.equal(npmCommandProblem(c.split(' ')), null, c);
});

test('network attempted during validation: the offline install fails (ENOTCACHED), is recorded and blocks; the audited worktree is untouched', async () => {
  const { root, st, run } = await readyNpm(); const wt = run.run.worktree.path; const before = treeOf(wt);
  const val = valSim({ installOutcome: () => ({ status: 1, stderr: 'npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/react failed: cache mode is only-if-cached\n' }) });
  const r = await rv(root, st, { validator: val, prov: provSim(), terminal: tty(true) });
  assert.equal(r.code, 1); assert.match(r.out, /offline npm install failed/); assert.deepEqual(treeOf(wt), before);
  const ie = vrec(run).npm.install.stderr; assert.ok(readFileSync(ie.file, 'utf8').includes('ENOTCACHED')); assert.equal(ie.sha256, H.sha(readFileSync(ie.file)));
});

test('a validator that writes into the audited worktree during the offline install (write outside the workspace) blocks as drift', async () => {
  const { root, st, run } = await readyNpm(); const wt = run.run.worktree.path; const rvr = reviewRunner();
  const val = valSim({ installOutcome: (a, c) => { write(wt, 'node_modules/leak.js', 'x\n'); write(c.cwd, 'node_modules/.package-lock.json', '{}\n'); return {}; } });
  const r = await rv(root, st, { validator: val, runner: rvr, prov: provSim(), terminal: tty(true) });
  assert.equal(r.code, 1); assert.equal(rvr.calls.length, 0); assert.match(r.out, /state drift after the offline npm install/); assert.equal(vrec(run).npm.install.binding_after, 'not-verified-equal'); assert.ok(existsSync(join(wt, 'node_modules', 'leak.js')), 'dac never repairs the worktree');
});

test('an install that alters package.json/lock in the workspace, or produces no node_modules, blocks', async () => {
  for (const [io, re] of [[(a, c) => { write(c.cwd, 'node_modules/.package-lock.json', '{}\n'); write(c.cwd, 'package-lock.json', '{}\n'); return {}; }, /changed package\.json or package-lock\.json/], [() => ({}), /no node_modules/]]) {
    const { root, st } = await readyNpm(); const r = await rv(root, st, { validator: valSim({ installOutcome: io }), prov: provSim(), terminal: tty(true) });
    assert.equal(r.code, 1); assert.match(r.out, re);
  }
});

test('evidence of a blocked validation survives: provisioning attempt, validation attempt and review record are all present and the next attempt adds new numbered ones', async () => {
  const { root, st, run } = await readyNpm(); const prov = provSim();
  await rv(root, st, { prov, validator: valSim({ installOutcome: () => ({ status: 1 }) }), terminal: tty(true) });
  const a = join(idDirs(run)[0], 'attempt-1'); const v1 = treeOf(join(run.dir, 'validation', 'attempt-1')); const p1 = treeOf(a);
  assert.equal(lastReview(root, st).verdict, 'BLOCKED');
  const r = await rv(root, st, { prov, openTerminal: throwingTerminal }); assert.equal(r.code, 0, r.out);
  assert.equal(prov.calls.length, 1, 'the cache of the failed VALIDATION is still verified and reused (provisioning had passed)');
  assert.deepEqual(treeOf(join(run.dir, 'validation', 'attempt-1')), v1); assert.deepEqual(treeOf(a), p1);
  assert.equal(vrec(run, 2).overall, 'PASS'); assert.equal(runs(root, st)[0].reviews.length, 2);
});

// ---------------------------------------------------------------------------------------------------------- strict detection (pure)
const files = (pkg = PKG, lock = lockFor(PKG), o = {}) => ({ pkg: pkg === null ? null : Buffer.from(typeof pkg === 'string' ? pkg : text(pkg)), lock: lock === null ? null : Buffer.from(typeof lock === 'string' ? lock : text(lock)), npmrc: [], shrinkwrap: false, ...o });
const AUDIT = { audit_hash: 'a'.repeat(64), content_hash: 'b'.repeat(64), result_tree: 'c'.repeat(40) }; const RUN = { base_commit: 'd'.repeat(40) };
const plan = (f, cmds = ['npm test'], tool = TOOL) => planNpm({ files: f, argvs: cmds.map((c) => c.split(' ')), audit: AUDIT, run: RUN, toolchain: tool });
const lockWith = (mut) => { const l = lockFor(PKG); mut(l); return l; };

test('detection is strict and fails closed; non-npm projects are not applicable', () => {
  assert.equal(plan(files()).ok, true);
  assert.equal(plan(files({ name: 'x' }, null)).applicable, false, 'no dependencies and no lock: legacy');
  assert.equal(plan(files(), ['node --test']).applicable, false, 'no npm validation command: legacy');
  assert.equal(plan(files(null, null)).applicable, false);
  const bad = (f, re, cmds) => { const p = plan(f, cmds); assert.equal(p.ok, false, re); assert.match(p.reasons.join('\n'), re); };
  bad(files(PKG, null), /package-lock\.json is missing/);
  bad(files(null, lockFor()), /package\.json is missing/);
  bad(files('{not json'), /not valid JSON/);
  bad(files(PKG, '{nope'), /package-lock\.json is not valid JSON/);
  bad(files(PKG, lockWith((l) => { l.lockfileVersion = 2; })), /lockfileVersion 2 is not supported/);
  bad(files(PKG, lockWith((l) => { l.lockfileVersion = 1; })), /not supported/);
  bad(files(PKG, lockWith((l) => { l.packages[''].dependencies = { react: '^17.0.0' }; })), /disagree on dependencies/);
  bad(files({ ...PKG, devDependencies: { vite: '^6.0.0' } }), /disagree on devDependencies/);
  bad(files({ ...PKG, name: 'other' }), /disagree on the package name/);
  bad(files(PKG, lockWith((l) => { delete l.packages['']; })), /no "packages" map/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].link = true; })), /link\/local/);
  bad(files(PKG, lockWith((l) => { l.packages['../local'] = { version: '1.0.0' }; })), /local\/workspace path/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].resolved = 'file:../react'; })), /credential-free https/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].resolved = 'git+ssh://git@github.com/facebook/react.git#abc'; })), /credential-free https/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].resolved = 'http://registry.npmjs.org/react/-/react-18.3.1.tgz'; })), /credential-free https/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].resolved = 'https://user:pw@registry.npmjs.org/react/-/react-18.3.1.tgz'; })), /credential-free https/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].resolved = 'https://evil.example/react-18.3.1.tgz'; })), /registry host evil\.example/);
  bad(files(PKG, lockWith((l) => { delete l.packages['node_modules/react'].resolved; })), /no resolved tarball URL/);
  bad(files(PKG, lockWith((l) => { delete l.packages['node_modules/react'].integrity; })), /no sha512 integrity/);
  bad(files(PKG, lockWith((l) => { l.packages['node_modules/react'].integrity = 'sha1-abc='; })), /no sha512 integrity/);
  for (const spec of ['file:../x', 'link:../x', 'git+https://github.com/a/b.git', 'github:a/b', 'a/b', 'https://x.example/x.tgz', 'workspace:*', 'npm:other@1', '../x']) {
    const pkg = { ...PKG, dependencies: { ...PKG.dependencies, evil: spec } }; bad(files(pkg, lockFor(pkg)), /unsupported source/);
  }
  bad(files({ ...PKG, workspaces: ['packages/*'] }, lockFor({ ...PKG, workspaces: ['packages/*'] })), /workspaces/);
  bad(files(PKG, lockFor(), { npmrc: ['.npmrc'] }), /\.npmrc is present/);
  bad(files(PKG, lockFor(), { npmrc: ['packages/a/.npmrc'] }), /packages\/a\/\.npmrc/);
  bad(files(PKG, lockFor(), { shrinkwrap: true }), /npm-shrinkwrap/);
  bad(files(), /not an allowed validation command/, ['npm install']);
  assert.match(plan(files(), ['npm test'], {}).reasons.join(), /toolchain could not be determined/);
});

test('platform-specific optional packages are accounted for accurately and bind the identity to platform/arch', () => {
  const darwin = plan(files()); const linux = plan(files(), ['npm test'], { ...TOOL, platform: 'linux', arch: 'x64', libc: 'glibc' });
  const names = (p) => p.required.map((q) => q.path).sort();
  assert.ok(names(darwin).includes('node_modules/@esbuild/darwin-arm64') && !names(darwin).includes('node_modules/@esbuild/linux-x64'));
  assert.ok(names(linux).includes('node_modules/@esbuild/linux-x64') && !names(linux).includes('node_modules/@esbuild/darwin-arm64'));
  assert.notEqual(darwin.identity_digest, linux.identity_digest);
  assert.equal(darwin.identity.lock_summary.optional_platform_skipped, 1);
  const only = lockWith((l) => { l.packages['node_modules/@esbuild/darwin-arm64'].optional = false; }); // NOT optional: always required
  assert.ok(plan(files(PKG, only), ['npm test'], { ...TOOL, platform: 'linux', arch: 'x64' }).required.some((q) => q.path.endsWith('darwin-arm64')));
  // identity changes with any bound input
  const base = plan(files()).identity_digest;
  assert.notEqual(base, plan(files(), ['npm test', 'npm run build']).identity_digest);
  assert.notEqual(base, plan(files(), ['npm test'], { ...TOOL, npm: '10.9.1' }).identity_digest);
  assert.notEqual(base, planNpm({ files: files(), argvs: [['npm', 'test']], audit: { ...AUDIT, content_hash: 'e'.repeat(64) }, run: RUN, toolchain: TOOL }).identity_digest);
  assert.equal(base, plan(files()).identity_digest, 'deterministic');
});

test('integration: an npm project without package-lock.json / with an unsupported source blocks before any approval, download or copy', async () => {
  for (const [opts, re] of [[{ withLock: false }, /package-lock\.json is missing/], [{ extraFiles: { '.npmrc': 'registry=https://evil.example/\n' } }, /\.npmrc is present/], [{ pkg: { ...PKG, dependencies: { ...PKG.dependencies, evil: 'file:../evil' } } }, /unsupported (source|spec)|disagree|unsupported source/]]) {
    let x; try { x = await readyNpm(opts); } catch { continue; }
    const prov = provSim(); const val = valSim(); const r = await rv(x.root, x.st, { prov, validator: val, openTerminal: throwingTerminal });
    assert.equal(r.code, 1, JSON.stringify(Object.keys(opts))); assert.match(r.out, re); assert.equal(prov.calls.length, 0); assert.equal(val.calls.length, 0); assert.equal(existsSync(join(x.run.dir, 'npm-provision')), false);
    assert.equal(lastReview(x.root, x.st).reviewer_invoked, false);
  }
});

test('Linux (no equivalent isolator) stays BLOCKED for npm projects: probe/provision refuse, never a direct spawn', async () => {
  const lin = provisionerRunner({ platform: 'linux', spawn: () => { throw new Error('must never spawn'); } });
  assert.throws(() => lin.probe(), /no supported isolator/); assert.throws(() => lin.run({ argv: ['npm'], workspace: '/', cache: '/', home: '/', tmp: '/' }), /no supported isolator/);
  assert.throws(() => provisionerRunner({ platform: 'darwin', sandboxAvailable: () => false }).probe(), /missing or unusable/);
  const { root, st } = await readyNpm(); const r = await rv(root, st, { prov: lin, probe: () => lin.probe(), openTerminal: throwingTerminal, validator: valSim() });
  assert.equal(r.code, 1); assert.match(r.out, /no supported isolator/);
});

test('the provisioner is a separate identity and profile is validated; the profile only allows writes to workspace and cache', () => {
  assert.throws(() => assertSafeProvisionerProfile(provSim({ id: 'sim-validate' }), 'sim-implement', 'sim-review', 'sim-validate'), /different identity/);
  assert.throws(() => assertSafeProvisionerProfile({ id: 'x', role: 'validate', run() {}, describe: () => ({ id: 'x', role: 'validate', shell: false, bypass: false }) }), /role "provision"/);
  assert.throws(() => assertSafeProvisionerProfile({ id: 'x', role: 'provision', run() {}, describe: () => ({ id: 'x', role: 'provision', shell: true, bypass: false }) }), /shell and bypass/);
  assert.match(PROVISION_PROFILE, /\(deny file-write\*\)/); assert.equal((PROVISION_PROFILE.match(/allow file-write\*/g) ?? []).length, 1);
  assert.doesNotMatch(PROVISION_PROFILE, /deny network/, 'network is enabled only in the provisioner profile (validation keeps its own network-deny profile)');
  const d = provisionerRunner().describe(); assert.equal(d.role, 'provision'); assert.match(d.network, /this phase only/); assert.match(d.env, /NODE_OPTIONS/);
});

test('cache inventory is strict and coverage checks every required tarball against the lockfile integrity; staging proves a byte-identical copy', () => {
  const dir = H.fresh('cache'); const p = plan(files()); const req = p.required;
  assert.ok(cacheCoverage(dir, req).length, 'an empty cache is incomplete');
  const w = provSim(); return w.run({ argv: PROVISION_ARGV, workspace: (() => { const d = H.fresh('ws'); writeFileSync(join(d, 'package.json'), text(PKG)); writeFileSync(join(d, 'package-lock.json'), text(lockFor())); return d; })(), cache: dir }).then(() => {
    assert.deepEqual(cacheCoverage(dir, req), []); const m = cacheManifest(dir); assert.deepEqual(m.problems, []);
    const dst = join(H.fresh('stage'), 'c'); const s = stageCache(dir, dst, m.hash); assert.equal(s.hash, m.hash);
    assert.throws(() => stageCache(dir, join(H.fresh('stage'), 'c'), 'f'.repeat(64)), /changed before staging/);
    symlinkSync('/etc/hosts', join(dir, 'link')); assert.ok(cacheManifest(dir).problems.some((x) => /symlink/.test(x)));
  });
});

test('runIndependentValidation without an `npm` option keeps the exact legacy behaviour (install step never added)', async () => {
  const { run } = await readyNpm(); const authz = JSON.parse(readFileSync(join(run.dir, 'authorization.json'), 'utf8')); const v = valSim();
  const res = await runIndependentValidation({ root: '/unused', run: run.run, contract: { validation_commands: authz.validation_commands }, audit: run.audit, runDir: run.dir, runner: v, clock: Date.now, checkBinding: () => [] });
  assert.equal(res.ok, true); assert.deepEqual(v.calls.map((c) => c.argv.join(' ')), NPM_COMMANDS); assert.equal(res.record.npm, undefined);
});

// ---------------------------------------------------------------------------------------------------------- real npm cache layout
test('REAL cacache layout: content under <cache>/_cacache/content-v2 + index metadata under <cache>/_cacache/index-v5; the old fake layout is rejected', () => {
  const req = plan(files()).required; assert.ok(req.length > 3 && req.every((q) => q.resolved));
  const mk = (layout) => { const d = H.fresh(`cache-${layout}`); for (const q of req) writeCacache(d, q, tarball(`${q.path.replace(/^.*node_modules\//, '')}@${lockFor().packages[q.path].version}`), layout); return d; };
  const real = mk('real'); assert.deepEqual(cacheCoverage(real, req), []);
  assert.ok(existsSync(join(real, '_cacache', 'content-v2')) && existsSync(join(real, '_cacache', 'index-v5')));
  assert.equal(existsSync(join(real, 'content-v2')), false); assert.equal(existsSync(join(real, 'index-v5')), false);
  // old (wrong) layout: content-v2/index-v5 directly under npm_config_cache
  const legacy = mk('legacy-fake'); assert.ok(existsSync(join(legacy, 'content-v2')) && !existsSync(join(legacy, '_cacache')));
  assert.match(cacheCoverage(legacy, req).join('\n'), /no _cacache\/index-v5 and _cacache\/content-v2/); assert.match(cacheCoverage(legacy, req).join('\n'), /missing cached tarball/);
  // real content path but NO index metadata => npm ci --offline cannot resolve it => incomplete
  const noIndex = mk('no-index'); assert.match(cacheCoverage(noIndex, req).join('\n'), /missing cache index metadata/);
  // index line with a wrong key, wrong integrity or a broken sha1 is not metadata npm would accept
  const q = req[0]; const ip = indexPath(real, indexKey(q.resolved)); const good = readFileSync(ip, 'utf8');
  for (const bad of [good.replace(indexKey(q.resolved), 'make-fetch-happen:request-cache:https://other.example/x.tgz'), good.replace(q.integrity, `sha512-${'A'.repeat(86)}==`), `${'0'.repeat(40)}\t${good.split('\t')[1]}`, '']) {
    writeFileSync(ip, bad); assert.match(cacheCoverage(real, [q]).join('\n'), /missing cache index metadata/);
  }
});

test('integration: a provisioner that produces the old fake layout (or no index metadata) is CACHE_INCOMPLETE and validation never runs', async () => {
  for (const layout of ['legacy-fake', 'no-index']) {
    const { root, st, run } = await readyNpm(); const val = valSim();
    const r = await rv(root, st, { prov: provSim({ layout }), validator: val, terminal: tty(true) });
    assert.equal(r.code, 1, layout); assert.equal(val.calls.length, 0); assert.match(r.out, /incomplete|missing cached tarball|missing cache index/);
    assert.equal(rec(join(idDirs(run)[0], 'attempt-1')).status, 'CACHE_INCOMPLETE');
  }
  const { root, st, run } = await readyNpm(); const val = valSim();
  assert.equal((await rv(root, st, { prov: provSim(), validator: val, terminal: tty(true) })).code, 0);
  const c = join(idDirs(run)[0], 'attempt-1', 'cache'); assert.ok(existsSync(join(c, '_cacache', 'content-v2')) && existsSync(join(c, '_cacache', 'index-v5')) && !existsSync(join(c, 'content-v2')));
});

// ---------------------------------------------------------------------------------------------------------- canonical authorization (TTL, binding, reuse grant)
const mutClock = (t0 = Date.now()) => { const c = { now: t0, fn: () => c.now }; return c; };
const planOfRec = (a) => { const r = rec(a); return { identity: r.identity, identity_digest: r.identity_digest }; };
const envOf = (a) => JSON.parse(readFileSync(join(a, 'approval.json'), 'utf8'));

test('canonical authorization: exact Writer shape, issued_at + exactly 600 s, bound to the exact plan; the envelope carries it UNCHANGED with an explicit reuse grant', async () => {
  const { mintAuthorization, checkAuthorization, TTL_SECONDS } = await import('../adapters/shared/sdd-writer/authorization.mjs');
  const c = mutClock(); const { root, st, run } = await readyNpm(); const term = tty(true);
  assert.equal((await rv(root, st, { terminal: term, clock: c.fn })).code, 0);
  const a = join(idDirs(run)[0], 'attempt-1'); const env = envOf(a); const pl = planOfRec(a);
  assert.deepEqual(Object.keys(env).sort(), ['authorization', 'cache_reuse_grant', 'channel', 'kind', 'record_digest', 'schema']); assert.equal(env.channel, 'trusted-tty');
  assert.deepEqual(Object.keys(env.authorization).sort(), ['expires_at', 'issued_at', 'nonce', 'operation', 'plan_digest', 'prior_state', 'project_id', 'standard_commit', 'target']);
  assert.equal(env.authorization.operation, 'npm-provision'); assert.equal(env.authorization.plan_digest, pl.identity_digest);
  assert.equal(Date.parse(env.authorization.expires_at) - Date.parse(env.authorization.issued_at), TTL_SECONDS * 1000); assert.equal(TTL_SECONDS, 600);
  assert.equal(env.authorization.issued_at, new Date(c.now).toISOString());
  // identical to what the canonical minter produces for the exact plan (no re-implemented timestamps) and valid for it
  const expected = exactPlanOf(pl); assert.deepEqual(env.authorization, mintAuthorization(expected, pl.identity_digest, { nonce: env.authorization.nonce, nowMs: c.now }));
  assert.deepEqual(checkAuthorization(env.authorization, expected, c.now), []);
  assert.equal(env.authorization.standard_commit, run.run.base_commit); assert.equal(env.authorization.project_id, run.run.project_id); assert.equal(env.authorization.target.run_id, run.run.run_id);
  assert.deepEqual(env.cache_reuse_grant, reuseGrantOf(pl.identity_digest));
  assert.deepEqual(env.cache_reuse_grant, { identity_digest: pl.identity_digest, purpose: 'offline-validation', condition: 'cache content verifies against cache-manifest.json and package-lock.json', survives_authorization_expiry: true, allows_network: false, allows_reprovisioning: false });
  // binding: any drift of the bound fields, and any time at/after expiry, fails the canonical check
  const codes = (e, t = c.now) => checkAuthorization(env.authorization, e, t).map((x) => x.code);
  assert.deepEqual(codes({ ...expected, operation: 'apply' }), ['AUTH_MISMATCH']); assert.deepEqual(codes({ ...expected, project_id: 'other' }), ['AUTH_MISMATCH']);
  assert.deepEqual(codes({ ...expected, standard_commit: 'e'.repeat(40) }), ['AUTH_MISMATCH']); assert.deepEqual(codes({ ...expected, plan_digest: 'f'.repeat(64) }), ['AUTH_MISMATCH']);
  assert.deepEqual(codes({ ...expected, prior_state: { ...expected.prior_state, package_lock_sha256: '0'.repeat(64) } }), ['AUTH_MISMATCH']);
  assert.deepEqual(codes({ ...expected, target: { ...expected.target, result_tree: '1'.repeat(40) } }), ['AUTH_MISMATCH']);
  assert.deepEqual(codes(expected, c.now + TTL_SECONDS * 1000 - 1), []); assert.deepEqual(codes(expected, c.now + TTL_SECONDS * 1000), ['AUTH_EXPIRED']);
});

test('slow confirmation near expiry cannot extend the lifetime: expires_at stays issued_at + 600 s however late the human confirms', async () => {
  const c = mutClock(); const t0 = c.now; const { root, st, run } = await readyNpm(); const prov = provSim();
  const slow = { calls: [], confirm() { c.now += 599_000; return true; } }; // confirms 599 s in (still inside the canonical window)
  const r = await rv(root, st, { prov, terminal: slow, clock: c.fn }); assert.equal(r.code, 0, r.out);
  const env = envOf(join(idDirs(run)[0], 'attempt-1')); assert.equal(env.authorization.issued_at, new Date(t0).toISOString());
  assert.equal(env.authorization.expires_at, new Date(t0 + 600_000).toISOString(), 'NOT confirmation time + 600 s');
  assert.equal(rec(join(idDirs(run)[0], 'attempt-1')).approval_expires_at, new Date(t0 + 600_000).toISOString());
  // the human is also never given more than the time left: the prompt timeout is capped by expires_at
  const c2 = mutClock(); const seen = []; const { root: r2, st: s2 } = await readyNpm();
  const t2 = { calls: [], confirm(_text, _phrase, o) { seen.push(o.timeoutMs); return true; } }; await rv(r2, s2, { terminal: t2, clock: c2.fn, timeoutMs: 3_600_000 });
  assert.equal(seen[0], 600_000, 'effective timeout = min(configured, time left until the canonical expiry)');
});

test('expiry before provisioning blocks with NO download: confirmation at/after issued_at + 600 s', async () => {
  for (const late of [600_000, 900_000]) {
    const c = mutClock(); const { root, st, run } = await readyNpm(); const prov = provSim(); const val = valSim();
    const r = await rv(root, st, { prov, validator: val, terminal: { calls: [], confirm() { c.now += late; return true; } }, clock: c.fn });
    assert.equal(r.code, 1, String(late)); assert.equal(prov.calls.length, 0); assert.equal(val.calls.length, 0); assert.match(r.out, /expired/);
    const a = join(idDirs(run)[0], 'attempt-1'); assert.equal(rec(a).status, 'APPROVAL_TIMEOUT'); assert.equal(existsSync(join(a, 'approval.json')), false, 'an expired authorization is never recorded as an approval'); assert.equal(existsSync(join(a, 'cache')), false);
  }
});

test('the canonical check is repeated IMMEDIATELY before the network phase: expiry during the isolation preflight blocks with no download', async () => {
  const c = mutClock(); const { root, st, run } = await readyNpm(); const prov = provSim();
  prov.preflight = () => { c.now += 601_000; return { verified: true, checks: {} }; };
  const r = await rv(root, st, { prov, terminal: tty(true), clock: c.fn });
  assert.equal(r.code, 1); assert.equal(prov.calls.length, 0, 'no download'); assert.match(r.out, /expired/);
  const a = join(idDirs(run)[0], 'attempt-1'); assert.equal(rec(a).status, 'APPROVAL_TIMEOUT'); assert.equal(rec(a).network_phase, 'not-started');
  // and it never becomes a reusable cache: a later attempt needs a NEW trusted-terminal approval
  const again = await rv(root, st, { prov: provSim(), openTerminal: throwingTerminal }); assert.equal(again.code, 1); assert.match(again.out, /trusted interactive terminal is required/);
});

test('a PASS cache is reusable later without a TTY and without network ONLY for the identical identity, even after the interactive authorization expired; a changed identity needs a NEW current approval', async () => {
  const c = mutClock(); const { root, st, run } = await readyNpm(); const prov = provSim();
  assert.equal((await rv(root, st, { prov, terminal: tty(true), clock: c.fn })).code, 0); assert.equal(prov.calls.length, 1);
  const a = join(idDirs(run)[0], 'attempt-1'); const env = envOf(a); const expires = Date.parse(env.authorization.expires_at);
  c.now = expires + 24 * 3600_000; // a day after the interactive authorization expired
  const { checkAuthorization } = await import('../adapters/shared/sdd-writer/authorization.mjs');
  assert.deepEqual(checkAuthorization(env.authorization, exactPlanOf(planOfRec(a)), c.now).map((x) => x.code), ['AUTH_EXPIRED'], 'the interactive authorization itself is expired and can never start another download');
  const val = valSim(); const again = await rv(root, st, { prov, validator: val, openTerminal: throwingTerminal, clock: c.fn });
  assert.equal(again.code, 0, again.out); assert.equal(prov.calls.length, 1, 'no network, no re-provisioning'); assert.match(again.out, /reusing the verified private cache/); assert.equal(vrec(run, 2).npm.cache.reused, true);
  assert.deepEqual(val.seen.staged, [true]);
  // the grant never authorizes re-provisioning after expiry: a damaged cache BLOCKS (no TTY prompt, no download)
  rmSync(join(a, 'cache', '_cacache', 'index-v5'), { recursive: true, force: true });
  const damaged = await rv(root, st, { prov, openTerminal: throwingTerminal, clock: c.fn }); assert.equal(damaged.code, 1); assert.match(damaged.out, /cannot be reused/); assert.equal(prov.calls.length, 1);
  // a changed identity is NOT covered by the old grant: blocked without a current approval, then needs (and gets) a new one
  const { root: r2, st: s2, run: run2 } = await readyNpm(); const c2 = mutClock(); const p2 = provSim();
  assert.equal((await rv(r2, s2, { prov: p2, terminal: tty(true), clock: c2.fn })).code, 0);
  c2.now += 7 * 24 * 3600_000; const tc = { ...TOOL, npm: '10.9.9' }; const p3 = provSim({ toolchain: tc });
  const blocked = await rv(r2, s2, { prov: p3, toolchain: tc, openTerminal: throwingTerminal, clock: c2.fn }); assert.equal(blocked.code, 1); assert.equal(p3.calls.length, 0);
  const term = tty(true); const ok = await rv(r2, s2, { prov: p3, toolchain: tc, terminal: term, clock: c2.fn }); assert.equal(ok.code, 0, ok.out); assert.equal(term.calls.length, 1); assert.equal(p3.calls.length, 1);
  const envs = idDirs(run2).map((d) => envOf(join(d, attempts(d).find((n) => existsSync(join(d, n, 'approval.json')))))); assert.equal(new Set(envs.map((e) => e.cache_reuse_grant.identity_digest)).size, 2, 'each grant is limited to its own exact identity');
  assert.ok(envs.every((e) => e.cache_reuse_grant.allows_network === false && e.cache_reuse_grant.allows_reprovisioning === false));
});
