#!/usr/bin/env node
// dac CLI v1: a thin facade over the existing engines. It adds no validation, schema, auth, persistence or runtime of its own.
//   init   -> installer/bootstrap.mjs (apply: dry-run preview first, then the same engine)
//   start/status/stop -> adapters/shared/sdd-handoff/custodian-cli.mjs (start is FOREGROUND; no daemon)
//   sdd    -> adapters/shared/sdd-writer/cli.mjs (child process; terminal approval stays writer-owned; exit codes pass through)
// Exit codes: 0 ok, 1 failure, 2 usage; `sdd` passes the writer's code through (including 3).
import { realpathSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { apply, installedOptions, verify, STANDARD_PATH } from '../installer/bootstrap.mjs';
import { main as custodian } from '../adapters/shared/sdd-handoff/custodian-cli.mjs';
import { AdapterError } from '../adapters/shared/canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = join(HERE, '..', 'adapters/shared/sdd-writer/cli.mjs');
const INIT_PROVIDERS = ['claude-code', 'codex']; // cursor is intentionally not offered by dac v1
const HANDOFF_PROVIDERS = INIT_PROVIDERS;

const USAGE = `Usage: dac <command> [options]
  init --provider <claude-code|codex>   Install one provider into the current Git project (shows the dry-run, then applies)
  start                                 Run the SDD handoff custodian in the foreground (Ctrl-C stops it)
  status [--json]                       Bootstrap integrity and custodian health (read-only)
  stop                                  Stop the custodian
  sdd plan   --handoff <ID> [--json]    Print the canonical plan (no writes)   (or --input <file>)
  sdd apply  --handoff <ID> [--json]    Apply after approval on the controlling terminal   (or --input <file>)
  sdd verify --project <ID> [--json]    Re-check artifacts against receipts (no writes)
The project root is the nearest ancestor of the current directory containing ${STANDARD_PATH} (init: the Git top-level).`;

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

function init(args, cwd) {
  const f = parseFlags(args, { '--provider': 'value' });
  const provider = f['--provider'];
  if (!provider) fail('--provider is required');
  if (!INIT_PROVIDERS.includes(provider)) fail(`--provider must be one of ${INIT_PROVIDERS.join(', ')}`);
  const root = gitRoot(cwd);
  const cur = installedOptions({ target: root });
  const mine = cur.providers[provider];
  // Re-running preserves context7/optionalAgents but always requests the handoff runtime for the selected provider.
  // A first install enables it unless another provider owns it; an existing install without it fails closed (before any write) if another provider owns it.
  const owner = Object.entries(cur.providers).find(([p, o]) => p !== provider && HANDOFF_PROVIDERS.includes(p) && o.sddHandoff)?.[0];
  if (mine && owner && !mine.sddHandoff) throw new AdapterError('HANDOFF_CONFLICT', `the SDD handoff runtime is already owned by ${owner}; ${provider} cannot also own it (nothing was written)`);
  const options = mine ? { ...mine, sddHandoff: true } : { context7: false, optionalAgents: [], sddHandoff: !owner };
  const preview = apply({ target: root, providers: [provider], options, dryRun: true });
  console.log(`dac init ${provider} in ${root}\nPlan (${preview.status}):\n${lines(preview) || '  (no changes)'}`);
  if (preview.status === 'CONFLICT') return 1;
  if (preview.status === 'UNCHANGED') { console.log('Already installed; nothing to do.'); return 0; }
  const r = apply({ target: root, providers: [provider], options });
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

export async function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === '--help' || cmd === '-h') { console.log(USAGE); return 0; }
    if (cmd === 'init') return init(rest, cwd);
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
