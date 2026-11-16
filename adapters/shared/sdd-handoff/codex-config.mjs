// Pure, portable generator of the Codex SDD-handoff integration (writes nothing; consumed by the shared portable generator, whose output
// goes through the existing createInstaller / executeActions journal, manifest and ownership machinery).
//
// It reuses, unchanged, the runtime that Claude Code already installs: the stateless submit-only MCP proxy under .dac/runtime/sdd-handoff
// (see claude-config.mjs runtimeFiles), the independent human-started custodian and the Writer. Nothing here is a second broker or writer.
//
// Native Codex project configuration (`.codex/config.toml`, table `[mcp_servers.<name>]`; same table the Context7 template already uses):
//  - command/args : launched with the project root as working directory; the target is the fixed `.`; the runtime directory comes from the
//                   operator's environment variable DAC_SDD_RUNTIME_DIR (forwarded by `env_vars`; Codex does not expand variables in `args`,
//                   so a fixed `sh -c` launcher with a quoted expansion is the only indirection). Never a model/tool argument. If the variable
//                   is unset the proxy receives an empty --runtime-dir and refuses to start (fail closed).
//  - enabled_tools: exactly ["sdd_handoff_submit"], so even a future second tool in the proxy would not be exposed.
// The launcher is the MCP server's start command, not a model-facing tool: `[features] shell_tool = false`, `sandbox_mode = "read-only"` and
// `approval_policy = "never"` in the same file are unchanged, and no tool other than the single submit tool is granted.
// Runtime compatibility with a real Codex session is UNVERIFIED (see docs/sdd-input-handoff.md).
import { SERVER_NAME, RUNTIME_DIR, RUNTIME_DIR_ENV, HANDOFF_AGENTS } from './claude-config.mjs';

export { SERVER_NAME, RUNTIME_DIR, RUNTIME_DIR_ENV, HANDOFF_AGENTS };
export const CODEX_TOOL = 'sdd_handoff_submit';
export const CODEX_CONFIG_PATH = '.codex/config.toml';

const q = (s) => JSON.stringify(s); // JSON strings are valid TOML basic strings for this ASCII content

export const LAUNCH = Object.freeze({
  command: 'sh',
  args: Object.freeze(['-c', `exec node ${RUNTIME_DIR}/mcp-server.mjs --target . --runtime-dir "$${RUNTIME_DIR_ENV}"`]),
});

export function codexServerToml() {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(LAUNCH.command)}`,
    `args = [${LAUNCH.args.map(q).join(', ')}]`,
    `env_vars = [${q(RUNTIME_DIR_ENV)}]`,
    'enabled = true',
    `enabled_tools = [${q(CODEX_TOOL)}]`,
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
  const tables = [...config.matchAll(/^\[mcp_servers\.([^\]\s]+)\]$/gm)].map((m) => m[1]).sort();
  if (JSON.stringify(tables) !== JSON.stringify(context7 ? ['context7', SERVER_NAME] : [SERVER_NAME])) bad('unexpected MCP server tables');
  if (!config.includes(codexServerToml())) bad('handoff MCP server entry is not the canonical entry');
  if (!/^sandbox_mode = "read-only"$/m.test(config) || !/^approval_policy = "never"$/m.test(config) || !/^shell_tool = false$/m.test(config)) bad('read-only defaults must stay in place');
  if (/\/(Users|home)\/|^\s*(tools|allowed_tools)\s*=/im.test(config)) bad('config must be portable and must not widen permissions');
}
