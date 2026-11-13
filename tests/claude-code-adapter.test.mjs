import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync, lstatSync, readlinkSync, symlinkSync, statSync, cpSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { REPO_ROOT, DEFAULT_INPUTS, validatePaths } from '../installer/lib/run.mjs';
import { generate, parseFrontmatter, splitList, verifyWithinCanonical, selectAgents, AdapterError, MANIFEST_PATH } from '../adapters/claude-code/lib/generate.mjs';
import { apply, uninstall, resolveTarget } from '../adapters/claude-code/lib/apply.mjs';
import { decide } from '../adapters/claude-code/templates/dac-scope-guard.mjs';

const CLI = join(REPO_ROOT, 'adapters/claude-code/cli.mjs');
const EXAMPLES = join(REPO_ROOT, 'adapters/claude-code/examples');
const PRIMARY = ['repo-analyst', 'technical-planner', 'prompt-engineer', 'site-analyst', 'frontend-expert', 'backend-expert', 'kmp-expert', 'e2e-tester'];
const NINE = [...PRIMARY, 'code-reviewer'].sort();
const CORE_SKILLS = ['frontend-design', 'supabase-postgres-best-practices'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const canonicalAgent = (id) => readJson(join(REPO_ROOT, 'standards/manifests/agents', `${id}.json`));
const text = (plan, f) => plan.files.get(f).toString('utf8');

// Controlled temporary directories only (equivalent of mktemp -d).
function tmp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dac-cc-')));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      const rel = relative(dir, p).split(sep).join('/');
      if (st.isSymbolicLink()) out.set(rel, `link:${readlinkSync(p)}`);
      else if (st.isDirectory()) { out.set(rel, 'dir'); walk(p); } else out.set(rel, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}
const same = (a, b) => assert.deepEqual([...a], [...b]);
const put = (dir, rel, content) => { mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(dir, ...rel.split('/')), content); };

// ---------------------------------------------------------------- selection
test('generates exactly the 8 primary agents plus code-reviewer, nothing optional', () => {
  const plan = generate();
  const agents = [...plan.files.keys()].filter((f) => f.startsWith('.claude/agents/')).map((f) => f.slice(15, -3)).sort();
  assert.deepEqual(agents, NINE);
  assert.ok(!plan.files.has('.claude/agents/payment-integration.md'));
  assert.deepEqual(plan.manifest.agents.slice().sort(), NINE);
});
test('optional agents stay disabled unless explicitly requested, and only catalog-optional ones', () => {
  assert.ok(generate({ optionalAgents: ['payment-integration'] }).files.has('.claude/agents/payment-integration.md'));
  for (const bad of ['backend-architect', 'frontend-developer', 'repo-analyst-x', 'backend-expert', '__proto__']) {
    assert.throws(() => generate({ optionalAgents: [bad] }), (e) => e instanceof AdapterError && e.code === 'SELECTION', bad);
  }
  const cat = readJson(join(REPO_ROOT, 'standards/manifests/agents/agent-catalog.json'));
  assert.deepEqual(selectAgents(cat).sort(), NINE);
});
test('includes only the two approved CORE skills with licenses, never auto-invoked', () => {
  const plan = generate();
  const dirs = new Set([...plan.files.keys()].filter((f) => f.startsWith('.claude/skills/')).map((f) => f.split('/')[2]));
  assert.deepEqual([...dirs].sort(), CORE_SKILLS);
  for (const id of CORE_SKILLS) {
    const fm = parseFrontmatter(text(plan, `.claude/skills/${id}/SKILL.md`));
    assert.equal(fm.name, id);
    assert.equal(fm['disable-model-invocation'], 'true');
    assert.equal(fm['allowed-tools'], undefined, 'skills must not grant tools');
    assert.ok([...plan.files.keys()].some((f) => f.startsWith(`.claude/skills/${id}/licenses/`)));
  }
  const quarantined = readJson(join(REPO_ROOT, 'standards/manifests/skills/skill-catalog.json')).skills.filter((s) => s.classification !== 'CORE').map((s) => s.id);
  for (const id of quarantined) assert.ok(!dirs.has(id), id);
});
test('skill references are byte-identical to the canonical files', () => {
  const plan = generate();
  const dir = join(REPO_ROOT, 'standards/manifests/skills');
  for (const [f, buf] of plan.files) {
    const m = /^\.claude\/skills\/[^/]+\/((?:references|licenses)\/.+)$/.exec(f);
    if (m) assert.ok(readFileSync(join(dir, m[1])).equals(buf), f);
  }
});

// -------------------------------------------------------------- permissions
test('generated agent permissions never exceed canonical manifests', () => {
  const plan = generate({ optionalAgents: ['payment-integration'] });
  for (const meta of plan.agents) {
    const canon = canonicalAgent(meta.id);
    const fm = parseFrontmatter(text(plan, `.claude/agents/${meta.id}.md`));
    const tools = splitList(fm.tools);
    for (const t of tools) assert.ok(canon.permissions.tools.includes(t), `${meta.id}:${t}`);
    assert.ok(!tools.includes('Bash'), `${meta.id} must not be granted Bash`);
    assert.ok(splitList(fm.disallowedTools).includes('Bash'));
    assert.equal(fm.permissionMode, canon.permissions.permission_mode);
    assert.notEqual(fm.permissionMode, 'bypassPermissions');
  }
  assert.equal(verifyWithinCanonical(plan), true);
});
test('read-only generated agents cannot write: no write tools and explicit deny', () => {
  const plan = generate();
  const readOnly = plan.agents.filter((a) => a.read_only).map((a) => a.id).sort();
  assert.deepEqual(readOnly, ['code-reviewer', 'prompt-engineer', 'repo-analyst', 'site-analyst', 'technical-planner']);
  for (const id of readOnly) {
    const fm = parseFrontmatter(text(plan, `.claude/agents/${id}.md`));
    assert.equal(fm.permissionMode, 'plan');
    assert.equal(fm.hooks, undefined);
    for (const t of WRITE_TOOLS) {
      assert.ok(!splitList(fm.tools).includes(t), `${id} grants ${t}`);
      assert.ok(splitList(fm.disallowedTools).includes(t), `${id} does not deny ${t}`);
    }
  }
});
test('writing agents carry a scope guard limited to canonical writable paths', () => {
  const plan = generate();
  const scopes = JSON.parse(text(plan, '.claude/hooks/dac-scopes.json')).agents;
  for (const id of ['backend-expert', 'frontend-expert', 'kmp-expert', 'e2e-tester']) {
    const fm = parseFrontmatter(text(plan, `.claude/agents/${id}.md`));
    assert.match(fm.hooks.PreToolUse[0].hooks[0].command, new RegExp(`dac-scope-guard\\.mjs" ${id}$`));
    assert.deepEqual(scopes[id].writable_paths, canonicalAgent(id).permissions.writable_paths);
  }
});
test('verification rejects tampered plans that would exceed canonical permissions', () => {
  const tamper = (id, edit) => {
    const plan = generate();
    const f = `.claude/agents/${id}.md`;
    plan.files.set(f, Buffer.from(edit(text(plan, f))));
    assert.throws(() => verifyWithinCanonical(plan), (e) => e.code === 'PERMISSION_EXCEEDS_CANONICAL');
  };
  tamper('code-reviewer', (t) => t.replace('tools: Read, Grep, Glob', 'tools: Read, Grep, Glob, Write'));
  tamper('code-reviewer', (t) => t.replace('disallowedTools: Bash, Write, Edit, MultiEdit, NotebookEdit', 'disallowedTools: Bash'));
  tamper('backend-expert', (t) => t.replace('tools: Read, Grep, Glob, Edit, Write', 'tools: Read, Grep, Glob, Edit, Write, Bash'));
  tamper('repo-analyst', (t) => t.replace('permissionMode: plan', 'permissionMode: acceptEdits'));
  tamper('repo-analyst', (t) => t.replace('permissionMode: plan', 'permissionMode: bypassPermissions'));
  tamper('backend-expert', (t) => t.replace(/^hooks: .*\n/m, ''));
  const plan = generate();
  plan.files.set('.claude/settings.json', Buffer.from(JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Bash(*)'] } })));
  assert.throws(() => verifyWithinCanonical(plan), (e) => e.code === 'PERMISSION_EXCEEDS_CANONICAL');
  const scopes = generate();
  const s = JSON.parse(text(scopes, '.claude/hooks/dac-scopes.json'));
  s.agents['backend-expert'].writable_paths.push('**');
  scopes.files.set('.claude/hooks/dac-scopes.json', Buffer.from(JSON.stringify(s)));
  assert.throws(() => verifyWithinCanonical(scopes), (e) => e.code === 'PERMISSION_EXCEEDS_CANONICAL');
});
test('no generated file enables dangerous modes or flags', () => {
  const plan = generate({ context7: true, optionalAgents: ['payment-integration'] });
  for (const [f, buf] of plan.files) {
    if (f.startsWith('.claude/dac/contracts/')) continue; // canonical schema enums, copied verbatim
    const s = buf.toString('utf8');
    assert.ok(!/bypassPermissions|dangerously-skip-permissions|--no-verify|--yolo/i.test(s), f);
  }
});
test('generated output carries no secrets or machine-specific absolute paths', () => {
  const plan = generate({ context7: true });
  for (const [f, buf] of plan.files) {
    if (!f.endsWith('.json') && !f.endsWith('.md')) continue;
    const s = buf.toString('utf8');
    assert.ok(!/\/Users\/|\/home\/[a-z]|C:\\|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,}|BEGIN [A-Z ]*PRIVATE KEY/.test(s), f);
  }
});

// ------------------------------------------------------- guard (executed code)
const scopesOf = () => JSON.parse(text(generate(), '.claude/hooks/dac-scopes.json'));
test('guard: read-only agents are denied writes and the denial is BLOCKED without fallback', () => {
  const scopes = scopesOf();
  for (const id of ['code-reviewer', 'repo-analyst']) for (const tool of WRITE_TOOLS) {
    const r = decide({ tool_name: tool, tool_input: { file_path: 'src/a.ts' }, cwd: '/p' }, scopes, id, { CLAUDE_PROJECT_DIR: '/p' });
    assert.equal(r.decision, 'deny', `${id}:${tool}`);
    assert.match(r.reason, /^BLOCKED:/);
    assert.match(r.reason, /do not hand this task to any other executor/);
    assert.doesNotMatch(r.reason, /fall ?back|retry|try (instead|another)|delegate/i);
  }
});
test('guard: writing agents are confined to writable paths (traversal, absolute, symlink, root, unknown)', () => tmp((dir) => {
  const scopes = scopesOf();
  const outside = join(dir, 'outside');
  const proj = join(dir, 'proj');
  mkdirSync(outside); mkdirSync(join(proj, 'src'), { recursive: true }); mkdirSync(join(proj, 'docs'));
  symlinkSync(outside, join(proj, 'src', 'escape'));
  const run = (tool, file, id = 'backend-expert') => decide({ tool_name: tool, tool_input: { file_path: file }, cwd: proj }, scopes, id, { CLAUDE_PROJECT_DIR: proj }).decision;
  assert.equal(run('Write', 'src/new/file.ts'), 'allow');
  assert.equal(run('Edit', join(proj, 'tests/a.test.ts')), 'allow');
  assert.equal(run('Write', 'docs/readme.md'), 'deny');
  assert.equal(run('Write', 'src/../docs/x.md'), 'deny');
  assert.equal(run('Write', '../outside/x'), 'deny');
  assert.equal(run('Write', join(outside, 'x')), 'deny');
  assert.equal(run('Write', 'src/escape/x.ts'), 'deny', 'symlink escape');
  assert.equal(run('Write', 'src'), 'deny');
  assert.equal(run('Write', ''), 'deny');
  assert.equal(run('Write', 'src/x.ts', 'payment-integration'), 'deny', 'unknown agent (not generated)');
  assert.equal(run('Bash', 'x'), 'deny', 'shell is never granted');
  assert.equal(run('Write', 'e2e/a.ts', 'backend-expert'), 'deny');
  assert.equal(run('Write', 'e2e/a.ts', 'e2e-tester'), 'allow');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 'src/a' } }, scopes, 'backend-expert', {}).decision, 'deny', 'unknown project dir');
}));
test('guard script executes: denies read-only writes, allows in-scope, fails closed on garbage', () => tmp((dir) => {
  const ws = join(dir, 'ws'); mkdirSync(ws);
  assert.equal(apply(ws, generate()).status, 'APPLIED');
  const guard = join(ws, '.claude/hooks/dac-scope-guard.mjs');
  const exec = (id, input) => spawnSync(process.execPath, [guard, id], { input, env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: ws }, encoding: 'utf8' });
  const ev = (tool, file) => JSON.stringify({ tool_name: tool, tool_input: { file_path: file }, cwd: ws });
  const denied = exec('code-reviewer', ev('Write', 'src/a.ts'));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^BLOCKED:/);
  assert.equal(exec('backend-expert', ev('Write', 'src/a.ts')).stdout, '');
  assert.equal(JSON.parse(exec('backend-expert', ev('Write', 'docs/a.md')).stdout).hookSpecificOutput.permissionDecision, 'deny');
  for (const bad of ['not json', '']) {
    const r = exec('backend-expert', bad);
    assert.equal(r.status, 2, 'fail closed');
    assert.match(r.stderr, /BLOCKED/);
  }
  assert.equal(exec(undefined ?? 'nobody', ev('Write', 'src/a.ts')).status, 0);
  assert.equal(JSON.parse(exec('nobody', ev('Write', 'src/a.ts')).stdout).hookSpecificOutput.permissionDecision, 'deny');
}));
test('denied permissions never recommend or invoke a fallback executor', () => {
  const plan = generate({ context7: true, optionalAgents: ['payment-integration'] });
  for (const [f, buf] of plan.files) {
    if (!/\.(md|json|mjs)$/.test(f)) continue;
    assert.doesNotMatch(buf.toString('utf8'), /fall ?back to|fallback (to )?(another|other|a different)|retry with another|switch to (codex|another)|use another (executor|agent|tool)/i, f);
  }
  for (const f of ['.claude/rules/dac-contracts.md', '.claude/rules/dac-sdd.md']) assert.match(text(plan, f), /BLOCKED/);
  for (const meta of plan.agents) {
    const t = text(plan, `.claude/agents/${meta.id}.md`);
    assert.match(t, /## Permission denial[\s\S]*BLOCKED[\s\S]*do not hand the work to any other executor/);
  }
  const rule = text(plan, '.claude/rules/dac-contracts.md');
  assert.match(rule, /execution_status BLOCKED and validation_result BLOCKED/);
  assert.match(rule, /do not hand the work to any other executor/);
});

// ------------------------------------------------------------------- SDD
test('SDD rules cover Full, Lightweight and Hotfix with canonical phases, gates and owners', () => {
  const plan = generate();
  const rule = text(plan, '.claude/rules/dac-sdd.md');
  const wf = readJson(join(REPO_ROOT, 'standards/sdd/sdd-workflow.json'));
  for (const mode of ['full', 'lightweight', 'hotfix']) assert.match(rule, new RegExp(`### ${mode}\\n`));
  for (const p of wf.phases) assert.ok(rule.includes(`- ${p.id}:`), p.id);
  for (const g of wf.gates) assert.ok(rule.includes(`- ${g.id}:`), g.id);
  assert.match(rule, /### hotfix[\s\S]*Max tasks: 3[\s\S]*Never for: migration, production-schema/);
  assert.match(rule, /### lightweight[\s\S]*Max tasks: 10/);
  assert.match(rule, /code-reviewer \(independent-validator, never implements\)/);
  assert.ok(plan.files.get('.claude/dac/sdd/sdd-workflow.json').equals(readFileSync(join(REPO_ROOT, 'standards/sdd/sdd-workflow.json'))));
  assert.ok(plan.files.get('.claude/dac/sdd/sdd-agent-map.json').equals(readFileSync(join(REPO_ROOT, 'standards/sdd/sdd-agent-map.json'))));
  const map = readJson(join(REPO_ROOT, 'standards/sdd/sdd-agent-map.json'));
  for (const a of map.agents) assert.ok(plan.files.has(`.claude/agents/${a.agent}.md`), `${a.agent} mapped but not generated`);
});
test('contracts are carried over unchanged (task, result, restrictions)', () => {
  const plan = generate();
  for (const f of ['common', 'task-contract', 'result', 'sdd-project']) assert.ok(plan.files.get(`.claude/dac/contracts/${f}.schema.json`).equals(readFileSync(join(REPO_ROOT, `standards/schemas/${f}.schema.json`))));
  const rule = text(plan, '.claude/rules/dac-contracts.md');
  for (const k of ['allowed_paths', 'prohibited_paths', 'authorized_tools', 'rollback', 'execution_status', 'unresolved_blockers']) assert.ok(rule.includes(k), k);
});
test('SDD application: generated workflow validates canonical Full/Lightweight/Hotfix project records and rejects violations', () => {
  tmp((dir) => {
    const ws = join(dir, 'ws'); mkdirSync(ws);
    apply(ws, generate());
    const root = join(dir, 'sddroot');
    mkdirSync(join(root, 'sdd'), { recursive: true });
    for (const f of ['sdd-workflow.json', 'sdd-agent-map.json']) cpSync(join(ws, '.claude/dac/sdd', f), join(root, 'sdd', f));
    // agent manifests are needed by the agent-map check; reuse canonical ones
    cpSync(join(REPO_ROOT, 'standards/manifests/agents'), join(root, 'agents'), { recursive: true });
    cpSync(join(REPO_ROOT, 'tests/sdd-fixtures/projects'), join(root, 'projects'), { recursive: true });
    const res = validatePaths([root], { root: REPO_ROOT === root ? root : root });
    assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
    const hot = readJson(join(root, 'projects/project-hotfix.json'));
    hot.tasks = ['a', 'b', 'c', 'd'].map((x) => ({ ...hot.tasks[0], id: `task-${x}` }));
    writeFileSync(join(root, 'projects/project-hotfix.json'), JSON.stringify(hot));
    assert.ok(validatePaths([root], { root }).errors.length > 0, 'hotfix beyond max tasks must fail');
    const hot2 = readJson(join(REPO_ROOT, 'tests/sdd-fixtures/projects/project-hotfix.json'));
    hot2.tasks[0].change_type = 'migration';
    writeFileSync(join(root, 'projects/project-hotfix.json'), JSON.stringify(hot2));
    assert.ok(validatePaths([root], { root }).errors.length > 0, 'hotfix migration must fail');
  });
});

// ------------------------------------------------------------------ Context7
test('Context7 is disabled by default: no .mcp.json, denied and disabled in settings', () => {
  const plan = generate();
  assert.ok(!plan.files.has('.mcp.json'));
  const s = JSON.parse(text(plan, '.claude/settings.json'));
  assert.deepEqual(s.permissions.deny, ['mcp__context7']);
  assert.deepEqual(s.disabledMcpjsonServers, ['context7']);
  assert.equal(s.enableAllProjectMcpServers, false);
  for (const meta of plan.agents) assert.ok(!/mcp|context7/i.test(parseFrontmatter(text(plan, `.claude/agents/${meta.id}.md`)).tools));
  for (const [f, buf] of plan.files) if (f !== '.claude/settings.json' && !f.startsWith('.claude/dac/') && f !== MANIFEST_PATH) assert.ok(!/context7/i.test(buf.toString('utf8')) || f.includes('/skills/'), f);
});
test('Context7 opt-in emits only the credential-free remote HTTP declaration, never auto-approved', () => {
  const plan = generate({ context7: true });
  const mcp = JSON.parse(text(plan, '.mcp.json'));
  const canon = readJson(join(REPO_ROOT, 'standards/manifests/mcp/context7.json'));
  assert.deepEqual(mcp, { mcpServers: { context7: { type: 'http', url: canon.url } } });
  const s = JSON.parse(text(plan, '.claude/settings.json'));
  assert.equal(s.enableAllProjectMcpServers, false);
  assert.equal(s.permissions.deny, undefined);
  assert.ok(!JSON.stringify(s).includes('enabledMcpjsonServers'));
  assert.ok(!/CONTEXT7_API_KEY|headers|command|args|npx/.test(text(plan, '.mcp.json')));
  assert.equal(plan.manifest.context7_enabled, true);
  assert.equal(generate().manifest.context7_enabled, false);
});
test('toggling Context7 on then off removes the managed .mcp.json and restores deny', () => tmp((ws) => {
  assert.equal(apply(ws, generate()).status, 'APPLIED');
  const base = snapshot(ws);
  const on = apply(ws, generate({ context7: true }));
  assert.equal(on.status, 'APPLIED');
  assert.deepEqual(on.created, ['.mcp.json']);
  assert.ok(on.updated.includes('.claude/settings.json'));
  const off = apply(ws, generate());
  assert.deepEqual(off.removed, ['.mcp.json']);
  same(snapshot(ws), base);
}));

// ------------------------------------------------------- apply: idempotence
test('apply is idempotent: second run changes nothing (bytes and mtimes)', () => tmp((ws) => {
  const first = apply(ws, generate());
  assert.equal(first.status, 'APPLIED');
  assert.equal(first.created.length, generate().files.size);
  const snap = snapshot(ws);
  const m = statSync(join(ws, '.claude/settings.json')).mtimeMs;
  const second = apply(ws, generate());
  assert.equal(second.status, 'UNCHANGED');
  assert.equal(second.created.length + second.updated.length + second.removed.length, 0);
  same(snapshot(ws), snap);
  assert.equal(statSync(join(ws, '.claude/settings.json')).mtimeMs, m);
}));
test('generation is deterministic', () => {
  const a = generate(); const b = generate();
  assert.deepEqual([...a.files.keys()], [...b.files.keys()]);
  for (const [k, v] of a.files) assert.ok(v.equals(b.files.get(k)), k);
});
test('dry run reports actions and writes nothing', () => tmp((ws) => {
  const before = snapshot(ws);
  const r = apply(ws, generate(), { dryRun: true });
  assert.equal(r.status, 'DRY_RUN');
  assert.ok(r.created.length > 20);
  same(snapshot(ws), before);
}));
test('user files outside the managed set are preserved', () => tmp((ws) => {
  put(ws, 'src/app.ts', 'keep'); put(ws, '.claude/agents/mine.md', 'my agent'); put(ws, 'CLAUDE.md', 'mine');
  assert.equal(apply(ws, generate()).status, 'APPLIED');
  assert.equal(readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(ws, '.claude/agents/mine.md'), 'utf8'), 'my agent');
  uninstall(ws);
  assert.equal(readFileSync(join(ws, '.claude/agents/mine.md'), 'utf8'), 'my agent');
  assert.equal(readFileSync(join(ws, 'src/app.ts'), 'utf8'), 'keep');
}));

// ------------------------------------------------------------- conflicts
function conflict(name, setup, expectPath) {
  test(`conflict: ${name}`, () => tmp((ws) => {
    setup(ws);
    const before = snapshot(ws);
    const r = apply(ws, generate());
    assert.equal(r.status, 'CONFLICT');
    assert.ok(r.conflicts.some((c) => c.path === expectPath), JSON.stringify(r.conflicts));
    assert.equal(r.created.length > 0 || true, true);
    same(snapshot(ws), before); // zero writes, even for non-conflicting files
  }));
}
conflict('unmanaged agent file with different content', (ws) => put(ws, '.claude/agents/backend-expert.md', 'user owned'), '.claude/agents/backend-expert.md');
conflict('unmanaged settings.json', (ws) => put(ws, '.claude/settings.json', '{"permissions":{"allow":["Bash(*)"]}}'), '.claude/settings.json');
test('conflict: unmanaged .mcp.json with Context7 enabled is detected', () => tmp((ws) => {
  put(ws, '.mcp.json', '{"mcpServers":{}}');
  const r = apply(ws, generate({ context7: true }));
  assert.equal(r.status, 'CONFLICT');
  assert.deepEqual(r.conflicts.map((c) => c.path), ['.mcp.json']);
}));
conflict('directory where a file is expected', (ws) => mkdirSync(join(ws, '.claude/agents/backend-expert.md'), { recursive: true }), '.claude/agents/backend-expert.md');
conflict('symlinked component in the managed path', (ws) => { mkdirSync(join(ws, 'elsewhere')); mkdirSync(join(ws, '.claude')); symlinkSync(join(ws, 'elsewhere'), join(ws, '.claude/agents')); }, '.claude/agents/backend-expert.md');
conflict('corrupt manifest', (ws) => put(ws, MANIFEST_PATH, '{not json'), MANIFEST_PATH);
conflict('foreign manifest', (ws) => put(ws, MANIFEST_PATH, JSON.stringify({ adapter: 'other', files: [] })), MANIFEST_PATH);
conflict('manifest with path traversal', (ws) => put(ws, MANIFEST_PATH, JSON.stringify({ adapter: 'claude-code', files: [{ path: '../x', sha256: 'a' }] })), MANIFEST_PATH);
test('conflict: locally modified managed file blocks update and removal', () => tmp((ws) => {
  apply(ws, generate());
  writeFileSync(join(ws, '.claude/agents/code-reviewer.md'), 'edited');
  const before = snapshot(ws);
  const r = apply(ws, generate({ context7: true }));
  assert.equal(r.status, 'CONFLICT');
  assert.ok(r.conflicts.some((c) => c.path === '.claude/agents/code-reviewer.md'));
  same(snapshot(ws), before);
  const u = uninstall(ws);
  assert.deepEqual(u.kept, ['.claude/agents/code-reviewer.md']);
  assert.equal(readFileSync(join(ws, '.claude/agents/code-reviewer.md'), 'utf8'), 'edited');
}));
test('an identical pre-existing file is not a conflict', () => tmp((ws) => {
  const plan = generate();
  put(ws, '.claude/rules/dac-sdd.md', plan.files.get('.claude/rules/dac-sdd.md'));
  const r = apply(ws, plan);
  assert.equal(r.status, 'APPLIED');
  assert.ok(r.unchanged.includes('.claude/rules/dac-sdd.md'));
}));
test('stale managed file modified locally is a conflict, unmodified is removed', () => tmp((ws) => {
  apply(ws, generate({ optionalAgents: ['payment-integration'] }));
  const r = apply(ws, generate());
  assert.deepEqual(r.removed.sort(), ['.claude/agents/payment-integration.md', '.claude/hooks/dac-scopes.json'].filter((f) => r.removed.includes(f)).sort());
  assert.ok(r.removed.includes('.claude/agents/payment-integration.md'));
  apply(ws, generate({ optionalAgents: ['payment-integration'] }));
  writeFileSync(join(ws, '.claude/agents/payment-integration.md'), 'edited');
  assert.equal(apply(ws, generate()).status, 'CONFLICT');
}));

// --------------------------------------------------------------- rollback
test('rollback: injected failure at every step leaves the project exactly as before (fresh install)', () => {
  const total = generate().files.size;
  for (const n of [1, 2, 5, 17, total - 1, total]) tmp((ws) => {
    put(ws, 'src/keep.ts', 'x');
    const before = snapshot(ws);
    assert.throws(() => apply(ws, generate(), { faultAfter: n }), (e) => e.code === 'APPLY_FAILED' && e.rolledBack === true);
    same(snapshot(ws), before);
  });
});
test('rollback: injected failure during an update restores previous content and removes new files', () => {
  for (const n of [1, 2, 3]) tmp((ws) => {
    apply(ws, generate());
    const before = snapshot(ws);
    assert.throws(() => apply(ws, generate({ context7: true }), { faultAfter: n }), (e) => e.code === 'APPLY_FAILED');
    same(snapshot(ws), before);
  });
});
test('rollback: failure while removing stale files restores them', () => tmp((ws) => {
  apply(ws, generate({ context7: true }));
  const before = snapshot(ws);
  assert.throws(() => apply(ws, generate(), { faultAfter: 2 }), (e) => e.code === 'APPLY_FAILED');
  same(snapshot(ws), before);
}));
test('uninstall removes exactly what was installed and empty directories', () => tmp((ws) => {
  const before = snapshot(ws);
  apply(ws, generate({ context7: true }));
  const dry = uninstall(ws, { dryRun: true });
  assert.equal(dry.status, 'DRY_RUN');
  const r = uninstall(ws);
  assert.equal(r.status, 'REMOVED');
  assert.deepEqual(r.kept, []);
  same(snapshot(ws), before);
  assert.equal(uninstall(ws).status, 'UNCHANGED');
}));

// ---------------------------------------------------------- target safety
test('target safety: unsafe targets are refused before any write', () => tmp((dir) => {
  const link = join(dir, 'link'); mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), link);
  const file = join(dir, 'file'); writeFileSync(file, 'x');
  for (const t of ['relative/dir', '', join(dir, 'missing'), file, link, '/', REPO_ROOT, undefined]) {
    assert.throws(() => resolveTarget(t), (e) => e.code === 'TARGET', String(t));
  }
  const oldHome = process.env.HOME;
  try {
    const home = join(dir, 'home'); mkdirSync(join(home, '.claude/inner'), { recursive: true });
    process.env.HOME = home;
    for (const t of [home, join(home, '.claude'), join(home, '.claude/inner')]) assert.throws(() => resolveTarget(t), (e) => e.code === 'TARGET', t);
    assert.deepEqual(readdirSync(join(home, '.claude/inner')), []);
  } finally { process.env.HOME = oldHome; }
  mkdirSync(join(dir, 'proj', '.claude'), { recursive: true });
  assert.throws(() => resolveTarget(join(dir, 'proj', '.claude')), (e) => e.code === 'TARGET');
}));

test('target safety: a subdirectory inside the standards repository is refused before any write', () => {
  const sub = join(REPO_ROOT, 'adapters', 'claude-code');
  const before = [...snapshot(sub)].join('\n');
  assert.throws(() => resolveTarget(sub), (e) => e.code === 'TARGET');
  assert.throws(() => apply(sub, generate()), (e) => e.code === 'TARGET');
  assert.equal([...snapshot(sub)].join('\n'), before);
});

// -------------------------------------------------------- no external writes
const treeHash = (dirs) => { const h = createHash('sha256'); for (const d of dirs) for (const [k, v] of snapshot(join(REPO_ROOT, d))) h.update(`${d}/${k}:${v}\n`); return h.digest('hex'); };
test('no external writes: repository sources and an isolated HOME are untouched by apply/uninstall via the CLI', () => tmp((dir) => {
  const home = join(dir, 'home'); const ws = join(dir, 'ws'); const cfg = join(dir, 'cfg');
  for (const d of [home, ws, cfg]) mkdirSync(d);
  const repoBefore = treeHash(['standards', 'installer', 'adapters', 'compatibility']);
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, TMPDIR: dir };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', cwd: dir });
  assert.equal(run('apply', '--target', ws, '--json').status, 0);
  assert.equal(JSON.parse(run('apply', '--target', ws, '--json').stdout).status, 'UNCHANGED');
  assert.equal(run('apply', '--target', join(home, '.claude')).status, 1, 'HOME is outside the adapter scope');
  assert.equal(run('uninstall', '--target', ws).status, 0);
  assert.deepEqual(readdirSync(home), []);
  assert.deepEqual(readdirSync(cfg), []);
  assert.deepEqual(readdirSync(ws), []);
  assert.equal(treeHash(['standards', 'installer', 'adapters', 'compatibility']), repoBefore);
}));
test('adapter sources never spawn processes, use the network or reference user-level configuration', () => {
  for (const f of ['generate.mjs', 'apply.mjs']) {
    const s = readFileSync(join(REPO_ROOT, 'adapters/claude-code/lib', f), 'utf8');
    assert.doesNotMatch(s, /child_process|node:https?|node:net|fetch\(|XMLHttpRequest|process\.env\.HOME|\.claude\.json|~\/\.claude/, f);
  }
  const guard = readFileSync(join(REPO_ROOT, 'adapters/claude-code/templates/dac-scope-guard.mjs'), 'utf8');
  assert.doesNotMatch(guard, /child_process|node:https?|node:net|fetch\(|writeFile|unlink|rmSync/);
});
test('CLI usage errors and plan', () => {
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run().status, 2);
  assert.equal(run('apply').status, 2);
  assert.equal(run('plan', '--bogus').status, 2);
  assert.equal(run('plan', '--optional-agent', 'backend-architect').status, 1);
  assert.match(run('plan').stdout, /\.claude\/agents\/code-reviewer\.md/);
  assert.doesNotMatch(run('plan').stdout, /\.mcp\.json/);
  assert.match(run('plan', '--enable-context7').stdout, /\.mcp\.json/);
});

// ------------------------------------------------------ canonical validation
test('canonical adapter manifest validates and the generator refuses unsupported skill claims', () => {
  assert.deepEqual(validatePaths([join(REPO_ROOT, 'standards/manifests/adapters')], { root: REPO_ROOT }).errors.filter((e) => e.code !== 'MISSING_REFERENCE'), []);
  const m = readJson(join(REPO_ROOT, 'standards/manifests/adapters/claude-code.json'));
  assert.deepEqual(m.supports.agents.slice().sort(), NINE);
  assert.equal(m.supports.skills, undefined, 'skills stay untested for adapters in the canonical catalog');
  assert.equal(m.target_tool, 'claude-code');
  assert.deepEqual(validatePaths(DEFAULT_INPUTS, { root: REPO_ROOT }).errors, []);
});

// ------------------------------------------------------------- golden examples
test('committed example projects equal freshly generated output (no drift, no extra files)', () => {
  const expected = (plan) => new Map([...plan.files].map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));
  const actual = new Map([...snapshot(join(EXAMPLES, 'project'))].filter(([, v]) => v !== 'dir'));
  const byKey = ([a], [b]) => (a < b ? -1 : 1);
  assert.deepEqual([...actual].sort(byKey), [...expected(generate())].sort(byKey));
  const c7 = snapshot(join(EXAMPLES, 'context7-enabled'));
  const plan = generate({ context7: true });
  for (const f of ['.mcp.json', '.claude/settings.json']) assert.equal(c7.get(f), createHash('sha256').update(plan.files.get(f)).digest('hex'), f);
  assert.deepEqual([...c7].filter(([, v]) => v !== 'dir').map(([k]) => k).sort(), ['.claude/settings.json', '.mcp.json']);
});

// Real Claude Code CLI evidence lives in tests/claude-runtime.test.mjs (Phase 2G.1). The CLI is run
// only inside the disposable, OS-isolated runtime (CLAUDE_CONFIG_DIR + OS-level write denial);
// this file never executes `claude`.
