// Phase 2G.1 runtime-evidence state. Pure reporting: it never runs `claude` and never touches ~/.claude.
// CLI: `node tests/support/runtime-evidence.mjs` prints the state; with DAC_CLAIM_RUNTIME_VERIFIED=1
// it exits 1 unless the state is RUNTIME-CAPABLE (a claim the environment cannot back is an error).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxAvailable, sandboxUnavailableReason, isolatedBase } from './claude-runtime.mjs';

export function runtimeEvidenceState({ platform = process.platform, sandbox = sandboxAvailable, base = isolatedBase, reason = sandboxUnavailableReason } = {}) {
  const sandboxOk = platform === 'darwin' && sandbox() && base() !== null;
  const hasClaude = platform === 'darwin' && spawnSync('which', ['claude'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status === 0;
  if (sandboxOk && hasClaude) return { state: 'RUNTIME-CAPABLE', platform, detail: 'sandbox-exec applies and claude is installed: REAL-OS and REAL-CLAUDE tests execute (not skipped)' };
  return { state: 'BLOCKED-UNVERIFIED', platform, detail: `REAL-OS/REAL-CLAUDE sandbox tests are skipped: ${sandboxOk ? 'claude CLI not installed' : reason()}` };
}

// The workflow "claims" runtime verification if it sets DAC_CLAIM_RUNTIME_VERIFIED, and that is only
// honest on a macOS runner.
export function workflowClaimIsHonest(yaml) {
  const claims = /DAC_CLAIM_RUNTIME_VERIFIED/.test(yaml);
  const macos = /runs-on:\s*['"]?macos/.test(yaml);
  return { claims, macos, honest: !claims || macos };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = runtimeEvidenceState();
  console.log(`Phase 2G.1 runtime evidence: ${s.state} (${s.platform}): ${s.detail}`);
  if (process.env.DAC_CLAIM_RUNTIME_VERIFIED === '1' && s.state !== 'RUNTIME-CAPABLE') {
    console.error('FAIL: runtime verification is claimed but this environment cannot execute it.');
    process.exit(1);
  }
}
