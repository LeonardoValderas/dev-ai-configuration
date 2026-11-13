// Pure generator: canonical manifests -> Claude Code project-scoped files.
// Reads only inside this repository; writes nothing (see apply.mjs).
// Output is deterministic (no timestamps, sorted keys/paths).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO_ROOT, DEFAULT_INPUTS, validatePaths } from '../../../installer/lib/run.mjs';

export const ADAPTER_ID = 'claude-code';
export const MANIFEST_PATH = '.claude/dac-manifest.json';
const STD = join(REPO_ROOT, 'standards');
const MANIFESTS = join(STD, 'manifests');
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const KNOWN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
const MODE_RANK = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
const CONTEXT7_SERVER = 'context7';

export class AdapterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readText = (p) => readFileSync(p, 'utf8');
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- frontmatter -----------------------------------------------------------
// Values are plain strings (tools lists) or JSON (YAML flow subset).
export function renderFrontmatter(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === 'string' && /^[A-Za-z][A-Za-z0-9 ,_-]*$/.test(v) ? v : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    if (i < 1) throw new AdapterError('FRONTMATTER', `unparseable frontmatter line: ${line}`);
    const k = line.slice(0, i);
    const raw = line.slice(i + 2);
    out[k] = /^["{[]/.test(raw) ? JSON.parse(raw) : raw;
  }
  return out;
}
export const splitList = (s) => (typeof s === 'string' && s !== '' ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

// ---- selection -------------------------------------------------------------
function loadCanonical() {
  const { errors } = validatePaths(DEFAULT_INPUTS);
  if (errors.length) throw new AdapterError('CANONICAL_INVALID', `canonical standards failed validation (${errors.length} error(s)); run npm run validate`);
  const agentCatalog = readJson(join(MANIFESTS, 'agents', 'agent-catalog.json'));
  const skillCatalog = readJson(join(MANIFESTS, 'skills', 'skill-catalog.json'));
  return {
    agentCatalog, skillCatalog,
    workflow: readJson(join(STD, 'sdd', 'sdd-workflow.json')),
    agentMap: readJson(join(STD, 'sdd', 'sdd-agent-map.json')),
    context7: readJson(join(MANIFESTS, 'mcp', 'context7.json')),
    template: readJson(join(MANIFESTS, 'mcp', 'templates', 'claude-code.json')),
  };
}

export function selectAgents(agentCatalog, optionalAgents = []) {
  const byId = new Map(agentCatalog.agents.map((e) => [e.id, e]));
  const ids = agentCatalog.agents.filter((e) => e.classification === 'primary').map((e) => e.id);
  if (ids.length !== 8) throw new AdapterError('SELECTION', 'catalog must list exactly 8 primary agents');
  ids.push('code-reviewer');
  if (byId.get('code-reviewer')?.classification === 'redundant') throw new AdapterError('SELECTION', 'code-reviewer must not be redundant');
  for (const id of optionalAgents) {
    const e = byId.get(id);
    if (!e || e.classification !== 'optional') throw new AdapterError('SELECTION', `"${id}" is not an optional catalog agent`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function selectSkills(skillCatalog) {
  const core = skillCatalog.skills.filter((s) => s.classification === 'CORE').map((s) => s.id).sort();
  if (core.length !== 2 || core.length !== skillCatalog.expected.core) throw new AdapterError('SELECTION', 'catalog must list exactly two CORE skills');
  return core;
}

// ---- agents ----------------------------------------------------------------
function buildAgent(id) {
  const dir = join(MANIFESTS, 'agents');
  const m = readJson(join(dir, `${id}.json`));
  const instructions = readText(join(dir, m.instructions_path)).replace(/\s+$/, '');
  const p = m.permissions;
  for (const t of p.tools) if (!KNOWN_TOOLS.has(t)) throw new AdapterError('UNMAPPED_TOOL', `agent "${id}" tool "${t}" has no Claude Code mapping`);
  if (!(p.permission_mode in MODE_RANK) || p.permission_mode === 'bypassPermissions') throw new AdapterError('UNSAFE_MODE', `agent "${id}" permission_mode is not allowed`);
  const tools = [...p.tools];
  const readOnly = m.read_only === true;
  // Shell commands are never granted: Claude Code subagent tool lists cannot scope Bash to
  // an exact command allow-list, so the adapter fails closed rather than exceed the manifest.
  const disallowed = readOnly ? ['Bash', ...WRITE_TOOLS] : ['Bash', 'NotebookEdit'];
  const fields = {
    name: m.id,
    description: `${m.description} Use when: ${(m.activation ?? []).join('; ')}.`,
    tools: tools.join(', '),
    disallowedTools: disallowed.join(', '),
    permissionMode: p.permission_mode,
  };
  const writable = readOnly ? [] : [...(p.writable_paths ?? [])];
  if (!readOnly && p.tools.some((t) => WRITE_TOOLS.includes(t))) {
    fields.hooks = { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/dac-scope-guard.mjs" ${m.id}` }] }] };
  }
  const shell = p.shell_commands ?? [];
  const body = [
    `<!-- Generated by dev-ai-configuration claude-code adapter from agent ${m.id}@${m.version}. Do not edit; regenerate instead. -->`,
    '',
    instructions,
    '',
    '## Claude Code enforcement (generated)',
    '',
    `- Granted tools: ${tools.join(', ')}.`,
    `- Denied tools: ${disallowed.join(', ')}.`,
    `- Permission mode: ${p.permission_mode}.`,
    readOnly ? '- Read-only: this agent cannot write, edit or run shell commands.' : `- Writable paths: ${writable.join(', ')} (enforced by the project scope guard hook).`,
    shell.length ? `- Shell: not granted in Claude Code, so the canonical shell commands (${shell.join('; ')}) are not available to this agent; ask the orchestrator for command evidence.` : '- Shell: not granted.',
    '- Production access: none.',
    '',
    '## Permission denial',
    '',
    'If a tool call or path is denied, stop that action and report execution_status BLOCKED with the denied action as an unresolved blocker. A denial is final: do not retry it by another route and do not hand the work to any other executor or agent.',
    '',
  ].join('\n');
  return {
    file: `.claude/agents/${m.id}.md`,
    content: renderFrontmatter(fields) + '\n' + body,
    meta: { id: m.id, read_only: readOnly, tools, writable_paths: writable, permission_mode: p.permission_mode },
  };
}

// ---- skills ----------------------------------------------------------------
function buildSkill(id) {
  const dir = join(MANIFESTS, 'skills');
  const m = readJson(join(dir, `${id}.json`));
  if (m.auto_enable !== false) throw new AdapterError('SKILL_AUTO_ENABLE', `skill "${id}" must not auto-enable`);
  if ((m.dependencies?.external_services ?? []).length || m.requires_mcp?.length) throw new AdapterError('SKILL_EXTERNAL', `skill "${id}" depends on external services`);
  const out = [];
  const base = `.claude/skills/${id}`;
  // Guidance only: invoked explicitly (never model-triggered); no allowed-tools grant.
  const fm = renderFrontmatter({ name: id, description: m.description, 'disable-model-invocation': true });
  out.push({ file: `${base}/SKILL.md`, content: Buffer.from(`${fm}\n<!-- Generated from skill ${id}@${m.version}. Do not edit. -->\n\n${readText(join(dir, m.instructions_path)).replace(/\s+$/, '')}\n`) });
  const extras = [...(m.reference_paths ?? []), m.license?.notice_path, m.license?.license_path].filter(Boolean);
  for (const rel of [...new Set(extras)].sort()) out.push({ file: `${base}/${rel}`, content: readFileSync(join(dir, rel)) });
  return out;
}

// ---- rules -----------------------------------------------------------------
function buildContractsRule() {
  return [
    '<!-- Generated by dev-ai-configuration claude-code adapter. Do not edit. -->',
    '# Task, result and restriction contracts',
    '',
    'Delegated work uses the canonical contracts (schemas in `.claude/dac/contracts/`).',
    '',
    '- Task contract: objective, verified_context, allowed_paths, prohibited_paths, constraints, authorized_tools, acceptance_criteria, required_evidence, validation_commands, rollback.',
    '- Restrictions: work only inside `allowed_paths` and `authorized_tools`; honor `prohibited_paths` and `constraints`. Without a task contract, stop and ask for one.',
    '- Result: execution_status (COMPLETE | PARTIAL | BLOCKED), validation_result (PASS | FAIL | BLOCKED), files_changed, evidence, warnings, unresolved_blockers.',
    '- Never report a check as passed unless it was actually executed.',
    '',
    '## Denied permissions',
    '',
    '- A denied tool, path or permission is final: report execution_status BLOCKED and validation_result BLOCKED, list the denial in unresolved_blockers, and stop.',
    '- Do not retry the denied action another way and do not hand the work to any other executor, agent or tool. The user decides what happens next.',
    '',
  ].join('\n');
}

function buildSddRule({ workflow, agentMap }) {
  const phases = new Map(workflow.phases.map((p) => [p.id, p]));
  const lines = [
    '<!-- Generated by dev-ai-configuration claude-code adapter from the canonical SDD workflow. Do not edit. -->',
    '# Spec-Driven Development (Full, Lightweight, Hotfix)',
    '',
    'Methodology only: nothing here installs or runs an external SDD toolkit. Records follow the canonical sdd-project schema (`.claude/dac/sdd/`).',
    '',
    '## Modes',
    '',
  ];
  for (const mode of workflow.modes) {
    lines.push(`### ${mode.id}`, '', `- Use when: ${mode.selection}`, `- Required phases: ${mode.required_phases.join(', ')}`,
      `- Skippable phases: ${mode.skippable_phases.length ? mode.skippable_phases.join(', ') : 'none'}`,
      `- Gates: ${mode.applies_gates.join(', ')}`);
    if (mode.max_tasks) lines.push(`- Max tasks: ${mode.max_tasks}`);
    if (mode.excluded_change_types.length) lines.push(`- Never for: ${mode.excluded_change_types.join(', ')}`);
    lines.push('');
  }
  lines.push('## Phases', '');
  for (const p of workflow.phases) {
    const owners = agentMap.agents.filter((a) => a.phases.includes(p.id)).map((a) => a.agent);
    lines.push(`- ${p.id}: ${p.objective} Owners: ${owners.join(', ') || 'orchestrator'}.`);
  }
  lines.push('', '## Gates', '');
  for (const g of workflow.gates) lines.push(`- ${g.id}: blocks ${g.blocks.replace(/\.$/, '')}.${g.requires_human_approval ? ' Requires human approval.' : ''} Requires: ${g.requires.join(', ')}.`);
  lines.push('', '## Ownership', '');
  for (const a of agentMap.agents) lines.push(`- ${a.agent} (${a.role}${a.may_implement ? ', may implement' : ', never implements'}): ${a.phases.join(', ')}.`);
  lines.push('', 'The independent validator implements nothing and is the only agent eligible for the final gate. Urgency never waives approval or independent validation. A blocked gate or denied permission stops the work (BLOCKED); it is never routed to another executor.', '');
  return lines.join('\n');
}

// ---- MCP / settings ---------------------------------------------------------
function buildMcp(canon, enabled) {
  const c7 = canon.context7;
  const t = canon.template;
  if (c7.id !== CONTEXT7_SERVER || t.provider !== 'claude-code' || t.remote_type !== 'http' || t.executable !== false || t.auto_enable !== false) throw new AdapterError('MCP_TEMPLATE', 'unexpected Context7 template');
  if (!enabled) return { settings: { disabledMcpjsonServers: [CONTEXT7_SERVER], deny: [`mcp__${CONTEXT7_SERVER}`] }, mcp: null };
  // Remote HTTP form only: no credentials, no env values, no package execution.
  const mcp = { mcpServers: { [CONTEXT7_SERVER]: { type: 'http', url: c7.url } } };
  return { settings: { disabledMcpjsonServers: [], deny: [] }, mcp };
}

// ---- main ------------------------------------------------------------------
export function generate({ context7 = false, optionalAgents = [] } = {}) {
  const canon = loadCanonical();
  const agentIds = selectAgents(canon.agentCatalog, optionalAgents);
  const skillIds = selectSkills(canon.skillCatalog);
  const files = new Map();
  const put = (file, content) => files.set(file, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  const json = (o) => JSON.stringify(o, null, 2) + '\n';

  const agents = agentIds.map(buildAgent);
  for (const a of agents) put(a.file, a.content);
  for (const id of skillIds) for (const f of buildSkill(id)) put(f.file, f.content);

  const { settings, mcp } = buildMcp(canon, context7);
  const settingsDoc = { permissions: { defaultMode: 'default' }, enableAllProjectMcpServers: false };
  if (settings.deny.length) settingsDoc.permissions.deny = settings.deny;
  if (settings.disabledMcpjsonServers.length) settingsDoc.disabledMcpjsonServers = settings.disabledMcpjsonServers;
  put('.claude/settings.json', json(settingsDoc));
  if (mcp) put('.mcp.json', json(mcp));

  put('.claude/rules/dac-contracts.md', buildContractsRule());
  put('.claude/rules/dac-sdd.md', buildSddRule(canon));
  for (const f of ['common', 'task-contract', 'result', 'sdd-project']) put(`.claude/dac/contracts/${f}.schema.json`, readFileSync(join(STD, 'schemas', `${f}.schema.json`)));
  put('.claude/dac/sdd/sdd-workflow.json', readFileSync(join(STD, 'sdd', 'sdd-workflow.json')));
  put('.claude/dac/sdd/sdd-agent-map.json', readFileSync(join(STD, 'sdd', 'sdd-agent-map.json')));

  const scopes = { agents: Object.fromEntries(agents.map((a) => [a.meta.id, { read_only: a.meta.read_only, tools: a.meta.tools, writable_paths: a.meta.writable_paths }])) };
  put('.claude/hooks/dac-scopes.json', json(scopes));
  put('.claude/hooks/dac-scope-guard.mjs', readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'dac-scope-guard.mjs')));

  const adapterVersion = readJson(join(MANIFESTS, 'adapters', `${ADAPTER_ID}.json`)).version;
  const body = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const manifest = {
    adapter: ADAPTER_ID,
    adapter_version: adapterVersion,
    context7_enabled: context7,
    agents: agentIds,
    skills: skillIds,
    files: body.map(([path, buf]) => ({ path, sha256: sha256(buf) })),
  };
  put(MANIFEST_PATH, json(manifest));
  const plan = { files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), agents: agents.map((a) => a.meta), manifest };
  verifyWithinCanonical(plan, canon);
  return plan;
}

// Postcondition: re-parse the generated output and prove it never exceeds the canonical manifests.
export function verifyWithinCanonical(plan, canon = null) {
  const bad = (m) => { throw new AdapterError('PERMISSION_EXCEEDS_CANONICAL', m); };
  for (const meta of plan.agents) {
    const m = readJson(join(MANIFESTS, 'agents', `${meta.id}.json`));
    const fm = parseFrontmatter(plan.files.get(`.claude/agents/${meta.id}.md`).toString('utf8'));
    if (!fm) bad(`${meta.id}: missing frontmatter`);
    const tools = splitList(fm.tools);
    const denied = splitList(fm.disallowedTools);
    for (const t of tools) if (!m.permissions.tools.includes(t)) bad(`${meta.id}: tool ${t} not in canonical manifest`);
    if (tools.includes('Bash') || !denied.includes('Bash')) bad(`${meta.id}: shell must not be granted`);
    if (m.read_only) {
      for (const t of WRITE_TOOLS) { if (tools.includes(t) || !denied.includes(t)) bad(`${meta.id}: read-only agent must deny ${t}`); }
      if (fm.hooks) bad(`${meta.id}: read-only agent must not declare write hooks`);
    }
    if (!(fm.permissionMode in MODE_RANK) || MODE_RANK[fm.permissionMode] > MODE_RANK[m.permissions.permission_mode]) bad(`${meta.id}: permissionMode exceeds canonical`);
    const scope = JSON.parse(plan.files.get('.claude/hooks/dac-scopes.json').toString('utf8')).agents[meta.id];
    for (const w of scope.writable_paths) if (!(m.permissions.writable_paths ?? []).includes(w)) bad(`${meta.id}: writable path ${w} not canonical`);
    if (!m.read_only && tools.some((t) => WRITE_TOOLS.includes(t)) && !fm.hooks) bad(`${meta.id}: writing agent lacks scope guard`);
  }
  const settings = JSON.parse(plan.files.get('.claude/settings.json').toString('utf8'));
  if (settings.permissions?.defaultMode !== 'default' || settings.permissions?.allow) bad('settings must not widen permissions');
  if (JSON.stringify(settings).includes('bypassPermissions')) bad('settings must not use bypassPermissions');
  void canon;
  return true;
}
