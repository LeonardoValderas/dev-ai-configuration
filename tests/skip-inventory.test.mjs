// Explicit, accurate inventory of the skipped tests in the full suite. A skip is an honest "not proven here", never a PASS:
// this test fails if a new unconditional/credential-gated skip appears undocumented, or if a documented skip stops being reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const doc = readFileSync(new URL('../docs/sdd-input-handoff.md', import.meta.url), 'utf8');

// The three tests that are skipped in the default environment (no operator credential, no external skill originals, no authenticated model call).
export const EXPECTED = [
  { name: 'LIVE-OPT-IN: read-only agent cannot write in a live model session', file: 'tests/claude-runtime.test.mjs', why: /DAC_PROBE_ANTHROPIC_API_KEY/, reason: /no operator-supplied credential: UNVERIFIED/ },
  { name: 'AUTHENTICATED-ENFORCEMENT: explicitly unverified; no model calls permitted', file: 'tests/portable-runtime.test.mjs', why: /Forbidden by Phase 2H scope/, reason: /Forbidden by Phase 2H scope/ },
  { name: 'the original skills are unmodified', file: 'tests/skills.test.mjs', why: /DAC_SKILL_ORIGINALS/, reason: /^$/ },
];
// Prerequisite-gated skips (macOS sandbox, claude CLI, python3 pty): reported as BLOCKED/unavailable, never as PASS; they run in this repository's environment.
const PREREQ = /BLOCKED|sandbox|claude|python3|pty|out-of-home|unavailable|isolated/i;

test('skip inventory: the credential/scope-gated skips are exactly the three documented ones, each justified in the docs', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }; // no DAC_PROBE_ANTHROPIC_API_KEY, no DAC_SKILL_ORIGINALS, no DAC_REQUIRE_PTY
  const files = [...new Set(EXPECTED.map((e) => e.file))];
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files.map((f) => `${root}${f}`)], { encoding: 'utf8', env, cwd: root });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
  const skipped = [...r.stdout.matchAll(/^\s*ok \d+ - (.*?) # SKIP[ \t]*(.*)$/gm)].map((m) => ({ name: m[1].replace(/ \(.*$/, ''), reason: m[2].trim() }));
  const unexpected = skipped.filter((s) => !EXPECTED.some((e) => s.name.startsWith(e.name)) && !PREREQ.test(s.name + s.reason));
  assert.deepEqual(unexpected, [], 'undocumented skip');
  for (const e of EXPECTED) {
    const hit = skipped.find((s) => s.name.startsWith(e.name));
    assert.ok(hit, `documented skip is no longer reported: ${e.name}`);
    assert.match(hit.reason, e.reason);
    assert.ok(doc.includes(e.name), `docs justify: ${e.name}`);
    assert.match(readFileSync(new URL(`../${e.file}`, import.meta.url), 'utf8'), e.why);
  }
  assert.equal(skipped.filter((s) => EXPECTED.some((e) => s.name.startsWith(e.name))).length, 3);
});

test('skip inventory: no skip is silently turned into a pass (gated tests are real skips, not empty bodies passing)', () => {
  const rt = readFileSync(new URL('../tests/portable-runtime.test.mjs', import.meta.url), 'utf8');
  assert.match(rt, /test\('AUTHENTICATED-ENFORCEMENT[^']*', \{ skip: '[^']+' \}, \(\) => \{\}\)/);
  const live = readFileSync(new URL('../tests/claude-runtime.test.mjs', import.meta.url), 'utf8');
  assert.match(live, /LIVE-OPT-IN[^\n]*skip: !process\.env\.DAC_PROBE_ANTHROPIC_API_KEY && 'no operator-supplied credential: UNVERIFIED'/);
  assert.match(live, /GATE: the live read-only enforcement probe is UNVERIFIED\/BLOCKED without an explicit operator credential/);
});
