// Native formats share canonical renderers; no generated tree depends on this repository.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, DEFAULT_INPUTS, validatePaths } from '../../installer/lib/run.mjs';
import { AdapterError, sha256, renderFrontmatter, selectAgents, selectSkills, buildSkill, buildContractsRule, buildSddRule } from './canonical.mjs';
export { AdapterError } from './canonical.mjs';
const std = join(REPO_ROOT, 'standards');
const read = (p) => readFileSync(join(std, p));
const jsonRead = (p) => JSON.parse(read(p));
const json = (o) => JSON.stringify(o, null, 2) + '\n';
// JSON strings are a subset of TOML basic strings for our validated canonical text.
const quote = (s) => JSON.stringify(s).replace(/\\u0008/g, '\\b').replace(/\\u000c/g, '\\f');
const safety = 'sandbox_mode = "read-only"\napproval_policy = "never"\nweb_search = "disabled"\n';
const features = '[features]\nshell_tool = false\n';
const deny = '\n## Adapter restrictions\n\nRead-only adapter: edits and shell commands are unavailable. Canonical implementers may analyze but must report implementation as BLOCKED. Canonical writable paths are an upper bound, not a grant. Do not retry a denied action by another route or hand it to another executor. Report execution_status BLOCKED and validation_result BLOCKED with unresolved_blockers. No production access. Skills require explicit task activation.\n';

export const SHARED_AGENTS_PATH = 'AGENTS.md';

// One identical AGENTS.md for every portable provider: no provider name, no provider-specific base path.
export function neutralAgentsMd() {
  const base = '.<provider>';
  const canon = { workflow: jsonRead('sdd/sdd-workflow.json'), agentMap: jsonRead('sdd/sdd-agent-map.json') };
  const rules = buildContractsRule(base, 'provider-neutral') + '\n' + buildSddRule(canon, base, 'provider-neutral') + deny;
  return Buffer.from('<!-- Generated provider-neutral project adapter, shared by Codex and Cursor (`.<provider>` is `.codex` or `.cursor`). Regenerate; do not edit. -->\n\n' + rules);
}

export function generatePortable(provider, options = {}) {
  if (!['codex', 'cursor'].includes(provider)) throw new AdapterError('PROVIDER', 'unsupported adapter');
  if (Object.keys(options).some((k) => !['context7', 'neutralAgents'].includes(k)) || ['context7', 'neutralAgents'].some((k) => options[k] !== undefined && typeof options[k] !== 'boolean')) throw new AdapterError('OPTIONS', 'only the boolean context7 and neutralAgents options are supported');
  const context7 = options.context7 ?? false;
  // neutralAgents: the root AGENTS.md is a provider-neutral shared artifact owned by the bootstrap
  // ledger (.dac/shared.json), so it is not part of this provider's own file set or manifest.
  const neutralAgents = options.neutralAgents ?? false;
  const { errors } = validatePaths(DEFAULT_INPUTS);
  if (errors.length) throw new AdapterError('CANONICAL_INVALID', 'canonical validation failed; run npm run validate');
  const base = `.${provider}`;
  const manifestPath = `${base}/dac-manifest.json`;
  const manifestDoc = jsonRead(`manifests/adapters/${provider}.json`);
  const agentIds = selectAgents(jsonRead('manifests/agents/agent-catalog.json'));
  const skillIds = selectSkills(jsonRead('manifests/skills/skill-catalog.json'));
  const files = new Map();
  const put = (p, b) => files.set(p, Buffer.isBuffer(b) ? b : Buffer.from(b));
  const agents = [];
  let config = safety + '\n' + features;
  for (const id of agentIds) {
    const m = jsonRead(`manifests/agents/${id}.json`);
    if (m.permissions.tools.some((t) => !['Read', 'Grep', 'Glob', 'Write', 'Edit'].includes(t)) || !['plan', 'default'].includes(m.permissions.permission_mode)) throw new AdapterError('PERMISSION', 'unmapped canonical permission');
    const instructions = read(`manifests/agents/${m.instructions_path}`).toString().trimEnd();
    const body = `${instructions}\n${deny}\nRead the task/result contracts and SDD workflow in ${base}/dac/.\nCanonical permission ceiling: ${JSON.stringify(m.permissions)}\n`;
    agents.push({ id, canonical_read_only: m.read_only, read_only: true, writable_paths: [], tools: m.permissions.tools.filter((t) => ['Read', 'Grep', 'Glob'].includes(t)) });
    if (provider === 'codex') {
      config += `\n[agents.${id}]\ndescription = ${quote(m.description)}\nconfig_file = ${quote(`agents/${id}.toml`)}\n`;
      put(`${base}/agents/${id}.toml`, safety + `developer_instructions = ${quote(body)}\n\n` + features);
    } else {
      put(`${base}/agents/${id}.md`, renderFrontmatter({ name: id, description: m.description, model: 'inherit', readonly: true, is_background: false }) + '\n' + body);
    }
    put(`${base}/dac/agents/${id}.json`, read(`manifests/agents/${id}.json`));
  }
  for (const id of skillIds) {
    const skillBase = provider === 'codex' ? '.agents/skills' : `${base}/skills`;
    for (const f of buildSkill(id, skillBase, provider)) put(f.file, f.content);
    if (provider === 'codex') put(`${skillBase}/${id}/agents/openai.yaml`, 'policy:\n  allow_implicit_invocation: false\n');
  }
  const canon = { workflow: jsonRead('sdd/sdd-workflow.json'), agentMap: jsonRead('sdd/sdd-agent-map.json') };
  const rules = buildContractsRule(base, provider) + '\n' + buildSddRule(canon, base, provider) + deny;
  if (!neutralAgents) put('AGENTS.md', `<!-- Generated ${provider} project adapter. Regenerate; do not edit. -->\n\n` + rules);
  if (provider === 'cursor') {
    put('.cursor/rules/dac.mdc', renderFrontmatter({ description: 'Canonical contracts and SDD gates', alwaysApply: true }) + '\nRead AGENTS.md for canonical task/result contracts, Full SDD, Lightweight SDD and Hotfix gates.\n' + deny);
    put('.cursor/cli.json', json({ permissions: { allow: [], deny: ['Shell(*)', 'Write(**)', 'WebFetch(*)', 'Mcp(*)', 'Read(.env*)', 'Read(**/.env*)', 'Read(**/*.key)', 'Read(**/*.pem)'] } }));
    put('.cursor/mcp.json', json({ mcpServers: {} }));
  }
  // Context7 is an inert opt-in template, never a connection or an enabled server.
  if (context7) {
    const c7 = jsonRead('manifests/mcp/context7.json');
    const template = jsonRead(`manifests/mcp/templates/${provider === 'codex' ? 'codex-config' : 'cursor'}.json`);
    if (template.executable !== false || template.auto_enable !== false || !c7.url.startsWith('https://')) throw new AdapterError('MCP_TEMPLATE', 'unsafe MCP catalog');
    put(`${base}/dac/mcp/context7.json`, json({ manifest: c7, template }));
    if (provider === 'codex') config += `\n[mcp_servers.context7]\nurl = ${quote(c7.url)}\nenabled = false\n`;
    else put('.cursor/dac/mcp/context7.template.json', json({ mcpServers: { context7: { url: c7.url } } }));
  }
  if (provider === 'codex') put('.codex/config.toml', config);
  for (const f of ['common', 'task-contract', 'result', 'sdd-project']) put(`${base}/dac/contracts/${f}.schema.json`, read(`schemas/${f}.schema.json`));
  for (const f of ['sdd-workflow', 'sdd-agent-map']) put(`${base}/dac/sdd/${f}.json`, read(`sdd/${f}.json`));
  const sorted = () => [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const manifest = { adapter: provider, adapter_version: manifestDoc.version, context7_enabled: false, context7_template: context7, agents: agentIds, skills: skillIds, evidence: 'declarative', ...(neutralAgents ? { shared_paths: [SHARED_AGENTS_PATH] } : {}), files: sorted().map(([path, buf]) => ({ path, sha256: sha256(buf) })) };
  put(manifestPath, json(manifest));
  return { files: new Map(sorted()), agents, manifest };
}

// Verify the whole deterministic plan against fresh canonical inputs. Hashes supplied by callers
// are not trusted: changing config, references, metadata or adding a file fails before any write.
export function verifyPortable(provider, plan) {
  const expected = generatePortable(provider, { context7: plan?.manifest?.context7_template ?? false, neutralAgents: Array.isArray(plan?.manifest?.shared_paths) });
  if (!(plan?.files instanceof Map) || plan.files.size !== expected.files.size || JSON.stringify(plan.manifest) !== JSON.stringify(expected.manifest) || JSON.stringify(plan.agents) !== JSON.stringify(expected.agents)) throw new AdapterError('PLAN_INVALID', 'plan metadata differs from canonical generation');
  for (const [p, b] of expected.files) if (!Buffer.isBuffer(plan.files.get(p)) || !b.equals(plan.files.get(p))) throw new AdapterError('PLAN_INVALID', `noncanonical output: ${p}`);
  return true;
}
