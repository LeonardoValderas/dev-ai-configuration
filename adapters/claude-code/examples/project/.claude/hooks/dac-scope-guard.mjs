#!/usr/bin/env node
// Generated-project PreToolUse guard (dev-ai-configuration, Claude Code adapter).
// Fail-closed: anything not explicitly granted by .claude/hooks/dac-scopes.json
// is denied. A denial is final: the caller must report BLOCKED and must not hand
// the work to any other executor. Node built-ins only; never touches the network.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const globToRegExp = (glob) =>
  new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');

// Resolve symlinks of the deepest existing ancestor so a link cannot escape the project.
function realish(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
}

const deny = (reason) => ({ decision: 'deny', reason: `BLOCKED: ${reason} Report execution_status BLOCKED; do not hand this task to any other executor.` });

export function decide(input, scopes, agentId, env = {}) {
  const agent = scopes?.agents?.[agentId];
  if (!agent) return deny(`unknown agent "${agentId}".`);
  const tool = input?.tool_name;
  if (typeof tool !== 'string') return deny('missing tool name.');
  if (!agent.tools.includes(tool)) return deny(`tool "${tool}" is not granted to ${agentId}.`);
  if (!WRITE_TOOLS.has(tool)) return { decision: 'allow' };
  if (agent.read_only || !agent.writable_paths?.length) return deny(`${agentId} is read-only.`);
  const ti = input.tool_input ?? {};
  const file = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof file !== 'string' || file === '') return deny('no target path supplied.');
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd;
  if (typeof projectDir !== 'string' || !isAbsolute(projectDir)) return deny('project directory is unknown.');
  const root = realish(projectDir);
  const target = realish(resolve(projectDir, file));
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return deny(`path is outside the project or is the project root.`);
  const posix = rel.split(sep).join('/');
  if (!agent.writable_paths.some((g) => globToRegExp(g).test(posix))) return deny(`path "${posix}" is outside the writable paths of ${agentId}.`);
  return { decision: 'allow' };
}

function main() {
  const agentId = process.argv[2];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const scopes = JSON.parse(readFileSync(join(here, 'dac-scopes.json'), 'utf8'));
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const r = decide(input, scopes, agentId, process.env);
    if (r.decision === 'deny') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } }) + '\n');
    }
    process.exit(0);
  } catch {
    process.stderr.write('BLOCKED: permission guard could not evaluate the request. Do not hand this task to any other executor.\n');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
