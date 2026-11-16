#!/usr/bin/env node
// Human-operated custodian CLI. `start` runs in the FOREGROUND (Ctrl-C stops it and destroys every handoff).
//   start  --target <dir> --runtime-dir <abs>  start the in-memory custodian for exactly this target
//   status --target <dir> --runtime-dir <abs>  show liveness, instance, counts (no payload content)
//   stop   --target <dir> --runtime-dir <abs>  stop a running custodian (or remove a verified stale socket)
//   cancel --target <dir> --runtime-dir <abs> --handoff <id>  drop one handoff
// --runtime-dir is an explicit absolute directory chosen by the human (no tmpdir/env/cwd default); the MCP server and the
// writer must be given the same one by the human/bootstrap config.
// Exit codes: 0 ok, 1 failure, 2 usage.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startCustodian, cleanStaleSocket } from './custodian.mjs';
import { statusOf, stopCustodian, cancelHandoff } from './client.mjs';
import { resolveRuntimeDir, socketPath, assertPrivateDir } from './endpoint.mjs';
import { targetIdentity } from './identity.mjs';

const USAGE = 'Usage: custodian-cli.mjs <start|status|stop|cancel> --target <dir> --runtime-dir <absolute dir> [--handoff <id>] [--json]';

function parse(argv) {
  const [cmd, ...rest] = argv; const o = { cmd, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') o.json = true;
    else if (rest[i] === '--target' && rest[i + 1] && o.target === undefined) o.target = resolve(rest[++i]);
    else if (rest[i] === '--runtime-dir' && rest[i + 1] && o.dir === undefined) o.dir = rest[++i];
    else if (rest[i] === '--handoff' && rest[i + 1] && o.handoff === undefined) o.handoff = rest[++i];
    else return { usage: true };
  }
  if (!['start', 'status', 'stop', 'cancel'].includes(cmd) || !o.target || o.dir === undefined) return { usage: true };
  if ((cmd === 'cancel') !== (o.handoff !== undefined)) return { usage: true };
  return o;
}

export async function main(argv, { out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const o = parse(argv);
  if (o.usage) { err(USAGE); return 2; }
  try { o.dir = resolveRuntimeDir(o.dir); } catch (e) { err(`${e.code}: ${e.message}`); return 2; }
  const emit = (obj, text) => out(o.json ? JSON.stringify(obj) : text);
  try {
    if (o.cmd === 'start') {
      const c = await startCustodian({ target: o.target, dir: o.dir, onStopped: () => process.exit(0) });
      const shutdown = async () => { await c.close(); process.exit(0); };
      for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, shutdown);
      err(`sdd-handoff custodian started (foreground)\n  target:   ${c.target.realpath}\n  instance: ${c.instanceId}\n  pid:      ${process.pid}\n  runtime:  ${c.dir}\n  socket:   ${c.socketPath}\n  payloads live ONLY in this process memory; Ctrl-C (or stop) destroys every handoff.`);
      return null;
    }
    if (o.cmd === 'status') {
      const id = targetIdentity(o.target); const dir = o.dir;
      try { assertPrivateDir(dir); } catch (e) { emit({ state: 'not-running', code: e.code }, 'not running'); return 1; }
      const s = await statusOf(o.target, { dir }).catch((e) => e);
      if (s instanceof Error) {
        if (s.code === 'HANDOFF_UNAVAILABLE') { // distinguish absent from stale (never cleaned by status)
          const { probeEndpoint } = await import('./custodian.mjs');
          const st = await probeEndpoint(socketPath(dir, id)).catch(() => 'unverifiable');
          emit({ state: st === 'stale' ? 'stale-socket' : st === 'unverifiable' ? 'unverifiable' : 'not-running' }, st === 'stale' ? 'stale socket (no custodian); run `stop` or `start` to clean it' : st === 'unverifiable' ? 'endpoint cannot be verified; nothing touched' : 'not running');
        } else emit({ state: 'error', code: s.code }, `error: ${s.code}`);
        return 1;
      }
      emit({ state: 'running', pid: s.pid, instance_id: s.instance_id, started_at: s.started_at, target: s.target.realpath, live_handoffs: s.live_handoffs, ttl_seconds: s.ttl_seconds, capacity: s.capacity, max_payload_bytes: s.max_payload_bytes },
        `running\n  pid ${s.pid} instance ${s.instance_id}\n  target ${s.target.realpath}\n  live handoffs ${s.live_handoffs}/${s.capacity}, ttl ${s.ttl_seconds}s, max payload ${s.max_payload_bytes} bytes`);
      return 0;
    }
    if (o.cmd === 'stop') {
      try { await stopCustodian(o.target, { dir: o.dir }); emit({ state: 'stopped' }, 'custodian stopping; all handoffs destroyed'); return 0; } catch (e) {
        if (e.code !== 'HANDOFF_UNAVAILABLE') throw e;
        const st = await cleanStaleSocket(socketPath(o.dir, targetIdentity(o.target)), { dir: o.dir, identity: targetIdentity(o.target) }).catch(() => 'unverifiable');
        emit({ state: st === 'stale' ? 'stale-socket-removed' : st === 'absent' ? 'not-running' : 'unverifiable' }, st === 'stale' ? 'removed stale socket' : st === 'absent' ? 'not running' : 'endpoint cannot be verified; nothing touched');
        return st === 'stale' || st === 'absent' ? 0 : 1;
      }
    }
    await cancelHandoff(o.handoff, o.target, { dir: o.dir }); emit({ cancelled: true }, 'handoff cancelled'); return 0;
  } catch (e) { emit({ status: 'FAILED', code: e.code ?? 'FAILURE' }, `${e.code ?? 'FAILURE'}: ${typeof e.code === 'string' ? e.message : 'custodian command failed'}`); return 1; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
