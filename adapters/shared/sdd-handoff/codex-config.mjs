// Pure, portable generator of the Codex SDD-handoff integration (writes nothing; consumed by the shared portable generator, whose output
// goes through the existing createInstaller / executeActions journal, manifest and ownership machinery).
//
// It reuses, unchanged, the runtime that Claude Code already installs: the stateless submit-only MCP proxy under .dac/runtime/sdd-handoff
// (see claude-config.mjs runtimeFiles), the independent human-started custodian and the Writer. Nothing here is a second broker or writer.
//
// Native Codex project configuration (`.codex/config.toml`, table `[mcp_servers.<name>]`; same table the Context7 template already uses):
//  - command/args : `node` runs the installed proxy directly (no shell launcher), with the project root as working directory and the fixed
//                   target `.`. The endpoint is derived automatically from platform + uid, identical to the custodian's and the Writer's;
//                   there is no environment variable, no runtime-dir argument and nothing a model/tool argument could alter.
//  - enabled_tools: exactly ["sdd_handoff_submit"], so even a future second tool in the proxy would not be exposed.
// - per-tool table `[mcp_servers.dac-sdd-handoff.tools.sdd_handoff_submit]` with `approval_mode = "approve"`: the only approval_mode allowed, scoped to
//   this one tool (the proxy only submits to the in-memory custodian; human approval stays on the trusted TTY). It is NOT a global approval change.
//   The tool advertises no MCP annotations (kept truthful). Real Codex acceptance and the minimum Codex version supporting it are UNVERIFIED.
// `[features] shell_tool = false`, `sandbox_mode = "read-only"` and `approval_policy = "never"` in the same file are unchanged, and no tool
// other than the single submit tool is granted.
// Runtime compatibility with a real Codex session is UNVERIFIED (see docs/sdd-input-handoff.md).
import { SERVER_NAME, RUNTIME_DIR, HANDOFF_AGENTS } from './claude-config.mjs';

export { SERVER_NAME, RUNTIME_DIR, HANDOFF_AGENTS };
export const CODEX_TOOL = 'sdd_handoff_submit';
export const CODEX_CONFIG_PATH = '.codex/config.toml';

const q = (s) => JSON.stringify(s); // JSON strings are valid TOML basic strings for this ASCII content

export const LAUNCH = Object.freeze({
  command: 'node',
  args: Object.freeze([`${RUNTIME_DIR}/mcp-server.mjs`, '--target', '.']),
});

export function codexServerToml() {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(LAUNCH.command)}`,
    `args = [${LAUNCH.args.map(q).join(', ')}]`,
    'enabled = true',
    `enabled_tools = [${q(CODEX_TOOL)}]`,
    '',
    `[mcp_servers.${SERVER_NAME}.tools.${CODEX_TOOL}]`,
    'approval_mode = "approve"',
    '',
  ].join('\n');
}

// Appended to the SDD-producing role's developer instructions (Codex agent file only; the neutral AGENTS.md shared with Cursor is untouched).
export function handoffInstructions() {
  return [
    '',
    '## SDD handoff (generated)',
    '',
    `- \`${CODEX_TOOL}\` only submits a validated Constitution/Specify envelope to the human-started in-memory custodian; it writes nothing and has no apply or target argument.`,
    '- Report the returned handoff_id, plan_digest and human_commands to the human; never run, paraphrase or auto-confirm them. Approval happens only on the human terminal.',
    '- If the tool is unavailable or the custodian is not running, stop and report BLOCKED; do not write files or use another route.',
    '',
  ].join('\n');
}

// Postcondition on the generated config text: exactly one MCP server table, the fixed launcher, one exposed tool, read-only defaults intact.
export function assertCodexHandoffConfig(config, { context7 = false } = {}) {
  const bad = (m) => { throw Object.assign(new Error(m), { code: 'PERMISSION_EXCEEDS_CANONICAL' }); };
  const tables = [...config.matchAll(/^\[mcp_servers\.([^\].\s]+)\]$/gm)].map((m) => m[1]).sort();
  if (JSON.stringify(tables) !== JSON.stringify(context7 ? ['context7', SERVER_NAME] : [SERVER_NAME])) bad('unexpected MCP server tables');
  if (!config.includes(codexServerToml())) bad('handoff MCP server entry is not the canonical entry');
  if (!/^sandbox_mode = "read-only"$/m.test(config) || !/^approval_policy = "never"$/m.test(config) || !/^shell_tool = false$/m.test(config)) bad('read-only defaults must stay in place');
  const toolTables = [...config.matchAll(/^\[mcp_servers\.[^\]]*\.tools\.[^\]]*\]\s*$/gm)].map((m) => m[0].trim());
  if (toolTables.length !== 1 || toolTables[0] !== `[mcp_servers.${SERVER_NAME}.tools.${CODEX_TOOL}]`) bad('only the exact per-tool table for the submit tool is allowed');
  if ((config.match(/^\s*approval_mode\b/gm) || []).length !== 1 || /^\s*(auto_approve|approve_all)\b/im.test(config)) bad('approval_mode is allowed only once, inside the submit tool table');
  if (/\/(Users|home)\/|^\s*(tools|allowed_tools)\s*=/im.test(config)) bad('config must be portable and must not widen permissions');
}
