#!/usr/bin/env node
// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited) exposing exactly one tool: sdd_handoff_submit.
// The target is fixed by startup config (--target <dir>); the endpoint directory is resolved automatically from platform + uid
// (endpoint.mjs), identical to the custodian's and the Writer's. Neither is a tool argument nor read from the environment/TMPDIR/cwd.
// `--runtime-dir <abs>` is an optional advanced/test override (never generated).
// STATELESS PROXY to the independent, human-started custodian (handoffs outlive this process). There is no apply tool: approval and
// writing happen only in the writer CLI, on the human's /dev/tty. Payload is untrusted data: only parsed as JSON
// and validated by the existing writer plan(); nothing from it is executed or interpolated into commands.
import { realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { submitHandoff } from './client.mjs';
import { resolveRuntimeDir } from './endpoint.mjs';
import { targetIdentity } from './identity.mjs';
import { HandoffError, MAX_ENVELOPE_BYTES } from './core.mjs';
import { sanitizeErrors } from './errors.mjs';

export const TOOL_NAME = 'sdd_handoff_submit';
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = MAX_ENVELOPE_BYTES + 64 * 1024;
// Two layouts, one source: in the standards checkout the writer/custodian CLIs are siblings and are printed as absolute paths;
// in the project-installed copy (.dac/runtime/sdd-handoff/) they do not exist and the human commands use the <DAC_CHECKOUT> placeholder
// (the human substitutes the path of their standards checkout; nothing machine-specific is ever distributed).
const sibling = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const IN_CHECKOUT = existsSync(sibling('../sdd-writer/cli.mjs')) && existsSync(sibling('./custodian-cli.mjs'));
const CLI = IN_CHECKOUT ? resolve(sibling('../sdd-writer/cli.mjs')) : '<DAC_CHECKOUT>/adapters/shared/sdd-writer/cli.mjs';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: 'Submit an SDD Constitution and/or Specify envelope to the human-started in-memory handoff custodian (validated by the existing writer plan). Returns an opaque handoff_id and the plan digest. Writes nothing; a human must run the writer CLI and approve on the terminal.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['project_id', 'operation'],
    properties: {
      project_id: { type: 'string', description: 'Project id (lowercase kebab-case, max 64 chars).' },
      operation: { type: 'string', enum: ['create', 'update'] },
      markdown: { type: 'boolean', description: 'Also render derived Markdown.' },
      constitution: { type: 'object', description: 'sdd-constitution artifact.' },
      specify: { type: 'object', description: 'sdd-specify artifact.' },
    },
  },
});

const textResult = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError });

const KEYS = new Set(Object.keys(TOOL.inputSchema.properties));
const SERVER = IN_CHECKOUT ? sibling('./custodian-cli.mjs') : '<DAC_CHECKOUT>/adapters/shared/sdd-handoff/custodian-cli.mjs';

// Stateless proxy: no store, no persistent connection, nothing retained between calls. Every call derives the endpoint
// from the fixed target and forwards to the human-started custodian, which validates (existing writer plan()) and holds.
export function createServer({ target, runtimeDir, submit = submitHandoff }) {
  const dir = resolveRuntimeDir(runtimeDir); // automatic unless an explicit override was configured
  const rt = runtimeDir === undefined ? '' : ` --runtime-dir ${shq(dir)}`; // human commands carry the override only when one is in use
  const targetPath = targetIdentity(target).realpath; // fixed by startup config; never a tool argument

  async function doSubmit(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HandoffError('INPUT', 'arguments must be an object');
    for (const k of Object.keys(args)) if (!KEYS.has(k)) throw new HandoffError('INPUT', `unknown field: ${k}`);
    let size; try { size = Buffer.byteLength(JSON.stringify(args)); } catch { throw new HandoffError('INPUT', 'arguments are not serializable'); }
    if (size > MAX_ENVELOPE_BYTES) throw new HandoffError('HANDOFF_TOO_LARGE', `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
    let h;
    try { h = await submit(targetPath, JSON.parse(JSON.stringify(args)), { dir }); } catch (e) {
      if (e?.code === 'HANDOFF_UNAVAILABLE') { const x = new HandoffError('CUSTODIAN_UNAVAILABLE', `no handoff custodian is running for this target; the human must start it: node ${shq(SERVER)} start --target ${shq(targetPath)}${rt}`); throw x; }
      throw e;
    }
    return {
      handoff_id: h.handoff_id, status: h.status, plan_digest: h.plan_digest, would_write: h.would_write, files_changed: [],
      expires_at: h.expires_at,
      // Built only from the fixed target and the opaque id; never from payload text.
      human_commands: { plan: `node ${shq(CLI)} plan --target ${shq(targetPath)}${rt} --handoff ${h.handoff_id}`, apply: `node ${shq(CLI)} apply --target ${shq(targetPath)}${rt} --handoff ${h.handoff_id}` },
      note: 'Not approved. Writing requires the human to run the apply command and confirm on the terminal.',
    };
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const isNote = id === undefined;
    const ok = (result) => (isNote ? null : { jsonrpc: '2.0', id, result });
    const err = (code, message) => (isNote ? null : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const want = params?.protocolVersion;
        return ok({ protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dac-sdd-handoff', version: '0.1.0' } });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: [TOOL] });
      case 'tools/call': {
        if (params?.name !== TOOL_NAME) return err(-32602, 'unknown tool');
        try { return ok(textResult(await doSubmit(params.arguments ?? {}))); } catch (e) {
          const known = typeof e?.code === 'string';
          return ok(textResult({ status: 'REJECTED', code: known ? e.code : 'FAILURE', message: known ? e.message : 'submit failed', ...(e.details?.errors ? { errors: sanitizeErrors(e.details.errors) } : {}), files_changed: [] }, true));
        }
      }
      default:
        if (isNote || method?.startsWith('notifications/')) return null;
        return err(-32601, 'method not found');
    }
  }
  return { handle, target: targetPath };
}

export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  let buf = '';
  input.setEncoding('utf8');
  const send = (o) => { if (o) output.write(JSON.stringify(o) + '\n'); };
  input.on('data', async (chunk) => {
    buf += chunk;
    if (buf.length > MAX_LINE * 2 && buf.indexOf('\n') < 0) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message too large' } }); buf = ''; return; }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.length > MAX_LINE) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'message too large' } }); continue; }
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') { send({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } }); continue; }
      try { send(await server.handle(msg)); } catch { send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'internal error' } }); }
    }
  });
}

async function main(argv) {
  let target; let runtimeDir; const usage = 'Usage: mcp-server.mjs --target <dir> [--runtime-dir <absolute dir>]';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1] && target === undefined) target = resolve(argv[++i]);
    else if (argv[i] === '--runtime-dir' && argv[i + 1] && runtimeDir === undefined) runtimeDir = argv[++i];
    else { console.error(usage); return 2; }
  }
  if (!target) { console.error(usage); return 2; }
  let server;
  try { server = await createServer({ target, runtimeDir }); } catch (e) { console.error(`sdd-handoff: cannot start (${e.code ?? 'FAILURE'}: ${e.message})`); return 1; }
  const shutdown = () => process.exit(0); // nothing to clean: the proxy holds no state; handoffs live in the custodian
  process.stdin.on('end', shutdown); process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); process.on('SIGHUP', shutdown);
  serveStdio(server);
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
