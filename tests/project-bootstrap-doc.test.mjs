import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const doc = readFileSync(new URL('docs/project-bootstrap.md', root), 'utf8');
const architecture = readFileSync(new URL('docs/architecture.md', root), 'utf8');

test('README and docs describe the implemented bootstrap, not a design-only state', () => {
  assert.match(readme, /\(docs\/project-bootstrap\.md/);
  assert.match(readme, /Phase 2I-B/);
  assert.match(doc, /IMPLEMENTED/);
  for (const t of [readme, doc, architecture]) {
    assert.doesNotMatch(t, /NOT EXECUTABLE/);
    assert.doesNotMatch(t, /DESIGN ONLY/);
    assert.doesNotMatch(t, /PROPOSED/);
  }
  assert.match(architecture, /\[Project bootstrap\]\(project-bootstrap\.md\)/);
});

test('every bootstrap command is documented with an executable invocation', () => {
  for (const c of ['plan', 'apply', 'verify', 'update', 'uninstall']) assert.ok(doc.includes(`node installer/bootstrap.mjs ${c}`), c);
  for (const c of ['plan', 'apply', 'verify', 'update', 'uninstall']) assert.ok(readme.includes(`installer/bootstrap.mjs ${c}`) || readme.includes(`bootstrap.mjs ${c}`) || c === 'plan', c);
});

test('standard commit is a verified full SHA from a clean Git checkout', () => {
  assert.match(doc, /valid Git repository/i);
  assert.match(doc, /clean\s+working tree/i);
  assert.match(doc, /verifiable full 40-hex `HEAD`/);
  assert.match(doc, /fail closed[\s\S]*zero writes/i);
  assert.match(doc, /No synthetic or shortened commit/i);
  assert.match(doc, /SOURCE_CHANGED/);
});

test('honest limitations are retained', () => {
  for (const t of [readme, doc]) assert.match(t, /UNVERIFIED/);
  assert.match(doc, /macOS (distribution )?gate/i);
  assert.match(doc, /not part of Phase 2I-B/i);
  assert.match(doc, /In-process journal only/);
});

test('no absolute machine paths', () => {
  for (const t of [readme, doc]) {
    assert.doesNotMatch(t, /\/Users\//);
    assert.doesNotMatch(t, /\/home\//);
    assert.doesNotMatch(t, /\b[A-Za-z]:\\/);
  }
});

test('shared AGENTS.md ownership and ledger are documented', () => {
  assert.match(doc, /\.dac\/shared\.json/);
  assert.match(doc, /final owner/i);
  assert.match(doc, /migration/i);
  assert.match(doc, /A user-owned `AGENTS\.md` is a conflict/);
});

test('per-provider CLIs remain documented', () => {
  for (const p of ['claude-code', 'codex', 'cursor']) {
    for (const c of ['plan', 'apply', 'uninstall']) assert.ok(doc.includes(`node adapters/${p}/cli.mjs ${c}`), `${p} ${c}`);
  }
});

test('Context7 off by default and no Spec Kit install are stated', () => {
  assert.match(doc, /Context7 stays off by default/);
  assert.match(doc, /Spec Kit is never installed/);
  assert.match(readme, /Context7 is off by default/);
});
