// Pure, portable generator of the Claude Code SDD-handoff integration (writes nothing; consumed by the claude-code adapter generator,
// which hands the result to the existing createInstaller/executeActions journal, manifest and ownership machinery).
//
// Everything distributed is project-relative or an environment reference: no machine-specific path is ever generated.
//  - runtime files: .dac/runtime/sdd-handoff/*.mjs  (the stateless submit-only MCP proxy and its five dependency-free helpers)
//  - .mcp.json    : server command `node .dac/runtime/sdd-handoff/mcp-server.mjs --target .`
//                   (Claude Code launches project servers from the project root. No environment variable and no runtime-dir argument: the
//                   proxy derives the same private endpoint as the custodian and the Writer from platform + uid; see endpoint.mjs.)
//  - settings     : the single submit-tool permission and the project-server enablement; no Write/Edit/Bash grant, no apply tool.
// The custodian and the writer are human-operated tools that run from the standards checkout (they need its schemas and Git source
// gate); they are deliberately NOT installed into the project.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'dac-sdd-handoff';
export const TOOL_PERMISSION = `mcp__${SERVER_NAME}__sdd_handoff_submit`;
export const RUNTIME_DIR = '.dac/runtime/sdd-handoff';
// Claude agents that produce the SDD Specify artifact and may submit it (code-reviewer and every implementer are excluded).
export const HANDOFF_AGENTS = Object.freeze(['technical-planner']);

// installed name -> source file in this directory
const RUNTIME_SOURCES = Object.freeze({
  'mcp-server.mjs': 'mcp-server.mjs',
  'client.mjs': 'client.mjs',
  'endpoint.mjs': 'endpoint.mjs',
  'core.mjs': 'core.mjs',
  'errors.mjs': 'errors.mjs',
  'identity.mjs': 'identity-portable.mjs',
});

export function runtimeFiles() {
  const out = new Map();
  for (const [installed, source] of Object.entries(RUNTIME_SOURCES)) out.set(`${RUNTIME_DIR}/${installed}`, readFileSync(fileURLToPath(new URL(`./${source}`, import.meta.url))));
  return out;
}

export function mcpServerEntry() {
  return { command: 'node', args: [`${RUNTIME_DIR}/mcp-server.mjs`, '--target', '.'] };
}
