import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const raw = read('docs/sdd-artifact-writer.md');
const doc = raw.replace(/[ \t]*\n[ \t]*(?!\s)/g, (m) => (m.includes('\n\n') ? m : ' '));

test('doc is labeled design only and states what is not present', () => {
  assert.match(doc, /DESIGN ONLY \/ NOT IMPLEMENTED/);
  assert.match(doc, /Phase 2J-B/);
  for (const w of ['CLI', 'schemas', 'gate wiring']) assert.ok(doc.includes(w), w);
});

test('doc covers the required design sections', () => {
  const required = [
    /\.sdd\/\s+artifacts\/<project-id>\//, /constitution\.json/, /specify\.json/, /receipts\//,
    /derived Markdown|derived view/, /\bplan\b[\s\S]*\bapply\b[\s\S]*\bverify\b/,
    /bare SHA or digest is insufficient/, /plan_digest/, /nonce/, /expires_at/, /prior_state/, /standard_commit/,
    /not claimed to be unforgeable/, /[Ff]ails? closed/,
    /Expired, altered or replayed/, /zero writes/i,
    /case aliases and Unicode aliases/, /symlink/i, /non-regular/, /traversal|`\.\.`/,
    /untrusted \*\*data\*\*/, /never evaluated/,
    /sdd-artifact-write/, /never\*\* satisfies/, /pre-implementation/, /read-only/,
    /executeActions/, /adapters\/shared\/apply\.mjs/, /second transaction engine/, /hard kill/, /advisory between cooperating writer processes/,
    /before_sha256/, /after_sha256/, /post-write disk verification/, /failure\s+evidence/,
    /must not populate/, /files_changed/,
    /duplicate requirement/i, /orphan criteria/, /Acceptance criteria/, /test matrix/, /Open decisions and risks/,
  ];
  for (const re of required) assert.match(doc, re, String(re));
});

test('exact preservation boundaries: .sdd is project-owned, .dac is bootstrap-owned', () => {
  assert.match(doc, /`\.sdd\/` is \*\*project-owned\*\*/);
  assert.match(doc, /Bootstrap `apply`, `update` and `uninstall` never\s+create, modify, prune or remove anything under `\.sdd\/`/);
  assert.match(doc, /limited to `\.dac\/standard\.json`, `\.dac\/shared\.json`/);
  assert.match(doc, /`\.specify\/` and `specs\/` are provisional/);
  assert.match(doc, /never reads or writes `\.dac\/`/);
  // Implementation side: bootstrap and shared installer know nothing about .sdd.
  for (const f of ['installer/bootstrap.mjs', 'adapters/shared/apply.mjs']) assert.doesNotMatch(read(f), /\.sdd\b/, f);
  const boot = read('installer/bootstrap.mjs');
  assert.match(boot, /STANDARD_PATH = '\.dac\/standard\.json'/);
  assert.match(boot, /SHARED_PATH = '\.dac\/shared\.json'/);
});

test('closed decisions: storage, approval, TTL, lock, transaction, gate', () => {
  const must = [
    /OFF by default/, /plan\/digest/, /JSON files are canonical/,
    /Mandatory trusted interactive terminal/, /requires a TTY/, /exact plan and digest/,
    /JSON file or record on its own, a command-line argument, an\s+environment variable, stdin or a pipe, a `--yes`/,
    /model\s+cannot self-approve/, /same-user process can drive a pseudo-terminal/,
    /`realpath` plus device and inode/, /explicit `missing`/, /Existing `sdd-project` approvals do not authorize/,
    /exactly 10 minutes \(600 seconds\)/, /at most 30 seconds of clock skew/, /skew never extends `expires_at`/,
    /after the lock is acquired and\s+again immediately before the first write/,
    /exclusive lock per target\/project under `\.sdd\/locks\/`/, /owner token, pid, host, process start/,
    /\*\*before\*\* recomputing/, /released\s+only when the token matches/, /`LOCKED`/, /never removed because of age alone/,
    /same host, dead, and that start time and token match/, /outside the `executeActions`\s+action list/,
    /path sets .* are disjoint/,
    /optional\s+in-transaction verification callback/, /honest rollback-failure reporting/, /best effort/, /`\.dac-tmp`/,
    /full prior-state check under the lock/, /per-action/,
    /additional, never a substitute/, /code still requires a granted `pre-implementation`/,
    /narrow it to\s+implementation, code, tests, scripts and configuration outside the exact SDD\s+documentation allowlist/,
    /Future gate wiring touch points/, /installer\/lib\/sdd\.mjs/,
    /Bootstrap `apply`, `update`, `uninstall` and rollback|Bootstrap `apply`, `update` and `uninstall` never/,
  ];
  for (const re of must) assert.match(doc, re, String(re));
  // Resolved items must no longer be open decisions.
  const open = doc.slice(doc.indexOf('## 12. Open decisions and risks'));
  for (const re of [/Final root name/, /TTL value/, /generated\s+by default/, /Where the authorization is minted/]) assert.doesNotMatch(open, re, String(re));
  assert.doesNotMatch(doc, /Recommended future mechanism/);
});

test('acceptance criteria and test matrix cover required scenarios', () => {
  const acc = doc.slice(doc.indexOf('## 10. Acceptance'));
  for (const re of [
    /Without a TTY/, /JSON file, argument, environment variable, stdin/, /TTL is exactly 600 s/, /more than 30 s in the future/,
    /`LOCKED`/, /foreign or aged lock is never removed/, /replayed/, /tamper/, /`\.dac-tmp` leftovers/,
    /rollback failure is reported honestly/, /rollback leave `\.sdd\/` byte-identical/, /`code-reviewer` stays read-only/,
    /599\/600\/601/, /30\/31 seconds/, /aged lock not removed/, /dead owner versus live owner/,
  ]) assert.match(acc, re, String(re));
});

test('bootstrap docs state .sdd preservation and .dac exclusivity', () => {
  assert.match(read('docs/project-bootstrap.md').replace(/\s+/g, ' '), /preserve `\.sdd\/` byte for byte; bootstrap owns `\.dac\/` exclusively/);
  assert.match(read('docs/sdd.md').replace(/\s+/g, ' '), /`code-reviewer` stays read-only/);
});

test('cross-links are present and minimal', () => {
  assert.match(read('docs/sdd.md'), /\]\(sdd-artifact-writer\.md\)/);
  assert.match(read('docs/project-bootstrap.md'), /\]\(sdd-artifact-writer\.md\)/);
  assert.match(read('docs/architecture.md'), /\]\(sdd-artifact-writer\.md\)/);
  assert.match(read('README.md'), /\]\(docs\/sdd-artifact-writer\.md\)/);
  assert.match(doc, /\]\(sdd\.md\)/);
  assert.match(doc, /\]\(project-bootstrap\.md\)/);
  // Existing docs stay free of design-only labels (guarded by the bootstrap doc test).
  for (const f of ['README.md', 'docs/project-bootstrap.md', 'docs/architecture.md']) {
    assert.doesNotMatch(read(f), /DESIGN ONLY|NOT IMPLEMENTED/, f);
  }
});

test('no executable writer, gate wiring or schema changes exist', () => {
  for (const dir of ['installer', 'adapters', 'installer/lib', 'adapters/shared', 'standards/schemas', 'standards/sdd']) {
    for (const f of readdirSync(new URL(`${dir}/`, root))) assert.doesNotMatch(f, /artifact-writer|artifact_writer/i, `${dir}/${f}`);
  }
  assert.ok(!existsSync(new URL('standards/schemas/sdd-artifact.schema.json', root)));
  const wf = JSON.parse(read('standards/sdd/sdd-workflow.json'));
  assert.deepEqual(wf.gates.map((g) => g.id), ['pre-implementation', 'pre-migration', 'pre-production-mutation', 'pre-deployment', 'pass']);
  for (const f of ['standards/sdd/sdd-workflow.json', 'standards/sdd/sdd-agent-map.json', 'standards/sdd/spec-kit-integration.json', 'standards/schemas/sdd-project.schema.json', 'installer/bootstrap.mjs', 'installer/lib/sdd.mjs', 'package.json']) {
    assert.doesNotMatch(read(f), /sdd-artifact-write|artifact-writer/, f);
  }
  assert.match(wf.gates[0].blocks, /any file change/); // wording narrowing is 2J-B work
  for (const f of ['adapters/shared/apply.mjs', 'adapters/shared/canonical.mjs', 'installer/lib/sdd.mjs']) {
    assert.doesNotMatch(read(f), /verifyInTransaction|onVerify|\.sdd\/locks|sdd-artifact-write/, f);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!JSON.stringify(pkg.scripts ?? {}).includes('artifact'));
});

test('sdd-project files_changed semantics are unchanged', () => {
  const s = JSON.parse(read('standards/schemas/sdd-project.schema.json'));
  assert.deepEqual(s.properties.files_changed, { $ref: 'common.schema.json#/$defs/pathList' });
});

test('no machine paths or host-specific references', () => {
  for (const t of [doc]) {
    assert.doesNotMatch(t, /\/Users\//);
    assert.doesNotMatch(t, /\/home\//);
    assert.doesNotMatch(t, /\b[A-Za-z]:\\/);
    assert.doesNotMatch(t, /openclaw/i);
  }
});
