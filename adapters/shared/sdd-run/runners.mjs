// Provider runners are INJECTABLE. dac never assumes a provider binary exists: nothing in this module runs at import time, and
// the production Codex runner is only spawned by `dac implement` / `dac review` after the trusted-terminal authorization.
// A runner is { id, role: 'implement'|'review', describe({network}) -> profile, run(args) -> Promise<{ result }> }.
//
// Whatever runner is injected, assertSafeProfile() enforces the same non-negotiable profile: explicit sandbox (workspace-write
// for implementation with approval on-request, read-only with approval never for review), no MCP, no network unless the task declared and the human
// authorized it, and none of the bypass flags.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../installer/lib/run.mjs';
import { RunError } from './git.mjs';

const BYPASS = /(dangerously-bypass|yolo|danger-full-access|full-auto|bypass)/i;

// The model is an OPAQUE user-selected value: no catalog, no normalization, no fallback. It only has to be a safe single argv word.
export const MODEL_MAX = 200;
export function validateModel(model) {
  if (model === undefined) return undefined;
  const bad = (why) => { throw new RunError('INPUT', `--model ${why}`); };
  if (typeof model !== 'string' || model.length === 0) bad('must be a non-empty value');
  if (model.length > MODEL_MAX) bad(`must be at most ${MODEL_MAX} characters`);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(model)) bad('must not contain control characters');
  if (model.startsWith('-')) bad('must not start with "-" (it would be read as an option)');
  if (model !== model.trim()) bad('must not have leading or trailing whitespace');
  return model;
}
export const modelSelection = (model) => (model === undefined ? { selection: 'inherited', value: null } : { selection: 'explicit', value: model });
export const modelLabel = (model) => (model === undefined ? 'inherited from the Codex configuration (no --model passed; availability is account-specific)' : `${model} (explicit --model; passed to Codex unchanged, no fallback)`);

export function assertSafeProfile(profile, role, network, model) {
  const bad = (why) => { throw new RunError('UNSAFE_PROFILE', `the ${role} runner profile is not allowed: ${why}`); };
  if (!profile || typeof profile !== 'object') bad('no profile');
  if (profile.role !== role) bad(`role must be "${role}"`);
  if (profile.sandbox !== (role === 'implement' ? 'workspace-write' : 'read-only')) bad(`sandbox must be ${role === 'implement' ? 'workspace-write' : 'read-only'}`);
  const approval = role === 'implement' ? 'on-request' : 'never';
  if (profile.approval !== approval) bad(`approval policy must be ${approval}`);
  if (profile.mcp !== 'none') bad('MCP servers are not allowed');
  if (profile.network !== (role === 'implement' ? network === true : false)) bad('network access must equal the authorized value (never for review)');
  if (profile.bypass !== false) bad('bypass must be explicitly false');
  if ((profile.model ?? null) !== (model ?? null)) bad('the runner profile must carry exactly the selected model (explicit value, or none when inherited)');
  if (!Array.isArray(profile.argv) || profile.argv.some((a, i) => typeof a !== 'string' || (BYPASS.test(a) && !(i > 0 && profile.argv[i - 1] === '--model' && a === model)))) bad('argv contains a bypass flag');
  return profile;
}

const CODEX_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'];
const cleanEnv = () => Object.fromEntries(CODEX_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

// Provider structured-output schema, DERIVED deterministically from the canonical standards/schemas/result.schema.json (the single
// semantic contract). Codex --output-schema cannot be assumed to resolve cross-file $ref, so references are inlined; $schema/$id/$defs/title
// are dropped; and, because provider strict mode requires every object property to be listed as required, optional properties become
// required (this only narrows what the provider may emit: every conforming output is still canonical-valid). The canonical validation
// (contractErrors) still runs on the extracted result, and nothing is ever repaired or injected.
export function deriveProviderResultSchema(schemaDir = join(REPO_ROOT, 'standards', 'schemas')) {
  const load = (f) => JSON.parse(readFileSync(join(schemaDir, f), 'utf8'));
  const files = { 'common.schema.json': load('common.schema.json') };
  const walk = (node, self) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, self));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const [file, ptr = ''] = node.$ref.split('#');
      const doc = file ? files[file] : self;
      const target = doc && ptr.split('/').filter(Boolean).reduce((d, k) => d?.[k], doc);
      if (!doc || target === undefined) throw new RunError('RUNNER', `cannot resolve schema reference ${node.$ref}`);
      return walk(target, doc);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) if (!['$schema', '$id', '$defs', 'title'].includes(k)) out[k] = walk(v, self);
    if (out.type === undefined && ('const' in out || Array.isArray(out.enum))) {
      // Provider strict mode requires an explicit type and rejects const: emit an enum (exact values kept) with a type derived from those values only.
      const values = 'const' in out ? [out.const] : out.enum;
      const jsonType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
      const types = [...new Set(values.map(jsonType))];
      // Fail closed: empty or mixed-type value sets are never converted, and a type array is never emitted.
      if (!values.length || types.length !== 1) throw new RunError('RUNNER', 'cannot derive a single provider type for a const/enum schema node');
      if ('const' in out) { delete out.const; out.enum = values; }
      out.type = types[0];
    }
    if (out.type === 'object' && out.properties) out.required = Object.keys(out.properties);
    return out;
  };
  const canonical = load('result.schema.json');
  return walk(canonical, canonical);
}

// Extracts the one JSON object from a provider's last message (tolerates a fenced block).
export function parseResult(text) {
  const t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1] : t;
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// Safe, bounded causal excerpt of provider output: control characters removed, common secret forms redacted, capped by lines and bytes.
const SECRET_RES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED]'],
  [/(:\/\/)[^\s\/:@]+:[^\s\/@]+@/g, '$1[REDACTED]@'],
  [/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|authorization|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]'],
  [/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]'],
];
const CAUSE_LINE = /error|unsupported|not supported|invalid|denied|unauthori[sz]ed|forbidden|fail|exceed|not found|refus|quota|limit|model/i;
export function safeExcerpt(text, { maxLines = 8, maxLineChars = 240, maxBytes = 1024 } = {}) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const [re, to] of SECRET_RES) t = t.replace(re, to);
  t = t.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/(?!\n)[\p{Cc}\p{Zl}\p{Zp}]/gu, '');
  const all = t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.length > maxLineChars ? `${l.slice(0, maxLineChars)}...` : l));
  const causal = all.filter((l) => CAUSE_LINE.test(l));
  let out = (causal.length ? causal.slice(-maxLines) : all.slice(-maxLines)).join('\n');
  if (Buffer.byteLength(out) > maxBytes) out = `${Buffer.from(out).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '')}...`;
  return out;
}
export function describeRunnerFailure({ spawnError, status, signal, stderr, transcript, model }) {
  const head = spawnError ? `codex could not run (${spawnError.code ?? 'spawn error'})` : signal ? `codex was terminated by signal ${signal}` : `codex exited with ${status}`;
  const detail = spawnError ? safeExcerpt(spawnError.message) : safeExcerpt(stderr);
  const cause = detail || (spawnError ? 'no detail was reported by the spawn error' : 'codex reported nothing on stderr; see the transcript');
  const hint = model !== undefined ? `Model "${model}" was passed explicitly via --model; dac never substitutes another model.` : 'No --model was passed: the model was inherited from the Codex configuration.';
  return `${head}. Cause (bounded, redacted excerpt):\n${cause.split('\n').map((l) => `    ${l}`).join('\n')}\n  ${hint} Full transcript: ${transcript}`;
}

// Production Codex runner. The argv below is a DOCUMENTED PROFILE that has NOT been verified against a real Codex binary
// (this repository never probes providers); it is shown to the human, bound into the authorization, and must be confirmed
// during the real-Codex pilot. It uses explicit CLI overrides only: installed configs are never modified.
export function codexRunner(role, { bin = process.env.DAC_CODEX_BIN || 'codex', spawn = spawnSync, timeoutMs = 30 * 60 * 1000 } = {}) {
  const implement = role === 'implement';
  const describe = ({ network = false, model } = {}) => ({
    id: implement ? 'codex-exec-implement' : 'codex-exec-review', role, provider: 'codex', verified_against_real_binary: false, model: validateModel(model) ?? null, model_source: model === undefined ? 'inherited' : 'explicit',
    sandbox: implement ? 'workspace-write' : 'read-only', approval: implement ? 'on-request' : 'never', mcp: 'none', network: implement ? network === true : false, bypass: false,
    argv: ['exec', ...(model === undefined ? [] : ['--model', model]), '--sandbox', implement ? 'workspace-write' : 'read-only', '--cd', '<worktree>', '-c', `approval_policy="${implement ? 'on-request' : 'never'}"`, '-c', 'mcp_servers={}',
      ...(implement ? ['-c', `sandbox_workspace_write.network_access=${network === true}`] : []), '--output-schema', '<schema-file>', '--output-last-message', '<result-file>', '-'],
  });
  return {
    id: describe().id, role, describe,
    async run({ cwd, prompt, runDir, network, model }) {
      const profile = describe({ network, model });
      // Earlier attempts' files (e.g. a failed review being retried on the same run) are evidence: never overwritten, never reused.
      let n = 1; const names = () => [`${role}-last-message`, `${role}-output-schema`, `${role}-transcript`].map((b, i) => `${n === 1 ? b : `${b}-${n}`}${i === 1 ? '.json' : '.txt'}`);
      while (names().some((f) => existsSync(join(runDir, f)))) n += 1;
      const [resultName, schemaName, transcriptName] = names();
      const resultFile = join(runDir, resultName);
      writeFileSync(resultFile, '', { flag: 'wx', mode: 0o600 });
      const schemaFile = join(runDir, schemaName);
      writeFileSync(schemaFile, `${JSON.stringify(deriveProviderResultSchema(), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      const argv = profile.argv.map((a) => (a === '<worktree>' ? cwd : a === '<result-file>' ? resultFile : a === '<schema-file>' ? schemaFile : a));
      const r = spawn(bin, argv, { cwd, input: prompt, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false });
      const transcript = join(runDir, transcriptName);
      writeFileSync(transcript, `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`, { flag: 'wx', mode: 0o600 });
      if (r.error || r.status !== 0) throw new RunError('RUNNER', describeRunnerFailure({ spawnError: r.error, status: r.status, signal: r.signal, stderr: r.stderr, transcript, model }));
      return { result: parseResult(readFileSync(resultFile, 'utf8')) };
    },
  };
}
