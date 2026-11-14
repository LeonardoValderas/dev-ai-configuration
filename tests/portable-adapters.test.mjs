import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePortable, verifyPortable } from '../adapters/shared/portable.mjs';
import { parseFrontmatter } from '../adapters/shared/canonical.mjs';
import { REPO_ROOT, DEFAULT_INPUTS, validatePaths } from '../installer/lib/run.mjs';
const read = (p) => readFileSync(join(REPO_ROOT, p));
const text = (p, f) => p.files.get(f).toString();
const tmp = (fn) => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'dac-2h-'))); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
for (const provider of ['codex', 'cursor']) {
  const { apply, uninstall } = await import(`../adapters/${provider}/lib/apply.mjs`);
  const generate = (o) => generatePortable(provider, o);
  const base = `.${provider}`;
  test(`${provider} DECLARATIVE: deterministic nine agents, two CORE skills and portable contracts`, () => {
    const p = generate();
    assert.deepEqual(p, generate()); assert.equal(verifyPortable(provider, p), true);
    const cat = JSON.parse(read('standards/manifests/agents/agent-catalog.json'));
    assert.deepEqual(p.manifest.agents, [...cat.agents.filter((a) => a.classification === 'primary').map((a) => a.id), 'code-reviewer']);
    assert.equal(p.agents.length, 9);
    assert.deepEqual(p.manifest.skills, ['frontend-design', 'supabase-postgres-best-practices']);
    for (const f of ['common', 'task-contract', 'result', 'sdd-project']) assert.deepEqual(p.files.get(`${base}/dac/contracts/${f}.schema.json`), read(`standards/schemas/${f}.schema.json`));
    for (const f of ['sdd-workflow', 'sdd-agent-map']) assert.deepEqual(p.files.get(`${base}/dac/sdd/${f}.json`), read(`standards/sdd/${f}.json`));
    const rule = text(p, 'AGENTS.md');
    for (const mode of ['full', 'lightweight', 'hotfix']) assert.ok(rule.includes(`### ${mode}`));
    for (const key of ['allowed_paths', 'prohibited_paths', 'authorized_tools', 'rollback', 'execution_status', 'validation_result', 'unresolved_blockers']) assert.ok(rule.includes(key));
    const workflow = JSON.parse(read('standards/sdd/sdd-workflow.json'));
    for (const x of [...workflow.phases, ...workflow.gates]) assert.ok(rule.includes(`- ${x.id}:`));
    assert.match(rule, /BLOCKED/); assert.match(rule, /do not hand the work to any other executor/);
    for (const [f, b] of p.files) {
      const m = /skills\/[^/]+\/((?:references|licenses)\/.+)$/.exec(f);
      if (m) assert.deepEqual(b, read(`standards/manifests/skills/${m[1]}`));
      assert.doesNotMatch(b.toString(), /\/Users\/|\/home\/[a-z]|[A-Z]:\\|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|BEGIN [A-Z ]*PRIVATE KEY/);
      assert.doesNotMatch(b.toString(), /fallback to|retry with another|switch to another executor/i);
      assert.doesNotMatch(f, /openclaw|\.claude/);
    }
  });
  test(`${provider} DECLARATIVE: native formats preserve narrower permissions and references`, () => {
    const p = generate();
    for (const a of p.agents) {
      assert.equal(a.read_only, true); assert.deepEqual(a.writable_paths, []);
      const canonical = JSON.parse(read(`standards/manifests/agents/${a.id}.json`));
      assert.ok(a.tools.every((t) => canonical.permissions.tools.includes(t)));
      const f = `${base}/agents/${a.id}.${provider === 'codex' ? 'toml' : 'md'}`;
      const s = text(p, f);
      assert.ok(s.includes('BLOCKED'));
      if (provider === 'cursor') {
        const fm = parseFrontmatter(s);
        assert.equal(fm.readonly, 'true'); assert.equal(fm.model, 'inherit');
        assert.equal(fm.tools, undefined); assert.equal(fm.permissionMode, undefined);
      } else {
        assert.match(s, /sandbox_mode = "read-only"/); assert.match(s, /approval_policy = "never"/);
        assert.match(s, /shell_tool = false/); assert.match(s, /web_search = "disabled"/);
        const body = JSON.parse(s.split('\n').find((x) => x.startsWith('developer_instructions = ')).slice(25));
        assert.ok(body.includes(read(`standards/manifests/agents/${canonical.instructions_path}`).toString().trimEnd()));
      }
    }
    if (provider === 'codex') {
      for (const m of text(p, '.codex/config.toml').matchAll(/config_file = "([^"]+)"/g)) assert.ok(p.files.has(`.codex/${m[1]}`));
      for (const id of p.manifest.skills) assert.equal(text(p, `.agents/skills/${id}/agents/openai.yaml`), 'policy:\n  allow_implicit_invocation: false\n');
    } else {
      assert.equal(parseFrontmatter(text(p, '.cursor/rules/dac.mdc')).alwaysApply, 'true');
      const permissions = JSON.parse(text(p, '.cursor/cli.json')).permissions;
      assert.deepEqual(permissions.allow, []);
      for (const d of ['Shell(*)', 'Write(**)', 'WebFetch(*)', 'Mcp(*)']) assert.ok(permissions.deny.includes(d));
      for (const id of p.manifest.skills) assert.equal(parseFrontmatter(text(p, `.cursor/skills/${id}/SKILL.md`))['disable-model-invocation'], 'true');
    }
  });
  test(`${provider} DECLARATIVE: MCP defaults off; optional template cannot auto-connect`, () => {
    const p = generate(); const optional = generate({ context7: true });
    assert.equal(optional.manifest.context7_enabled, false);
    assert.ok(!p.files.has(`${base}/dac/mcp/context7.json`));
    const c7 = JSON.parse(read('standards/manifests/mcp/context7.json'));
    assert.equal(JSON.parse(text(optional, `${base}/dac/mcp/context7.json`)).manifest.url, c7.url);
    if (provider === 'codex') assert.match(text(optional, '.codex/config.toml'), /\[mcp_servers.context7\][\s\S]*enabled = false/);
    else assert.deepEqual(JSON.parse(text(optional, '.cursor/mcp.json')), { mcpServers: {} });
    assert.throws(() => generate({ context7: 'true' }));
    assert.throws(() => generate({ optionalAgents: ['payment-integration'] }));
  });
  test(`${provider} SECURITY: tampered permissions, refs, secrets, bypass, fallback and paths fail before writes`, () => tmp((d) => {
    const config = `${base}/${provider === 'codex' ? 'config.toml' : 'cli.json'}`;
    for (const [f, content] of [[config, 'bypassPermissions --yolo'], [config, 'workspace-write allow Shell(*)'], ['AGENTS.md', 'fallback to another executor'], ['AGENTS.md', 'sk-' + 'x'.repeat(40)], [`${base}/agents/repo-analyst.${provider === 'codex' ? 'toml' : 'md'}`, 'missing refs'], ['../outside', 'x'], ['/absolute', 'x'], ['C:\\escape', 'x']]) {
      const p = generate(); p.files.set(f, Buffer.from(content));
      assert.throws(() => apply(d, p), /canonical|output|metadata/);
      assert.deepEqual(readdirSync(d), []);
    }
    const p = generate(); p.agents[0].tools.push('Bash'); assert.throws(() => apply(d, p));
  }));
  test(`${provider} INSTALLER: dry-run, idempotence, conflict, template removal and uninstall`, () => tmp((d) => {
    const p = generate(); assert.equal(apply(d, p, { dryRun: true }).status, 'DRY_RUN'); assert.deepEqual(readdirSync(d), []);
    assert.equal(apply(d, p).status, 'APPLIED'); assert.equal(apply(d, p).status, 'UNCHANGED');
    assert.equal(apply(d, generate({ context7: true })).status, 'APPLIED');
    assert.ok(apply(d, p).removed.includes(`${base}/dac/mcp/context7.json`));
    writeFileSync(join(d, 'AGENTS.md'), 'user edit');
    assert.equal(apply(d, p).status, 'CONFLICT'); assert.equal(readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'user edit');
    assert.ok(uninstall(d).kept.includes('AGENTS.md'));
  }));
  test(`${provider} INSTALLER: zero-write conflicts, symlinks, invalid prior manifest and rollback`, () => tmp((d) => {
    writeFileSync(join(d, 'AGENTS.md'), 'mine'); assert.equal(apply(d, generate()).status, 'CONFLICT'); assert.deepEqual(readdirSync(d), ['AGENTS.md']);
    rmSync(join(d, 'AGENTS.md')); symlinkSync('/tmp', join(d, base));
    assert.equal(apply(d, generate()).status, 'CONFLICT'); rmSync(join(d, base));
    for (const n of [1, 4, 20]) { assert.throws(() => apply(d, generate(), { faultAfter: n }), (e) => e.rolledBack === true); assert.deepEqual(readdirSync(d), []); }
    apply(d, generate()); const before = readFileSync(join(d, `${base}/dac-manifest.json`));
    assert.throws(() => apply(d, generate({ context7: true }), { faultAfter: 3 }), (e) => e.rolledBack);
    assert.deepEqual(readFileSync(join(d, `${base}/dac-manifest.json`)), before);
    assert.equal(apply(d, generate()).status, 'UNCHANGED');
    const m = JSON.parse(before); m.files.push({ path: '../outside', sha256: 'a'.repeat(64) });
    writeFileSync(join(d, `${base}/dac-manifest.json`), JSON.stringify(m));
    assert.equal(uninstall(d).status, 'CONFLICT');
  }));
  test(`${provider} CLI: offline adapter plan and invalid options`, () => {
    const cli = join(REPO_ROOT, `adapters/${provider}/cli.mjs`);
    const r = spawnSync(process.execPath, [cli, 'plan', '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).files.length, generate().files.size);
    assert.equal(spawnSync(process.execPath, [cli, 'plan', '--enable-context7']).status, 2);
  });
}
test('DECLARATIVE: new manifests and evidence schema validate', () => assert.deepEqual(validatePaths(DEFAULT_INPUTS).errors, []));
test('DECLARATIVE: evidence rejects inflated enforcement claims and matrix drift', async () => {
  const { loadSchemas, checkAdapterEvidence } = await import('../installer/lib/run.mjs');
  const { validateSchema } = await import('../installer/lib/schema.mjs');
  const registry = loadSchemas();
  const matrix = JSON.parse(read('compatibility/matrix.json'));
  const m = JSON.parse(read('standards/manifests/adapters/codex.json'));
  assert.deepEqual(checkAdapterEvidence(m, matrix), []);
  m.runtime_evidence.authenticated_enforcement = 'tested';
  assert.ok(validateSchema(registry.get('adapter-manifest.schema.json'), m, registry).length);
  assert.ok(checkAdapterEvidence(m, matrix).length);
  delete m.runtime_evidence; assert.ok(checkAdapterEvidence(m, matrix).length);
});
for (const provider of ['codex', 'cursor']) test(`${provider} SECURITY: ownership ledger cannot claim unrelated or duplicate files`, async () => {
  const { apply, uninstall } = await import(`../adapters/${provider}/lib/apply.mjs`);
  tmp((d) => {
    const p = generatePortable(provider); apply(d, p);
    const manifestPath = join(d, `.${provider}/dac-manifest.json`);
    const original = readFileSync(manifestPath);
    for (const entry of [{ path: `.${provider}/unrelated.txt`, sha256: 'a'.repeat(64) }, JSON.parse(original).files[0], { path: `.${provider}/dac-manifest.json`, sha256: 'a'.repeat(64) }]) {
      const m = JSON.parse(original); m.files.push(entry); writeFileSync(manifestPath, JSON.stringify(m));
      assert.equal(uninstall(d).status, 'CONFLICT');
      assert.equal(apply(d, p).status, 'CONFLICT');
    }
  });
});
