// Authorized npm provisioning + verified private cache for `dac review` independent validation (npm only; lockfileVersion 3 only).
//
// Two strictly separated phases:
//   1. PROVISIONING (the ONLY phase with network): after a dedicated trusted-terminal approval bound to the exact identity (audit/result/
//      content hashes, package.json + package-lock.json hashes, Node/npm/platform/arch/libc, install policy, authorized validation commands,
//      cache identity), `npm ci --ignore-scripts` runs in a disposable workspace under the provisioner sandbox (macOS sandbox-exec: writes
//      only to that workspace and the private cache; network allowed ONLY here). No npm config, token, provider key, NODE_OPTIONS, HOME or
//      user cache is inherited. The resulting cache is inventoried (content manifest + hash) and verified against the lockfile integrity.
//   2. VALIDATION (network denied, existing validation sandbox): the verified cache is staged into the disposable validation workspace and
//      `npm ci --offline --ignore-scripts` runs there before the already-authorized validation commands (see validation.mjs).
//
// The trusted-terminal authorization is the canonical Writer one (issued_at + exactly 600 s, never extended). It gates STARTING the download
// only (re-checked against a freshly recomputed exact plan right before the network phase). A completed approval additionally carries an
// explicit cache-reuse grant (exact identity, offline validation only, no network, no re-provisioning) that outlives the 600 s.
// Cache reuse needs NO new approval only if a previous attempt of the identical identity completed under such an approval AND the
// cache verifies byte-for-byte (manifest re-walk, recorded hashes, lockfile integrity of every required tarball). Directory names and
// record files are never trusted alone. Any mismatch/tampering/incompleteness BLOCKS (it never silently re-provisions).
//
// CONFIGURED vs VERIFIED: the sandbox profile, --ignore-scripts and the environment are CONFIGURATION; only what a preflight/recheck
// actually observed is reported as verified (see `enforcement` in the records). Install scripts have NO exception: they never run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertTerminal, checkAuthorization, confirmationPhrase, mintAuthorization, openTrustedTerminal, effectiveConfirmTimeoutMs, CONFIRM_TIMEOUT_SECONDS } from '../sdd-writer/authorization.mjs';
import { canonicalize, digestOf } from '../sdd-writer/artifacts.mjs';
import { RunError, sha256 } from './git.mjs';
import { safeExcerpt } from './runners.mjs';
import { readJson, writeOnce } from './store.mjs';

export const SUPPORTED_LOCKFILE_VERSIONS = [3];
export const ALLOWED_REGISTRY_HOSTS = ['registry.npmjs.org'];
export const REGISTRY = 'https://registry.npmjs.org/';
export const PROVISION_ARGV = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
export const OFFLINE_INSTALL_ARGV = ['npm', 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
export const OFFLINE_INSTALL_COMMAND = OFFLINE_INSTALL_ARGV.join(' ');
const MAX_CAPTURE = 8 * 1024 * 1024;
const NPM_VALIDATION_SUBCOMMANDS = ['test', 't', 'run', 'run-script'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const MAX_CACHE_FILES = 200000;

// ---------------------------------------------------------------------------------------------------------------- detection
export const isNpmCommand = (argv) => Array.isArray(argv) && argv[0] === 'npm';

// An npm validation command may only be test / run <script> / run-script <script>, with no options before `--` (options could change
// registry, cache, prefix, script shell or scripts policy), and never install/ci/rebuild/update/exec/config/etc.
export function npmCommandProblem(argv) {
  const sub = argv[1];
  if (!NPM_VALIDATION_SUBCOMMANDS.includes(sub)) return `npm ${sub ?? ''} is not an allowed validation command (only npm test, npm run <script>, npm run-script <script>)`.replace('  ', ' ');
  const sep = argv.indexOf('--');
  const head = sep < 0 ? argv.slice(2) : argv.slice(2, sep);
  const bad = head.find((w) => w.startsWith('-'));
  if (bad) return `npm option ${JSON.stringify(bad)} is not allowed before "--" in an authorized validation command`;
  if ((sub === 'run' || sub === 'run-script') && !head.length) return `npm ${sub} needs a script name`;
  return null;
}

const SPEC_BAD = /^(file|link|git|git\+[a-z]+|github|gitlab|bitbucket|gist|http|https|workspace|npm|ssh):|\/|^\.|^~/i;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseJson(buf) { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
const sameMap = (a, b) => JSON.stringify(canonicalize(a ?? {})) === JSON.stringify(canonicalize(b ?? {}));
const matchList = (list, value) => { // npm os/cpu semantics: allow list or "!x" deny entries
  if (!Array.isArray(list) || !list.length) return true;
  const deny = list.filter((x) => typeof x === 'string' && x.startsWith('!')).map((x) => x.slice(1));
  const allow = list.filter((x) => typeof x === 'string' && !x.startsWith('!'));
  if (deny.includes(value)) return false;
  return allow.length ? allow.includes(value) : true;
};

// Lockfile analysis (pure). Returns { problems, summary, required }.
export function analyzeLock(lock, pkg, toolchain) {
  const problems = []; const hosts = new Set(); const scripts = []; let count = 0; let optionalSkipped = 0; const required = [];
  if (!isPlain(lock)) return { problems: ['package-lock.json is not a JSON object'], summary: null, required };
  if (!SUPPORTED_LOCKFILE_VERSIONS.includes(lock.lockfileVersion)) problems.push(`lockfileVersion ${JSON.stringify(lock.lockfileVersion)} is not supported (supported: ${SUPPORTED_LOCKFILE_VERSIONS.join(', ')})`);
  if (!isPlain(lock.packages) || !isPlain(lock.packages[''])) { problems.push('package-lock.json has no "packages" map with a root entry'); return { problems, summary: null, required }; }
  const root = lock.packages[''];
  for (const f of DEP_FIELDS) if (!sameMap(root[f], pkg[f])) problems.push(`package.json and package-lock.json disagree on ${f}`);
  if (lock.name !== undefined && pkg.name !== undefined && lock.name !== pkg.name) problems.push('package.json and package-lock.json disagree on the package name');
  for (const [key, e] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!isPlain(e)) { problems.push(`lock entry ${JSON.stringify(key)} is not an object`); continue; }
    if (!/(^|\/)node_modules\/[^/]/.test(key)) { problems.push(`lock entry ${JSON.stringify(key)} is not an installed registry package (local/workspace path)`); continue; }
    if (e.link === true) { problems.push(`lock entry ${JSON.stringify(key)} is a link/local dependency`); continue; }
    if (e.inBundle === true) continue;
    count++;
    if (typeof e.resolved !== 'string') { problems.push(`lock entry ${JSON.stringify(key)} has no resolved tarball URL`); continue; }
    let u = null; try { u = new URL(e.resolved); } catch { /* handled */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password) { problems.push(`lock entry ${JSON.stringify(key)} does not resolve to a credential-free https registry URL (file:, git, http: and local sources are unsupported)`); continue; }
    if (!ALLOWED_REGISTRY_HOSTS.includes(u.hostname)) { problems.push(`lock entry ${JSON.stringify(key)} resolves to registry host ${u.hostname}, which is not allowed (${ALLOWED_REGISTRY_HOSTS.join(', ')})`); continue; }
    hosts.add(u.hostname);
    if (typeof e.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity)) { problems.push(`lock entry ${JSON.stringify(key)} has no sha512 integrity`); continue; }
    if (e.hasInstallScript === true) scripts.push({ path: key, version: e.version ?? null });
    const platformSkipped = e.optional === true && (!matchList(e.os, toolchain.platform) || !matchList(e.cpu, toolchain.arch) || (toolchain.platform === 'linux' && toolchain.libc && Array.isArray(e.libc) && !matchList(e.libc, toolchain.libc)));
    if (platformSkipped) { optionalSkipped++; continue; }
    required.push({ path: key, integrity: e.integrity, resolved: e.resolved });
  }
  scripts.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    problems, required,
    summary: { lockfile_version: lock.lockfileVersion, packages: count, required_tarballs: required.length, optional_platform_skipped: optionalSkipped, registry_hosts: [...hosts].sort(), install_script_packages: scripts,
      install_scripts_note: 'packages that DECLARE install scripts; they are NEVER run (--ignore-scripts, no exception). If one needs them, validation fails closed.' },
  };
}

// planNpm: pure. `files` = { pkg: Buffer|null, lock: Buffer|null, npmrc: string[] (paths), shrinkwrap: boolean }.
// Returns { applicable:false } (legacy semantics) | { applicable:true, ok:false, reasons } | { applicable:true, ok:true, identity, identity_digest, required, summary }.
// detectNpm: pure and cheap (no toolchain probe). Projects without npm dependencies/lock, or without an npm validation command,
// are NOT applicable and keep the current semantics.
export function detectNpm(files, argvs) {
  if (!argvs.some(isNpmCommand)) return { applicable: false };
  if (!files.pkg) return files.lock ? { applicable: true, ok: false, reasons: ['package-lock.json exists but package.json is missing'] } : { applicable: false };
  const pkg = parseJson(files.pkg);
  if (!isPlain(pkg)) return { applicable: true, ok: false, reasons: ['package.json is not valid JSON (an object is required)'] };
  const hasDeps = DEP_FIELDS.some((f) => isPlain(pkg[f]) && Object.keys(pkg[f]).length) || (Array.isArray(pkg.bundleDependencies) && pkg.bundleDependencies.length) || (Array.isArray(pkg.bundledDependencies) && pkg.bundledDependencies.length);
  if (!hasDeps && !files.lock) return { applicable: false };
  return { applicable: true, ok: true, pkg };
}

export function planNpm({ files, argvs, audit, run, toolchain }) {
  const d = detectNpm(files, argvs);
  if (!d.applicable || !d.ok) return d;
  const { pkg } = d;
  const npmCmds = argvs.filter(isNpmCommand);
  const reasons = [];
  for (const argv of npmCmds) { const p = npmCommandProblem(argv); if (p) reasons.push(p); }
  if (!files.lock) reasons.push('package.json declares dependencies but package-lock.json is missing from the audited result (lockfile generation is never performed during review)');
  for (const p of files.npmrc) reasons.push(`${p} is present: project npm configuration (registry, auth, scripts, cache) is unsafe and unsupported`);
  if (files.shrinkwrap) reasons.push('npm-shrinkwrap.json is present and would take precedence over package-lock.json: unsupported');
  if (pkg.workspaces !== undefined) reasons.push('package.json "workspaces" is unsupported (local packages)');
  for (const f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (pkg[f] === undefined) continue;
    if (!isPlain(pkg[f])) { reasons.push(`package.json ${f} is not an object`); continue; }
    for (const [n, spec] of Object.entries(pkg[f])) if (typeof spec !== 'string' || SPEC_BAD.test(spec.trim())) reasons.push(`package.json ${f}.${n} uses an unsupported source ${JSON.stringify(String(spec).slice(0, 80))} (local, file, link, git, URL, alias and workspace specs are refused)`);
  }
  if (!toolchain || !toolchain.node || !toolchain.npm || !toolchain.platform || !toolchain.arch) reasons.push('the Node/npm toolchain could not be determined');
  let analysis = { summary: null, required: [], problems: [] };
  if (files.lock) {
    const lock = parseJson(files.lock);
    if (!isPlain(lock)) reasons.push('package-lock.json is not valid JSON');
    else if (toolchain?.platform) { analysis = analyzeLock(lock, pkg, toolchain); reasons.push(...analysis.problems.slice(0, 10)); if (analysis.problems.length > 10) reasons.push(`... and ${analysis.problems.length - 10} more lockfile problem(s)`); }
  }
  if (reasons.length) return { applicable: true, ok: false, reasons };
  const identity = {
    kind: 'dac-npm-provision-identity', schema: 1,
    audit_hash: audit.audit_hash, content_hash: audit.content_hash, result_tree: audit.result_tree, base_commit: run.base_commit, project_id: run.project_id ?? null, run_id: run.run_id ?? null,
    package_json_sha256: sha256(files.pkg), package_lock_sha256: sha256(files.lock),
    toolchain: { node: toolchain.node, npm: toolchain.npm, platform: toolchain.platform, arch: toolchain.arch, libc: toolchain.libc ?? null },
    install_policy: { provision_argv: PROVISION_ARGV, offline_install_argv: OFFLINE_INSTALL_ARGV, ignore_scripts: true, install_script_exceptions: 'none', registry: REGISTRY, allowed_registry_hosts: ALLOWED_REGISTRY_HOSTS, lockfile_versions: SUPPORTED_LOCKFILE_VERSIONS, npm_config: 'private (not inherited): HOME, TMPDIR, cache, userconfig and globalconfig are private paths', network: 'provisioning phase only; validation is network-denied' },
    authorized_validation_commands: argvs.map((a) => a.join(' ')),
    lock_summary: analysis.summary,
    cache: { kind: 'npm-cacache-private', content_hash_binding: 'recorded after provisioning in cache-manifest.json; verified before every reuse' },
  };
  const identity_digest = digestOf(identity);
  return { applicable: true, ok: true, identity, identity_digest, required: analysis.required, files: { pkg: files.pkg, lock: files.lock }, summary: describePlan(identity, identity_digest) };
}

export function describePlan(id, digest) {
  const L = id.lock_summary;
  return [
    'dac review: NETWORK-ENABLED npm provisioning requested (private disposable cache; independent validation itself stays offline)',
    `  audit hash:     ${id.audit_hash}`, `  result tree:    ${id.result_tree}`, `  content hash:   ${id.content_hash}`,
    `  package.json:   sha256 ${id.package_json_sha256}`, `  package-lock:   sha256 ${id.package_lock_sha256} (lockfileVersion ${L.lockfile_version}, ${L.packages} packages, ${L.required_tarballs} tarballs to fetch for this platform)`,
    `  toolchain:      node ${id.toolchain.node}, npm ${id.toolchain.npm}, ${id.toolchain.platform}/${id.toolchain.arch}${id.toolchain.libc ? `/${id.toolchain.libc}` : ''}`,
    `  install policy: ${id.install_policy.provision_argv.join(' ')} (scripts DISABLED, no exception); then offline: ${id.install_policy.offline_install_argv.join(' ')}`,
    `  registry:       ${id.install_policy.registry} (lock hosts: ${L.registry_hosts.join(', ') || 'none'}); no credentials, no inherited npm config`,
    `  scripts:        ${L.install_script_packages.length} package(s) declare install scripts and will NOT be run${L.install_script_packages.length ? ` (e.g. ${L.install_script_packages.slice(0, 3).map((s) => s.path).join(', ')})` : ''}`,
    `  validation:     ${id.authorized_validation_commands.join(' | ')}`,
    `  cache identity: ${digest} (private cache inside the run evidence area; content hash recorded after download)`,
    '  Network exists ONLY for this download phase, in a disposable sandbox that can write only its own workspace and cache. Nothing is added to the project.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------- cache inventory
// Strict inventory of a cache directory: regular files + directories only (no symlink/hardlink/special/escape). Returns { entries, problems, hash }.
export function cacheManifest(dir) {
  const entries = []; const problems = []; let n = 0;
  const walk = (abs, rel) => {
    let names; try { names = readdirSync(abs); } catch { problems.push(`unreadable directory ${rel || '.'}`); return; }
    for (const name of names.sort()) {
      if (++n > MAX_CACHE_FILES) { problems.push('too many cache entries'); return; }
      const p = join(abs, name); const r = rel ? `${rel}/${name}` : name; let st;
      try { st = lstatSync(p); } catch { problems.push(`unreadable entry ${r}`); continue; }
      if (st.isDirectory()) { entries.push({ path: r, type: 'dir' }); walk(p, r); }
      else if (st.isFile() && st.nlink === 1 && !(st.mode & 0o7000)) { let b; try { b = readFileSync(p); } catch { problems.push(`unreadable file ${r}`); continue; } entries.push({ path: r, type: 'file', size: b.length, sha256: sha256(b) }); }
      else problems.push(`${st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'hardlink/special-mode file' : 'special file'} not allowed in the cache: ${r}`);
    }
  };
  walk(dir, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, problems, hash: digestOf(entries) };
}

// REAL npm layout: npm_config_cache points at <cacheDir>; cacache lives UNDER it in <cacheDir>/_cacache/{content-v2,index-v5}.
export const CACACHE_DIR = '_cacache';
const hexOfIntegrity = (integrity) => Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
const contentPath = (cacheDir, integrity) => { const hex = hexOfIntegrity(integrity); return join(cacheDir, CACACHE_DIR, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)); };
// cacache index: bucket file = sha256(key) split 2/2/rest; each line is "<sha1(entryJSON)>\t<entryJSON>"; make-fetch-happen keys are "make-fetch-happen:request-cache:<url>".
export const indexKey = (resolved) => `make-fetch-happen:request-cache:${resolved}`;
export const indexPath = (cacheDir, key) => { const h = createHash('sha256').update(key).digest('hex'); return join(cacheDir, CACACHE_DIR, 'index-v5', h.slice(0, 2), h.slice(2, 4), h.slice(4)); };
function hasIndexEntry(cacheDir, r) {
  let txt; try { txt = readFileSync(indexPath(cacheDir, indexKey(r.resolved)), 'utf8'); } catch { return false; }
  return txt.split('\n').some((line) => {
    const t = line.indexOf('\t'); if (t < 0) return false;
    const body = line.slice(t + 1); if (createHash('sha1').update(body).digest('hex') !== line.slice(0, t)) return false;
    let o; try { o = JSON.parse(body); } catch { return false; }
    return isPlain(o) && o.key === indexKey(r.resolved) && o.integrity === r.integrity;
  });
}
// Every tarball the lock requires for this platform must be in the real cacache content path (bytes hash to the lock integrity) AND have
// a real index entry (key = request-cache:<resolved>, integrity = lock integrity, sha1-valid line): without the index npm ci --offline cannot find it.
export function cacheCoverage(cacheDir, required) {
  const problems = [];
  if (!existsSync(join(cacheDir, CACACHE_DIR, 'index-v5')) || !existsSync(join(cacheDir, CACACHE_DIR, 'content-v2'))) problems.push(`the cache has no ${CACACHE_DIR}/index-v5 and ${CACACHE_DIR}/content-v2 (incomplete or not the real npm cache layout)`);
  for (const r of required) {
    let buf = null; try { buf = readFileSync(contentPath(cacheDir, r.integrity)); } catch { /* missing */ }
    if (!buf) problems.push(`missing cached tarball for ${r.path}`);
    else if (`sha512-${createHash('sha512').update(buf).digest('base64')}` !== r.integrity) problems.push(`cached tarball for ${r.path} does not match the lockfile integrity`);
    else if (!hasIndexEntry(cacheDir, r)) problems.push(`missing cache index metadata for ${r.path} (npm ci --offline could not find it)`);
    if (problems.length >= 10) { problems.push('...'); break; }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------- approval records
// The approval is a CANONICAL Writer authorization (mintAuthorization/checkAuthorization: issued_at + exactly TTL_SECONDS, never extended by
// the confirmation) stored UNCHANGED inside an envelope, plus an explicit cache-reuse grant. Two different things are authorized:
//   - the INTERACTIVE authorization (authorization.*) permits STARTING network provisioning, only until its canonical expires_at;
//   - the REUSE grant records that a COMPLETED, verified download of exactly this identity may be consumed later (offline validation only,
//     no TTY, no network) even after the authorization expired. It never authorizes re-provisioning or any network after expiry.
export const OPERATION = 'npm-provision';
export const exactPlanOf = (plan) => ({
  plan_digest: plan.identity_digest, target: { kind: 'dac-npm-private-cache', run_id: plan.identity.run_id, result_tree: plan.identity.result_tree, audit_hash: plan.identity.audit_hash, content_hash: plan.identity.content_hash },
  operation: OPERATION, project_id: plan.identity.project_id,
  prior_state: { base_commit: plan.identity.base_commit, package_json_sha256: plan.identity.package_json_sha256, package_lock_sha256: plan.identity.package_lock_sha256 },
  standard_commit: plan.identity.base_commit,
});
export const reuseGrantOf = (identityDigest) => ({
  identity_digest: identityDigest, purpose: 'offline-validation', condition: 'cache content verifies against cache-manifest.json and package-lock.json',
  survives_authorization_expiry: true, allows_network: false, allows_reprovisioning: false,
});
const ENVELOPE_KEYS = ['kind', 'schema', 'channel', 'authorization', 'cache_reuse_grant', 'record_digest'];
const envelopeDigest = (e) => digestOf({ kind: e.kind, schema: e.schema, channel: e.channel, authorization: e.authorization, cache_reuse_grant: e.cache_reuse_grant });
export function buildEnvelope(authorization, identityDigest) {
  const e = { kind: 'dac-npm-provision-approval', schema: 2, channel: 'trusted-tty', authorization, cache_reuse_grant: reuseGrantOf(identityDigest) };
  return { ...e, record_digest: envelopeDigest(e) };
}
// Reuse validation: the authorization must be the canonical shape/TTL/binding of THIS exact plan AS OF ITS ISSUANCE (expiry is deliberately
// not applied: it gated starting the download, which completed), the grant must be exactly the canonical grant, and the envelope digest must hold.
function validApproval(e, plan) {
  if (!isPlain(e) || JSON.stringify(Object.keys(e).sort()) !== JSON.stringify([...ENVELOPE_KEYS].sort())) return false;
  if (e.kind !== 'dac-npm-provision-approval' || e.schema !== 2 || e.channel !== 'trusted-tty' || e.record_digest !== envelopeDigest(e)) return false;
  if (digestOf(e.cache_reuse_grant) !== digestOf(reuseGrantOf(plan.identity_digest))) return false;
  const issued = isPlain(e.authorization) ? Date.parse(e.authorization.issued_at) : NaN;
  return Number.isFinite(issued) && checkAuthorization(e.authorization, exactPlanOf(plan), issued).length === 0;
}

const iso = (ms) => new Date(ms).toISOString();
const attemptsOf = (idDir) => { let n = []; try { n = readdirSync(idDir); } catch { /* none */ } return n.map((x) => /^attempt-(\d+)$/.exec(x)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b); };

// Verify a PASS attempt's cache against EVERYTHING recorded about it. Returns [] when reusable.
export function verifyAttempt(attemptDir, plan) {
  const identityDigest = plan.identity_digest; const required = plan.required;
  const rec = readJson(join(attemptDir, 'record.json'));
  const bad = [];
  if (!isPlain(rec) || rec.kind !== 'dac-npm-provision-record' || rec.status !== 'PASS') return ['the provisioning record is missing or not a PASS'];
  if (rec.identity_digest !== identityDigest) bad.push('the cache record is bound to a different identity (toolchain, platform, hashes, policy or commands)');
  const approval = readJson(join(attemptDir, 'approval.json'));
  if (!validApproval(approval, plan)) bad.push('the trusted-terminal approval envelope is missing, invalid, edited or does not carry a canonical authorization and cache reuse grant for this exact identity');
  else if (rec.approval_record_digest !== approval.record_digest) bad.push('the approval digest recorded with the cache differs from the approval record');
  const mf = join(attemptDir, 'cache-manifest.json');
  const manifest = readJson(mf);
  if (!isPlain(manifest) || sha256(readFileSyncSafe(mf)) !== rec.manifest_sha256 || !Array.isArray(manifest.entries) || digestOf(manifest.entries) !== rec.cache_hash || manifest.cache_hash !== rec.cache_hash) bad.push('the cache manifest is missing or does not match its recorded hash');
  const cacheDir = join(attemptDir, 'cache');
  if (!existsSync(cacheDir)) bad.push('the cache directory is missing');
  if (bad.length) return bad;
  const now = cacheManifest(cacheDir);
  if (now.problems.length) bad.push(`the cache is not a plain file tree: ${now.problems.slice(0, 3).join('; ')}`);
  else if (now.hash !== rec.cache_hash || digestOf(now.entries) !== digestOf(manifest.entries)) bad.push('the cache content differs from the recorded content manifest (tampered, modified or incomplete)');
  bad.push(...cacheCoverage(cacheDir, required));
  return bad;
}
function readFileSyncSafe(p) { try { return readFileSync(p); } catch { return Buffer.alloc(0); } }

// ---------------------------------------------------------------------------------------------------------------- provisioner runner
export const PROVISION_PROFILE = '(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath (param "WORKSPACE")) (subpath (param "CACHE")) (literal "/dev/null"))\n';
export const PROVISION_PROFILE_SHA256 = sha256(PROVISION_PROFILE);
export const PROBE_PROFILE = '(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (literal "/dev/null"))\n';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const ENV_ALLOW = ['PATH', 'LANG', 'LC_ALL', 'TERM'];
const PROBE_JS = "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,libc:process.platform==='linux'?(process.report.getReport().header.glibcVersionRuntime?'glibc':'non-glibc'):null})";

export function provisionerRunner({ spawn = spawnSync, timeoutMs = 15 * 60 * 1000, platform = process.platform, sandboxExec = SANDBOX_EXEC, sandboxAvailable = () => existsSync(sandboxExec), parentEnv = process.env } = {}) {
  const need = () => {
    if (platform !== 'darwin') throw new Error(`no supported isolator on platform ${platform}: npm provisioning is BLOCKED (never run without isolation)`);
    if (!sandboxAvailable()) throw new Error(`${sandboxExec} is missing or unusable: npm provisioning is BLOCKED (never run without isolation)`);
  };
  const baseEnv = () => Object.fromEntries(ENV_ALLOW.filter((k) => parentEnv[k] !== undefined).map((k) => [k, parentEnv[k]]));
  const describe = () => ({
    id: 'dac-npm-provisioner', role: 'provision', kind: 'sandbox-exec-argv', shell: false, bypass: false,
    isolation: { backend: 'macos-sandbox-exec', executable: sandboxExec, profile_id: 'dac-npm-provision-write-limited-network-v1', profile_sha256: PROVISION_PROFILE_SHA256, profile: PROVISION_PROFILE, platform_supported: platform === 'darwin', non_darwin: 'BLOCKED: no supported isolator' },
    network: 'ENABLED for this phase only (not host-filtered)', filesystem: 'writes denied except under the disposable provisioning workspace and the private cache (+ /dev/null); reads not restricted',
    env: `allowlist: ${ENV_ALLOW.join(', ')}, CI=1; HOME/TMPDIR/npm cache/userconfig/globalconfig are private; npm tokens, provider keys, NODE_OPTIONS and any inherited npm_config_* are NOT inherited`,
    timeout_ms: timeoutMs,
  });
  const sandboxed = (profile, params, argv, opts) => spawn(sandboxExec, [...params.flatMap(([k, v]) => ['-D', `${k}=${v}`]), '-p', profile, ...argv], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_CAPTURE, ...opts });
  return {
    id: 'dac-npm-provisioner', role: 'provision', describe,
    // reads the exact toolchain that the provisioner and validator will use (all writes and network denied)
    probe() {
      need();
      const env = { ...baseEnv(), HOME: '/var/empty', npm_config_logs_max: '0', npm_config_update_notifier: 'false' };
      const run = (argv) => sandboxed(PROBE_PROFILE, [], argv, { env, cwd: '/var/empty', timeout: 60000 });
      const n = run(['node', '-p', PROBE_JS]); const v = run(['npm', '--version', '--logs-max=0']);
      if (n.status !== 0 || v.status !== 0) throw new Error('could not determine the Node/npm toolchain');
      const t = JSON.parse(n.stdout.trim());
      return { node: t.node, npm: v.stdout.trim(), platform: t.platform, arch: t.arch, libc: t.libc };
    },
    // VERIFIED enforcement (observed, not configured): a write outside the allowed paths is refused, a write inside succeeds.
    preflight({ workspace, cache, outsideProbe }) {
      need();
      const ws = realpathSync(workspace); const c = realpathSync(cache);
      const run = (target) => sandboxed(PROVISION_PROFILE, [['WORKSPACE', ws], ['CACHE', c]], ['/usr/bin/touch', target], { env: baseEnv(), cwd: ws, timeout: 30000 });
      const inside = run(join(ws, '.preflight-inside')); const insideCache = run(join(c, '.preflight-inside'));
      const outside = run(outsideProbe);
      rmSync(join(ws, '.preflight-inside'), { force: true }); rmSync(join(c, '.preflight-inside'), { force: true });
      const leaked = existsSync(outsideProbe); if (leaked) rmSync(outsideProbe, { force: true });
      const verified = inside.status === 0 && insideCache.status === 0 && outside.status !== 0 && !leaked;
      return { verified, checks: { write_inside_workspace: inside.status === 0, write_inside_cache: insideCache.status === 0, write_outside_denied: outside.status !== 0 && !leaked } };
    },
    run({ argv, workspace, cache, home, tmp }) {
      need();
      const ws = realpathSync(workspace); const c = realpathSync(cache);
      const env = { ...baseEnv(), CI: '1', HOME: home, TMPDIR: tmp, npm_config_cache: c, npm_config_userconfig: join(home, '.npmrc'), npm_config_globalconfig: join(home, '.npmrc-global'), npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true', npm_config_registry: REGISTRY, npm_config_audit: 'false', npm_config_fund: 'false' };
      const r = sandboxed(PROVISION_PROFILE, [['WORKSPACE', ws], ['CACHE', c]], argv, { env, cwd: ws, timeout: timeoutMs });
      return { argv, status: r.status ?? null, signal: r.signal ?? null, error: r.error ? `${r.error.code ?? 'error'}: ${r.error.message}` : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

export function assertSafeProvisionerProfile(runner, ...otherIds) {
  const bad = (why) => { throw new RunError('UNSAFE_PROFILE', `the npm provisioner is not allowed: ${why}`); };
  if (!runner || runner.role !== 'provision' || typeof runner.run !== 'function' || typeof runner.describe !== 'function') bad('it must be a runner with role "provision"');
  const p = runner.describe();
  if (!p || p.role !== 'provision' || p.id !== runner.id) bad('its profile must declare role "provision" and its own id');
  if (p.shell !== false || p.bypass !== false) bad('shell and bypass must be explicitly false');
  if (otherIds.includes(runner.id)) bad('it must be a different identity than the implementer, validator and reviewer');
  return p;
}

// ---------------------------------------------------------------------------------------------------------------- ensure cache
const boundedFile = (path, text) => { const b = Buffer.from(String(text ?? ''), 'utf8'); const kept = b.length > MAX_CAPTURE ? b.subarray(0, MAX_CAPTURE) : b; return { sha256: writeOnce(path, kept), bytes_total: b.length, truncated: b.length > MAX_CAPTURE, file: path }; };

// ensureCache -> { ok, reasons, reused, attempt, attemptDir, cacheDir, record, recordSha, cacheHash, manifestSha, identityDigest, evidence }
// `replan()` recomputes the plan from the audited worktree (+ toolchain) after the human confirmed; `checkBinding()` -> string[] of drift.
export async function ensureCache({ plan, runDir, provisioner, clock, random, log = () => {}, terminal, openTerminal, confirmTimeoutMs, replan, checkBinding }) {
  const idDir = join(runDir, 'npm-provision', plan.identity_digest);
  mkdirSync(idDir, { recursive: true, mode: 0o700 });
  const idFile = join(idDir, 'identity.json');
  if (existsSync(idFile)) { if (digestOf(readJson(idFile)) !== plan.identity_digest) return blocked(['the stored cache identity does not match its directory (tampered)'], { idDir }); }
  else writeOnce(idFile, plan.identity);

  // ---- reuse: only a PASS attempt of this exact identity whose cache verifies; failure of a PASS attempt BLOCKS (no silent re-provisioning) ----
  const passes = attemptsOf(idDir).filter((n) => readJson(join(idDir, `attempt-${n}`, 'record.json'))?.status === 'PASS');
  for (const n of passes.reverse()) {
    const dir = join(idDir, `attempt-${n}`);
    const problems = verifyAttempt(dir, plan);
    if (problems.length) return blocked([`cache of provisioning attempt ${n} cannot be reused: ${problems.slice(0, 4).join('; ')}`], { idDir, attempt: n });
    const rec = readJson(join(dir, 'record.json'));
    log(`npm provisioning: reusing the verified private cache of attempt ${n} (identical identity ${plan.identity_digest.slice(0, 12)}, content hash ${rec.cache_hash.slice(0, 12)}); no network, no new approval needed.`);
    return { ok: true, reasons: [], reused: true, attempt: n, attemptDir: dir, cacheDir: join(dir, 'cache'), record: rec, recordSha: sha256(readFileSync(join(dir, 'record.json'))), cacheHash: rec.cache_hash, manifestSha: rec.manifest_sha256, identityDigest: plan.identity_digest, approvalRecordDigest: rec.approval_record_digest, recordFile: join(dir, 'record.json') };
  }

  // ---- provisioning attempt (numbered, exclusive) ----
  let attempt = 1; let dir;
  for (;; attempt++) { dir = join(idDir, `attempt-${attempt}`); try { mkdirSync(dir, { mode: 0o700 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; } }
  const workspace = join(dir, 'workspace'); const cacheDir = join(dir, 'cache');
  const home = join(workspace, '.dac-provision', 'home'); const tmp = join(workspace, '.dac-provision', 'tmp');
  const base = { kind: 'dac-npm-provision-record', schema: 1, attempt, identity_digest: plan.identity_digest, identity: plan.identity, runner: { id: provisioner.id, profile: provisioner.describe() } };
  const finish = (status, reasons, extra = {}) => { // exclusive record for EVERY outcome, so evidence is preserved on errors/cancellation
    const record = { ...base, status, reasons, network_phase: extra.network_phase ?? 'not-started', ...extra };
    const sha = writeOnce(join(dir, 'record.json'), record);
    return { ...blocked(reasons, { idDir, attempt }), record, recordSha: sha, recordFile: join(dir, 'record.json'), attemptDir: dir };
  };
  const cleanup = () => { try { if (existsSync(workspace) && lstatSync(workspace).isDirectory()) rmSync(workspace, { recursive: true, force: true, maxRetries: 2 }); } catch { /* retained; reported by absence of cleanup */ } return existsSync(workspace) ? 'retained' : 'removed'; };

  // trusted terminal approval (a dedicated one for this identity; never --yes/stdin/env/model)
  let term;
  try { term = assertTerminal(terminal ?? (openTerminal ?? openTrustedTerminal)()); } catch (e) { return finish('NO_TTY', [`a trusted interactive terminal is required to approve network provisioning (${e.message}); nothing was downloaded`]); }
  let auth;
  try {
    const now = clock();
    auth = mintAuthorization(exactPlanOf(plan), plan.identity_digest, { nonce: random(16), nowMs: now }); // canonical: expires_at = issued_at + exactly TTL_SECONDS
    const timeoutMs = effectiveConfirmTimeoutMs(auth, clock(), confirmTimeoutMs ?? CONFIRM_TIMEOUT_SECONDS * 1000);
    if (timeoutMs <= 0) return finish('APPROVAL_TIMEOUT', ['the approval expired before confirmation; nothing was downloaded']);
    let ok; try { ok = term.confirm(`${plan.summary}\n  approval digest: ${plan.identity_digest}`, confirmationPhrase(auth), { timeoutMs }); } catch (e) { return finish(e?.code === 'APPROVAL_TIMEOUT' ? 'APPROVAL_TIMEOUT' : 'APPROVAL_ERROR', [e?.code === 'APPROVAL_TIMEOUT' ? 'confirmation timed out; nothing was downloaded' : `approval failed: ${safeExcerpt(e?.message, { causalOnly: false, maxLines: 2 })}`]); }
    if (!ok) return finish('APPROVAL_DENIED', ['network provisioning was not approved on the trusted terminal; nothing was downloaded']);
  } finally { if (!terminal) term.close?.(); }

  // anything that moved while the human was reading invalidates the approval BEFORE it is recorded or used
  let again; try { again = await replan(); } catch (e) { again = { ok: false, reasons: [`re-planning failed: ${e.message}`] }; }
  if (!again.ok || again.identity_digest !== plan.identity_digest) return finish('DRIFT', ['the audited inputs or toolchain changed during approval (package/lock hashes, Node/npm/platform or policy); nothing was downloaded']);
  const drift = checkBinding(); if (drift.length) return finish('DRIFT', [`state drift before provisioning: ${drift.join('; ')}`]);
  // The canonical check against a FRESHLY recomputed exact plan and the CURRENT time. Confirmation never extends the lifetime; no second expiry is generated.
  const expiredOrDrifted = () => {
    const f = checkAuthorization(auth, exactPlanOf(again), clock()); if (!f.length) return null;
    return f.some((x) => x.code === 'AUTH_EXPIRED')
      ? { status: 'APPROVAL_TIMEOUT', reasons: ['the canonical authorization expired (issued_at + 600 s) before provisioning started; nothing was downloaded'] }
      : { status: 'DRIFT', reasons: [`the authorization no longer matches the exact plan: ${f.map((x) => x.code).join(', ')}; nothing was downloaded`] };
  };
  const g1 = expiredOrDrifted(); if (g1) return finish(g1.status, g1.reasons);
  const approval = buildEnvelope(auth, plan.identity_digest);
  writeOnce(join(dir, 'approval.json'), approval);

  // disposable workspace: exact package.json + lock only; private HOME/TMPDIR/cache
  let started = null; let run = null; let thrown = null; let enforcement = { level: 'configured-only', note: 'the provisioner exposes no preflight: isolation is CONFIGURATION, not verified enforcement' };
  try {
    for (const d of [workspace, home, tmp, cacheDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    writeOnce(join(workspace, 'package.json'), plan.files.pkg); writeOnce(join(workspace, 'package-lock.json'), plan.files.lock);
    if (typeof provisioner.preflight === 'function') {
      const outsideProbe = join(idDir, `.preflight-outside-${attempt}`);
      const pf = provisioner.preflight({ workspace, cache: cacheDir, outsideProbe });
      enforcement = { level: pf.verified ? 'verified-by-preflight' : 'preflight-FAILED', checks: pf.checks ?? null, note: 'observed by dac before the network phase: write inside workspace/cache succeeds, write outside is denied' };
      if (!pf.verified) { const r = finish('ISOLATION_UNVERIFIED', ['the provisioner isolation preflight failed; nothing was downloaded'], { approval_record_digest: approval.record_digest, enforcement, cleanup: cleanup() }); return r; }
    }
    const g2 = expiredOrDrifted(); // immediately before the network phase (after preflight): expiry/drift blocks with no download
    if (g2) return finish(g2.status, g2.reasons, { approval_record_digest: approval.record_digest, enforcement, cleanup: cleanup() });
    started = clock();
    try { run = await provisioner.run({ argv: [...PROVISION_ARGV], command: PROVISION_ARGV.join(' '), workspace, cache: cacheDir, home, tmp }); } catch (e) { thrown = e; }
  } catch (e) { thrown = e; }
  const finished = clock();
  const out = run && typeof run === 'object' ? run : { stdout: '', stderr: '' };
  const streams = {};
  for (const s of ['stdout', 'stderr']) streams[s] = boundedFile(join(dir, `provision.${s}.txt`), out[s]);
  const excerpt = (s) => safeExcerpt(String(out[s] ?? ''), { maxLines: 20, maxLineChars: 240, maxBytes: 2048, causalOnly: false });
  const command = { argv: PROVISION_ARGV, command: PROVISION_ARGV.join(' '), cwd: workspace, started_at: started ? iso(started) : null, finished_at: iso(finished), exit_code: Number.isInteger(out.status) ? out.status : null, signal: out.signal ?? null, error: thrown ? `runner failed: ${safeExcerpt(thrown.message, { causalOnly: false, maxLines: 2 })}` : out.error ?? null, stdout: { ...streams.stdout, excerpt: excerpt('stdout') }, stderr: { ...streams.stderr, excerpt: excerpt('stderr') } };
  const common = { approval_record_digest: approval.record_digest, approval_expires_at: auth.expires_at, network_phase: 'provisioning-only (npm ci --ignore-scripts); never during validation', enforcement, command, install_scripts: 'disabled by --ignore-scripts and npm_config_ignore_scripts=true (configured; no exception)' };
  const done = (status, reasons, extra = {}) => { const cleaned = cleanup(); const r = finish(status, reasons, { ...common, workspace_cleanup: cleaned, ...extra }); writeOnce(join(dir, 'cleanup.json'), { kind: 'dac-npm-provision-cleanup', schema: 1, attempt, record_sha256: r.recordSha, workspace: cleaned, cache_retained: existsSync(cacheDir), note: 'only this attempt\'s disposable workspace is removed; cache, records and logs are evidence' }); return r; };
  if (thrown || !run || command.exit_code !== 0 || command.signal || out.error) return done('DOWNLOAD_FAILED', [`npm provisioning failed (${thrown ? 'runner error' : command.signal ? `signal ${command.signal}` : out.error ? 'error' : `exit code ${command.exit_code}`}); the cache is not usable`]);
  const after = { pkg: sha256(readFileSyncSafe(join(workspace, 'package.json'))), lock: sha256(readFileSyncSafe(join(workspace, 'package-lock.json'))) };
  if (after.pkg !== plan.identity.package_json_sha256 || after.lock !== plan.identity.package_lock_sha256) return done('LOCK_CHANGED', ['provisioning modified package.json or package-lock.json; the cache is rejected']);
  const post = checkBinding(); if (post.length) return done('DRIFT', [`state drift after provisioning: ${post.join('; ')}`]);
  const mf = cacheManifest(cacheDir);
  if (mf.problems.length) return done('CACHE_INVALID', [`the provisioned cache is not a plain file tree: ${mf.problems.slice(0, 3).join('; ')}`]);
  const cov = cacheCoverage(cacheDir, plan.required);
  if (cov.length) return done('CACHE_INCOMPLETE', [`the provisioned cache is incomplete or does not match the lockfile: ${cov.slice(0, 4).join('; ')}`]);
  const manifestSha = writeOnce(join(dir, 'cache-manifest.json'), { kind: 'dac-npm-cache-manifest', schema: 1, identity_digest: plan.identity_digest, cache_hash: mf.hash, files: mf.entries.filter((e) => e.type === 'file').length, entries: mf.entries });
  return { ...done('PASS', [], { cache_hash: mf.hash, manifest_sha256: manifestSha, cache_files: mf.entries.filter((e) => e.type === 'file').length, verified: { lockfile_integrity_of_required_tarballs: plan.required.length } }), ok: true, reasons: [], reused: false, attempt, attemptDir: dir, cacheDir, cacheHash: mf.hash, manifestSha, identityDigest: plan.identity_digest, approvalRecordDigest: approval.record_digest };
}

function blocked(reasons, extra = {}) { return { ok: false, reasons, reused: false, ...extra }; }

// ---------------------------------------------------------------------------------------------------------------- staging for validation
// Copy a VERIFIED cache into the writable private cache of the disposable validation workspace and prove the copy is byte-identical.
export function stageCache(srcCache, dstCache, expectedHash) {
  const m = cacheManifest(srcCache);
  if (m.problems.length || m.hash !== expectedHash) throw new Error('the verified cache changed before staging');
  mkdirSync(dstCache, { recursive: true, mode: 0o700 });
  for (const e of m.entries) {
    const dst = join(dstCache, ...e.path.split('/'));
    if (e.type === 'dir') { mkdirSync(dst, { recursive: true, mode: 0o700 }); continue; }
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    const fd = openSync(join(srcCache, ...e.path.split('/')), constants.O_RDONLY | constants.O_NOFOLLOW);
    let buf; try { if (!fstatSync(fd).isFile()) throw new Error('not a file'); buf = readFileSync(fd); } finally { closeSync(fd); }
    if (sha256(buf) !== e.sha256) throw new Error(`cache file changed while staging: ${e.path}`);
    const out = openSync(dst, 'wx', 0o600); try { writeSync(out, buf); } finally { closeSync(out); }
    chmodSync(dst, 0o600);
  }
  const c = cacheManifest(dstCache);
  if (c.problems.length || c.hash !== expectedHash) throw new Error('the staged cache copy does not match the verified cache');
  return { files: m.entries.filter((e) => e.type === 'file').length, hash: c.hash };
}

// Read package.json / package-lock.json (and unsafe config presence) from the verified audited manifest entries; each file's blob id is rechecked.
export function readNpmInputs(sourceRoot, entries, blobOidFn, format) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const read = (p) => {
    const e = byPath.get(p); if (!e) return null;
    const fd = openSync(join(sourceRoot, ...p.split('/')), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const b = readFileSync(fd); if (blobOidFn(format, b) !== e.oid) throw new Error(`${p} changed while reading`); return b; } finally { closeSync(fd); }
  };
  return {
    pkg: read('package.json'), lock: read('package-lock.json'),
    npmrc: entries.filter((e) => e.path.split('/').pop().toLowerCase() === '.npmrc').map((e) => e.path),
    shrinkwrap: entries.some((e) => e.path.toLowerCase() === 'npm-shrinkwrap.json'),
  };
}
