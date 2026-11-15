import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const raw = read('docs/sdd-artifact-writer.md');
const doc = raw.replace(/[ \t]*\n[ \t]*(?!\s)/g, (m) => (m.includes('\n\n') ? m : ' '));

test('doc states the implemented scope and where the pieces live', () => {
  assert.doesNotMatch(doc, /DESIGN ONLY|NOT IMPLEMENTED/);
  assert.match(doc, /Implemented \(Phase 2J-B\)/);
  for (const w of ['adapters/shared/sdd-writer/writer.mjs', 'adapters/shared/sdd-writer/cli.mjs', 'sdd-constitution.schema.json', 'sdd-specify.schema.json', 'sdd-write-receipt.schema.json']) assert.ok(doc.includes(w), w);
  for (const w of ['adapters/shared/sdd-writer/writer.mjs', 'adapters/shared/sdd-writer/cli.mjs', 'adapters/shared/sdd-writer/artifacts.mjs']) assert.ok(existsSync(new URL(w, root)), w);
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
    /duplicate requirement/i, /orphan criteria/, /Acceptance criteria/, /[Tt]est matrix/, /Open decisions and risks/,
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
  assert.doesNotMatch(read('adapters/shared/sdd-writer/writer.mjs') + read('adapters/shared/sdd-writer/artifacts.mjs') + read('adapters/shared/sdd-writer/lock.mjs'), /['"`]\.dac\//);
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
    /covers implementation, code,\s+tests, scripts and configuration outside the exact SDD allowlist|implementation, code,\s+tests, scripts and configuration outside the exact SDD documentation allowlist/,
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

test('gate wiring: sdd-artifact-write is separate and pre-implementation is narrowed', () => {
  const wf = JSON.parse(read('standards/sdd/sdd-workflow.json'));
  assert.deepEqual(wf.gates.map((g) => g.id), ['pre-implementation', 'sdd-artifact-write', 'pre-migration', 'pre-production-mutation', 'pre-deployment', 'pass']);
  const w = wf.gates.find((g) => g.id === 'sdd-artifact-write');
  assert.equal(w.requires_human_approval, true);
  const pre = wf.gates.find((g) => g.id === 'pre-implementation');
  assert.doesNotMatch(pre.blocks, /any file change/);
  assert.match(pre.blocks, /outside the exact SDD documentation allowlist/);
  for (const g of wf.gates) if (g.id !== 'sdd-artifact-write') for (const c of w.requires) assert.ok(!g.requires.includes(c), `${g.id} must not borrow ${c}`);
  assert.ok(!pre.requires.some((c) => /artifact|terminal/.test(c)));
  for (const f of ['standards/sdd/sdd-agent-map.json', 'standards/sdd/spec-kit-integration.json', 'installer/bootstrap.mjs']) assert.doesNotMatch(read(f), /sdd-artifact-write|sdd-writer/, f);
  assert.equal(JSON.parse(read('package.json')).scripts['sdd-writer'], 'node adapters/shared/sdd-writer/cli.mjs');
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
