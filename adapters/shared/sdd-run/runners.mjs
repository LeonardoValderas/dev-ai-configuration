// Provider runners are INJECTABLE. dac never assumes a provider binary exists: nothing in this module runs at import time, and
// the production Codex runner is only spawned by `dac implement` / `dac review` after the trusted-terminal authorization.
// A runner is { id, role: 'implement'|'review', describe({network}) -> profile, run(args) -> Promise<{ result }> }.
//
// Whatever runner is injected, assertSafeProfile() enforces the same non-negotiable profile: explicit sandbox (workspace-write
// for implementation with approval on-request, read-only with approval never for review), no MCP, no network unless the task declared and the human
// authorized it, and none of the bypass flags.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunError } from './git.mjs';

const BYPASS = /(dangerously-bypass|yolo|danger-full-access|full-auto|bypass)/i;

export function assertSafeProfile(profile, role, network) {
  const bad = (why) => { throw new RunError('UNSAFE_PROFILE', `the ${role} runner profile is not allowed: ${why}`); };
  if (!profile || typeof profile !== 'object') bad('no profile');
  if (profile.role !== role) bad(`role must be "${role}"`);
  if (profile.sandbox !== (role === 'implement' ? 'workspace-write' : 'read-only')) bad(`sandbox must be ${role === 'implement' ? 'workspace-write' : 'read-only'}`);
  const approval = role === 'implement' ? 'on-request' : 'never';
  if (profile.approval !== approval) bad(`approval policy must be ${approval}`);
  if (profile.mcp !== 'none') bad('MCP servers are not allowed');
  if (profile.network !== (role === 'implement' ? network === true : false)) bad('network access must equal the authorized value (never for review)');
  if (profile.bypass !== false) bad('bypass must be explicitly false');
  if (!Array.isArray(profile.argv) || profile.argv.some((a) => typeof a !== 'string' || BYPASS.test(a))) bad('argv contains a bypass flag');
  return profile;
}

const CODEX_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'];
const cleanEnv = () => Object.fromEntries(CODEX_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

// Extracts the one JSON object from a provider's last message (tolerates a fenced block).
export function parseResult(text) {
  const t = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1] : t;
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

// Production Codex runner. The argv below is a DOCUMENTED PROFILE that has NOT been verified against a real Codex binary
// (this repository never probes providers); it is shown to the human, bound into the authorization, and must be confirmed
// during the real-Codex pilot. It uses explicit CLI overrides only: installed configs are never modified.
export function codexRunner(role, { bin = process.env.DAC_CODEX_BIN || 'codex', spawn = spawnSync, timeoutMs = 30 * 60 * 1000 } = {}) {
  const implement = role === 'implement';
  const describe = ({ network = false } = {}) => ({
    id: implement ? 'codex-exec-implement' : 'codex-exec-review', role, provider: 'codex', verified_against_real_binary: false,
    sandbox: implement ? 'workspace-write' : 'read-only', approval: implement ? 'on-request' : 'never', mcp: 'none', network: implement ? network === true : false, bypass: false,
    argv: ['exec', '--sandbox', implement ? 'workspace-write' : 'read-only', '--cd', '<worktree>', '-c', `approval_policy="${implement ? 'on-request' : 'never'}"`, '-c', 'mcp_servers={}',
      ...(implement ? ['-c', `sandbox_workspace_write.network_access=${network === true}`] : []), '--output-last-message', '<result-file>', '-'],
  });
  return {
    id: describe().id, role, describe,
    async run({ cwd, prompt, runDir, network }) {
      const profile = describe({ network });
      const resultFile = join(runDir, `${role}-last-message.txt`);
      writeFileSync(resultFile, '', { flag: 'wx', mode: 0o600 });
      const argv = profile.argv.map((a) => (a === '<worktree>' ? cwd : a === '<result-file>' ? resultFile : a));
      const r = spawn(bin, argv, { cwd, input: prompt, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: false });
      writeFileSync(join(runDir, `${role}-transcript.txt`), `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`, { flag: 'wx', mode: 0o600 });
      if (r.error || r.status !== 0) throw new RunError('RUNNER', `codex exited with ${r.error?.code ?? r.status}`);
      return { result: parseResult(readFileSync(resultFile, 'utf8')) };
    },
  };
}
