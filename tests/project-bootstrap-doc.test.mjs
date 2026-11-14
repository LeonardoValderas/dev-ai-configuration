import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const doc = readFileSync(new URL('docs/project-bootstrap.md', root), 'utf8');
const architecture = readFileSync(new URL('docs/architecture.md', root), 'utf8');

test('README links the design doc and states design only', () => {
  assert.match(readme, /\(docs\/project-bootstrap\.md\)/);
  assert.match(readme, /Phase 2I-A/);
  assert.match(doc, /DESIGN ONLY/);
});

test('architecture links the project bootstrap design without claiming implementation', () => {
  assert.match(architecture, /\[Project bootstrap design\]\(project-bootstrap\.md\)/);
  assert.match(architecture, /design\s+only/i);
  assert.match(architecture, /does not make the proposed common CLI executable/i);
});

test('standard commit is a verified full SHA from a clean Git checkout', () => {
  assert.match(doc, /valid Git checkout/i);
  assert.match(doc, /clean working tree/i);
  assert.match(doc, /verifiable `HEAD`/);
  assert.match(doc, /full\s+40-hex SHA/i);
  assert.match(doc, /not a Git checkout, is dirty[\s\S]*fail closed[\s\S]*zero writes/i);
  assert.match(doc, /never[\s\S]*synthetic value/i);
  assert.match(doc, /Phase 2I-B design contract only/i);
});

test('future CLI/verify/update are visibly proposed and not executable', () => {
  for (const t of [readme, doc]) {
    assert.match(t, /PROPOSED/);
    assert.match(t, /NOT EXECUTABLE/);
  }
  for (const c of ['plan', 'apply', 'verify', 'update', 'uninstall']) {
    const row = doc.split('\n').find((l) => l.startsWith(`| \`${c} `));
    assert.ok(row, `row for ${c}`);
    assert.match(row, /PROPOSED \/ NOT EXECUTABLE/);
  }
});

test('no absolute machine paths', () => {
  for (const t of [readme, doc]) {
    assert.doesNotMatch(t, /\/Users\//);
    assert.doesNotMatch(t, /\/home\//);
    assert.doesNotMatch(t, /\b[A-Za-z]:\\/);
  }
});

test('shared AGENTS.md ownership, ledger, macOS gate and UNVERIFIED are documented', () => {
  assert.match(doc, /AGENTS\.md/);
  assert.match(doc, /\.dac\/shared\.json/);
  assert.match(doc, /shared ownership ledger/i);
  assert.match(doc, /macOS (distribution )?gate/i);
  assert.match(doc, /UNVERIFIED/);
});

test('real provider CLIs are documented', () => {
  for (const p of ['claude-code', 'codex', 'cursor']) {
    for (const c of ['plan', 'apply', 'uninstall']) {
      assert.ok(doc.includes(`node adapters/${p}/cli.mjs ${c}`), `${p} ${c}`);
    }
  }
});

test('README warns against Codex + Cursor coexistence', () => {
  assert.match(readme, /do not apply Codex and Cursor to the same project today/i);
});
