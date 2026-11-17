#!/usr/bin/env node
// dac CLI v1: a thin facade over the existing engines. It adds no validation, schema, auth, persistence or runtime of its own.
//   init   -> installer/bootstrap.mjs (apply: dry-run preview first, then the same engine; interactive in a terminal)
//   update -> installer/bootstrap.mjs update (dry-run preview, then the same engine)
//   start/status/stop -> adapters/shared/sdd-handoff/custodian-cli.mjs (start is FOREGROUND; no daemon)
//   sdd    -> adapters/shared/sdd-writer/cli.mjs (child process; terminal approval stays writer-owned; exit codes pass through)
// Exit codes: 0 ok, 1 failure, 2 usage; `sdd` passes the writer's code through (including 3).
import { realpathSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { apply, update, installedOptions, verify, validPackageName, PACKAGE_NAME_RULE, STANDARD_PATH } from '../installer/bootstrap.mjs';
import { main as custodian } from '../adapters/shared/sdd-handoff/custodian-cli.mjs';
import { AdapterError } from '../adapters/shared/canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = join(HERE, '..', 'adapters/shared/sdd-writer/cli.mjs');
const INIT_PROVIDERS = ['claude-code', 'codex']; // cursor is intentionally not offered by dac v1
const HANDOFF_PROVIDERS = INIT_PROVIDERS;

const USAGE = `Usage: dac <command> [options]
  init [--provider <claude-code|codex>] [--path <dir>] [--package-name <name>] [--replace-package-name]
                                        Install one provider (shows the dry-run, then applies). In a terminal, \`dac init\` asks
                                        for path, package name and provider, previews, and asks before any write.
  update [--dry-run]                    Move this project's installed providers to this checkout's standard (bootstrap update)
  start                                 Run the SDD handoff custodian in the foreground (Ctrl-C stops it)
  status [--json]                       Bootstrap integrity and custodian health (read-only)
  stop                                  Stop the custodian
  sdd plan   --handoff <ID> [--json]    Print the canonical plan (no writes)   (or --input <file>)
  sdd apply  --handoff <ID> [--json]    Apply after approval on the controlling terminal   (or --input <file>)
  sdd verify --project <ID> [--json]    Re-check artifacts against receipts (no writes)
Project root: init uses --path/the typed path, else the nearest ancestor containing ${STANDARD_PATH}, else the Git top-level;\nother commands use the nearest ancestor of the current directory containing ${STANDARD_PATH}.`;

class Usage extends Error {}
const fail = (m) => { throw new Usage(m); };

// Strict allowlist: every flag and its arity is declared; anything else is a usage error.
function parseFlags(args, spec) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const kind = Object.hasOwn(spec, a) ? spec[a] : undefined;
    if (kind === 'bool' && o[a] === undefined) o[a] = true;
    else if (kind === 'value' && o[a] === undefined && i + 1 < args.length && args[i + 1] !== '' && !args[i + 1].startsWith('-')) o[a] = args[++i];
    else fail(`Unknown, repeated or incomplete option: ${a}`);
  }
  return o;
}

function projectRoot(cwd) {
  let dir = realpathSync(cwd);
  for (;;) {
    try { if (lstatSync(join(dir, STANDARD_PATH)).isFile()) return dir; } catch { /* keep climbing */ }
    const up = dirname(dir);
    if (up === dir) throw new AdapterError('NO_PROJECT', `no ${STANDARD_PATH} found in the current directory or any ancestor; run \`dac init --provider <p>\` in a Git project first`);
    dir = up;
  }
}

function gitRoot(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  try { return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {
    throw new AdapterError('NOT_GIT', 'dac init requires a Git repository (git init first; empty non-Git folders are not supported in v1)');
  }
}

const lines = (r) => [...r.created.map((p) => `  create ${p}`), ...r.updated.map((p) => `  update ${p}`), ...r.removed.map((p) => `  remove ${p}`), ...r.conflicts.map((c) => `  CONFLICT ${c.path}: ${c.reason}`)].join('\n');

const gitEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
};
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
const inGitWorktree = (dir) => { try { gitOut(dir, 'rev-parse', '--show-toplevel'); return true; } catch { return false; } };

// Fingerprint of a .git directory (paths, file hashes, link targets). Used to prove it is exactly what `git init` created.
function gitFingerprint(dotGit) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n); const r = rel ? `${rel}/${n}` : n; const st = lstatSync(p);
      if (st.isSymbolicLink()) out[r] = 'link';
      else if (st.isDirectory()) { out[r] = 'dir'; walk(p, r); } else out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dotGit, '');
  return JSON.stringify(out);
}

// Removes .git only when it is provably what this operation created: same real directory, byte-identical to the post-init
// fingerprint, unborn HEAD and no refs. Otherwise it is preserved and reported. Never touches anything else.
function undoGitInit(root, created) {
  const dotGit = join(root, '.git');
  try {
    const st = lstatSync(dotGit);
    if (!st.isDirectory() || st.ino !== created.ino || st.dev !== created.dev) return 'preserved .git (not the directory created by this operation)';
    if (gitFingerprint(dotGit) !== created.fingerprint) return 'preserved .git (it changed after git init)';
    try { gitOut(root, 'rev-parse', '--verify', '-q', 'HEAD'); return 'preserved .git (it is no longer unborn)'; } catch { /* unborn: expected */ }
    if (gitOut(root, 'for-each-ref').trim()) return 'preserved .git (it contains refs)';
    rmSync(dotGit, { recursive: true });
    return 'removed .git created by this operation';
  } catch (e) { return `preserved .git (could not be proven safe to remove: ${e.message})`; }
}

function defaultIo() {
  let rl = null; let eof = false; const queue = []; let waiter = null;
  const open = () => {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
    const done = () => { eof = true; if (waiter) { const w = waiter; waiter = null; w(null); } };
    rl.on('close', done); rl.on('SIGINT', () => rl.close());
  };
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask(q) {
      if (!rl) open();
      process.stdout.write(q);
      if (queue.length) return Promise.resolve(queue.shift());
      if (eof) return Promise.resolve(null);
      return new Promise((res) => { waiter = res; });
    },
    close() { rl?.close(); },
  };
}

// Read-only package-name suggestion from existing ecosystem manifests in the project root. Never writes, never follows symlinks,
// never executes anything; malformed or ambiguous input yields no suggestion (and a note) instead of a guess.
const MANIFEST_MAX = 1024 * 1024;
function readManifest(root, file) {
  const p = join(root, file);
  let st; try { st = lstatSync(p); } catch { return null; }
  if (!st.isFile() || st.size > MANIFEST_MAX) return { problem: `${file} is not a regular file of a readable size` };
  try { return { text: readFileSync(p, 'utf8') }; } catch { return { problem: `${file} could not be read` }; }
}
const TOML_STR = /^(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/;
function tomlTableName(text, table, key) {
  let cur = null; const found = []; let dynamic = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (h) { cur = h[1]; continue; }
    if (/^\[\[/.test(line)) { cur = null; continue; }
    if (cur !== table) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === key) { const m = TOML_STR.exec(kv[2]); found.push(m ? (m[1] ?? m[2]) : undefined); }
    else if (kv[1].startsWith(`${key}.`)) found.push(undefined);
    else if (kv[1] === 'dynamic' && new RegExp(`["']${key}["']`).test(kv[2])) dynamic = true;
  }
  if (dynamic || found.length > 1 || (found.length === 1 && found[0] === undefined)) return { ambiguous: true };
  return found.length ? { name: found[0] } : {};
}
function suggestPackageName(root) {
  const cands = []; const notes = [];
  const add = (file, r) => { if (r.name !== undefined) { if (validPackageName(r.name)) cands.push({ file, name: r.name }); else notes.push(`${file}: name is not a usable package name; ignored`); } else if (r.ambiguous) notes.push(`${file}: name is ambiguous (dynamic, duplicated or unreadable); no suggestion from it`); };
  const each = (file, parse) => { const m = readManifest(root, file); if (!m) return; if (m.problem) { notes.push(`${file}: ${m.problem}; ignored`); return; } try { add(file, parse(m.text)); } catch { notes.push(`${file}: malformed; ignored`); } };
  each('package.json', (t) => { const j = JSON.parse(t); return typeof j?.name === 'string' ? { name: j.name } : {}; });
  each('pyproject.toml', (t) => tomlTableName(t, 'project', 'name'));
  each('Cargo.toml', (t) => tomlTableName(t, 'package', 'name'));
  each('go.mod', (t) => {
    const mods = t.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => /^module(\s|\()/.test(l));
    if (mods.length === 0) return {};
    if (mods.length > 1) return { ambiguous: true };
    const m = /^module\s+(?:"([^"\\]+)"|`([^`]+)`|(\S+))$/.exec(mods[0]);
    return m && m[3] !== '(' ? { name: m[1] ?? m[2] ?? m[3] } : { ambiguous: true };
  });
  for (const file of ['settings.gradle', 'settings.gradle.kts']) {
    each(file, (t) => {
      const hits = t.split(/\r?\n/).filter((l) => /^\s*rootProject\.name\b/.test(l));
      if (hits.length === 0) return {};
      const names = hits.map((l) => /^\s*rootProject\.name\s*=\s*(?:"([^"$\\]+)"|'([^'$\\]+)')\s*(?:\/\/.*)?$/.exec(l)).map((m) => (m ? (m[1] ?? m[2]) : null));
      return names.length === 1 && names[0] !== null ? { name: names[0] } : { ambiguous: true };
    });
  }
  const distinct = [...new Set(cands.map((c) => c.name))];
  if (distinct.length === 1) return { name: distinct[0], notes: [`package name suggestion "${distinct[0]}" read from ${cands.map((c) => c.file).join(', ')} (manifests are never modified)`, ...notes] };
  if (distinct.length > 1) return { name: null, notes: [`manifests disagree on the package name (${cands.map((c) => `${c.file}: ${c.name}`).join('; ')}); no suggestion, type one`, ...notes] };
  return { name: null, notes };
}

class Cancelled extends Error {}
const askRequired = async (io, q) => { const a = await io.ask(q); if (a === null) throw new Cancelled('input ended'); return a.trim(); };

// Root selection: explicit path wins; then the nearest ancestor with an installed DAC standard record; then the Git top-level.
function chooseRoot(explicit, cwd) {
  if (explicit !== undefined) {
    let real;
    try { real = realpathSync(resolve(cwd, explicit)); } catch { throw new AdapterError('TARGET', `path does not exist: ${explicit}`); }
    if (!statSync(real).isDirectory()) throw new AdapterError('TARGET', `path is not a directory: ${explicit}`);
    return { root: real, via: 'explicit path' };
  }
  try { return { root: projectRoot(cwd), via: 'nearest installed DAC project' }; } catch { /* none: fall back to Git */ }
  return { root: gitRoot(cwd), via: 'Git top-level' };
}

async function init(args, cwd, io) {
  const f = parseFlags(args, { '--provider': 'value', '--path': 'value', '--package-name': 'value', '--replace-package-name': 'bool' });
  let provider = f['--provider']; let explicitPath = f['--path']; let packageName = f['--package-name'];
  if (provider !== undefined && !INIT_PROVIDERS.includes(provider)) fail(`--provider must be one of ${INIT_PROVIDERS.join(', ')}`);
  if (packageName !== undefined && !validPackageName(packageName)) fail(`--package-name must be ${PACKAGE_NAME_RULE}`);
  const interactive = provider === undefined;
  if (interactive && !io.isTTY) fail('--provider is required (interactive init needs a terminal; nothing was written)');
  if (interactive && f['--replace-package-name']) fail('--replace-package-name is for non-interactive use; interactive init asks for confirmation');
  try {
    if (interactive) {
      if (explicitPath === undefined) { const a = await askRequired(io, 'Existing project path (blank: auto-detect from the current directory): '); if (a) explicitPath = a; }
    }
    const { root, via } = chooseRoot(explicitPath, interactive ? cwd : cwd);
    const needsGit = explicitPath !== undefined && !inGitWorktree(root);
    const cur = installedOptions({ target: root });
    if (interactive) {
      if (packageName === undefined) {
        // Default priority: the existing .dac/project.json value, then an unambiguous suggestion read from an ecosystem manifest.
        const sug = cur.packageName ? { name: null, notes: [] } : suggestPackageName(root);
        for (const n of sug.notes) console.log(`note: ${n}`);
        const def = cur.packageName || sug.name || undefined;
        const a = await askRequired(io, `Package name${def ? ` [${def}]` : ''}: `);
        packageName = a || def;
        if (packageName === undefined) throw new Cancelled('package name is required');
        if (!validPackageName(packageName)) fail(`package name must be ${PACKAGE_NAME_RULE}`);
      }
      const installed = Object.keys(cur.providers).filter((p) => INIT_PROVIDERS.includes(p));
      const a = await askRequired(io, `Provider (${INIT_PROVIDERS.join('|')})${installed.length === 1 ? ` [${installed[0]}]` : ''}: `);
      provider = a || (installed.length === 1 ? installed[0] : '');
      if (!INIT_PROVIDERS.includes(provider)) fail(`provider must be one of ${INIT_PROVIDERS.join(', ')}`);
    }
    if (!interactive && (needsGit || !inGitWorktree(root))) throw new AdapterError('NOT_GIT', 'dac init requires a Git repository (git init first, or run `dac init` in a terminal to confirm git init for an explicit path)');
    const changed = packageName !== undefined && cur.packageName !== null && cur.packageName !== packageName;
    if (changed && !interactive && !f['--replace-package-name']) throw new AdapterError('PACKAGE_NAME_CHANGE', `package name is ${cur.packageName}; pass --replace-package-name to change it to ${packageName} (nothing was written)`);
    const mine = cur.providers[provider];
    // Re-running preserves context7/optionalAgents but always requests the handoff runtime for the selected provider.
    // A first install enables it unless another provider owns it; an existing install without it fails closed (before any write) if another provider owns it.
    const owner = Object.entries(cur.providers).find(([p, o]) => p !== provider && HANDOFF_PROVIDERS.includes(p) && o.sddHandoff)?.[0];
    if (mine && owner && !mine.sddHandoff) throw new AdapterError('HANDOFF_CONFLICT', `the SDD handoff runtime is already owned by ${owner}; ${provider} cannot also own it (nothing was written)`);
    const options = mine ? { ...mine, sddHandoff: true } : { context7: false, optionalAgents: [], sddHandoff: !owner };
    const req = { target: root, providers: [provider], options, ...(packageName !== undefined ? { packageName } : {}) };
    const preview = apply({ ...req, dryRun: true });
    console.log(`dac init ${provider} in ${root}\nDestination selected by: ${via}${packageName !== undefined ? `\npackage_name: ${changed ? `${cur.packageName} -> ${packageName} (CHANGE)` : packageName}` : ''}${needsGit && preview.status !== 'UNCHANGED' ? '\n  git init (new repository, no commits)' : ''}\nPlan (${preview.status}):\n${lines(preview) || '  (no changes)'}`);
    if (preview.status === 'CONFLICT') return 1;
    if (preview.status === 'UNCHANGED') { console.log('Already installed; nothing to do.'); return 0; }
    if (interactive) {
      const a = await io.ask(`${changed ? 'Replace the package name and apply' : 'Apply'} this plan${needsGit ? ' (including git init)' : ''}? [y/N] `);
      if (!a || !['y', 'yes'].includes(a.trim().toLowerCase())) throw new Cancelled('not confirmed');
    }
    let created = null;
    if (needsGit) {
      try { lstatSync(join(root, '.git')); throw new AdapterError('NOT_GIT', 'a .git entry appeared before git init; nothing was written'); } catch (e) { if (e instanceof AdapterError) throw e; }
      gitOut(root, 'init', '-q');
      const st = lstatSync(join(root, '.git'));
      created = { ino: st.ino, dev: st.dev, fingerprint: gitFingerprint(join(root, '.git')) };
    }
    let r; let err = null;
    try { r = apply(req); } catch (e) { err = e; }
    if (created && (err || r.status !== 'APPLIED')) console.error(`git init follow-up: ${undoGitInit(root, created)}`);
    if (err) throw err;
    console.log(`${r.status}: created ${r.created.length}, updated ${r.updated.length}, removed ${r.removed.length}`);
    return r.status === 'CONFLICT' ? 1 : 0;
  } catch (e) {
    if (e instanceof Cancelled) { console.error(`Cancelled (${e.message}); nothing was written.`); return 1; }
    throw e;
  } finally { io.close?.(); }
}

function updateCmd(args, cwd) {
  const f = parseFlags(args, { '--dry-run': 'bool' });
  const root = projectRoot(cwd);
  const preview = update({ target: root, dryRun: true });
  console.log(`dac update in ${root}\nPlan (${preview.status}):\n${lines(preview) || '  (no changes)'}`);
  if (preview.status === 'CONFLICT') return 1;
  if (preview.status === 'UNCHANGED') { console.log('Already up to date; nothing to do.'); return 0; }
  if (f['--dry-run']) return 0;
  const r = update({ target: root });
  console.log(`${r.status}: created ${r.created.length}, updated ${r.updated.length}, removed ${r.removed.length}`);
  return r.status === 'CONFLICT' ? 1 : 0;
}

async function capture(argv) {
  let text = '';
  // err is intentionally ignored: custodian --json emits its result through out only.
  const code = await custodian(argv, { out: (s) => { text += s; }, err: () => {} });
  let json = null; try { json = JSON.parse(text); } catch { /* plain */ }
  return { code, text, json };
}

function handoffInstalled(root) {
  const { providers } = installedOptions({ target: root });
  return Object.entries(providers).some(([p, o]) => HANDOFF_PROVIDERS.includes(p) && o.sddHandoff);
}

async function start(args, cwd) {
  parseFlags(args, {});
  const root = projectRoot(cwd);
  if (!handoffInstalled(root)) throw new AdapterError('NO_HANDOFF', 'the SDD handoff runtime is not installed in this project; run `dac init --provider <claude-code|codex>` first');
  const s = await capture(['status', '--target', root, '--json']);
  if (s.code === 0 && s.json?.state === 'running') { console.log(`custodian already running (pid ${s.json.pid}, instance ${s.json.instance_id})`); return 0; }
  return custodian(['start', '--target', root]); // null: keeps running in the foreground; stale sockets are cleaned by the custodian itself
}

async function status(args, cwd) {
  const f = parseFlags(args, { '--json': 'bool' });
  const root = projectRoot(cwd);
  const boot = verify({ target: root });
  const cust = await capture(['status', '--target', root, '--json']);
  const state = cust.json ?? { state: 'unknown' };
  if (f['--json']) console.log(JSON.stringify({ root, bootstrap: boot, custodian: state }, null, 2));
  else console.log(`project ${root}\nbootstrap: ${boot.status}${boot.findings.map((x) => `\n  ${x.kind.toUpperCase()} ${x.path}: ${x.reason}`).join('')}\nproviders: ${boot.providers.join(', ') || 'none'}\ncustodian: ${state.state}${state.state === 'running' ? ` (pid ${state.pid}, live handoffs ${state.live_handoffs})` : ''}`);
  return boot.status === 'OK' ? 0 : 1;
}

async function stop(args, cwd) {
  parseFlags(args, {});
  const root = projectRoot(cwd);
  const r = await capture(['stop', '--target', root]);
  console.log(r.text);
  return r.code;
}

function sdd(args, cwd) {
  const [sub, ...rest] = args;
  let spec;
  if (sub === 'plan' || sub === 'apply') spec = { '--handoff': 'value', '--input': 'value', '--json': 'bool' };
  else if (sub === 'verify') spec = { '--project': 'value', '--json': 'bool' };
  else fail('sdd takes plan, apply or verify');
  const f = parseFlags(rest, spec);
  if (sub === 'verify') { if (!f['--project']) fail('--project is required'); }
  else if ((f['--handoff'] === undefined) === (f['--input'] === undefined)) fail('exactly one of --handoff <ID> or --input <file> is required');
  const root = projectRoot(cwd);
  const r = spawnSync(process.execPath, [WRITER, sub, '--target', root, ...rest], { stdio: 'inherit', cwd });
  return r.status ?? 1;
}

export { undoGitInit, gitFingerprint, suggestPackageName }; // exported for tests only

export async function main(argv, cwd = process.cwd(), io = defaultIo()) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
    if (cmd === 'init') return await init(rest, cwd, io);
    if (cmd === 'update') return updateCmd(rest, cwd);
    if (cmd === 'start') return await start(rest, cwd);
    if (cmd === 'status') return await status(rest, cwd);
    if (cmd === 'stop') return await stop(rest, cwd);
    if (cmd === 'sdd') return sdd(rest, cwd);
    return fail('Unknown command');
  } catch (e) {
    if (e instanceof Usage) { console.error(`${e.message}\n${USAGE}`); return 2; }
    console.error(e instanceof AdapterError ? `${e.code}: ${e.message}` : `dac failure: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exitCode = code; // null: foreground custodian keeps the process alive
}
