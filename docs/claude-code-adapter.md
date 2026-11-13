# Claude Code project adapter (Phase 2G)

Translates the canonical standard into Claude Code **project-scoped** files. It only
translates: it adds no policy and never grants more than the canonical manifests.
Everything is offline (no network, no installs, no OAuth, no `specify init`, no MCP
execution) and nothing outside the explicit target directory is ever written.

## Usage

```
node adapters/claude-code/cli.mjs plan                              # list generated files
node adapters/claude-code/cli.mjs apply --target <existing dir>     # install (--dry-run to preview)
node adapters/claude-code/cli.mjs uninstall --target <dir>          # remove unmodified managed files
```

Options: `--enable-context7` (opt in to the optional Context7 declaration),
`--optional-agent payment-integration` (opt in to an optional catalog agent), `--json`.
Exit codes: 0 ok, 1 conflict/failure, 2 usage error.

## What is generated

| Output | Source |
| --- | --- |
| `.claude/agents/<id>.md` (8 primary agents + `code-reviewer`) | agent manifests and instructions |
| `.claude/skills/<id>/` (only the 2 CORE skills, with notices and licenses) | skill manifests |
| `.claude/rules/dac-contracts.md`, `.claude/dac/contracts/*.schema.json` | task-contract, result, restrictions (`allowed_paths`, `prohibited_paths`, `authorized_tools`, `constraints`) |
| `.claude/rules/dac-sdd.md`, `.claude/dac/sdd/*.json` | Full, Lightweight and Hotfix SDD, phases, gates, owners |
| `.claude/settings.json` | default mode only; Context7 denied and disabled |
| `.claude/hooks/dac-scope-guard.mjs`, `dac-scopes.json` | write-scope guard derived from `writable_paths` |
| `.mcp.json` | only with `--enable-context7` |
| `.claude/dac-manifest.json` | managed-file list with SHA-256 digests |

Committed golden output: `adapters/claude-code/examples/` (a test fails on any drift).

## Permission model (never exceeds canonical)

- Agent `tools` are a subset of the manifest `tools`. Read-only agents get
  `permissionMode: plan`, no write tools, and `disallowedTools` lists
  `Bash, Write, Edit, MultiEdit, NotebookEdit`.
- **Shell is never granted.** Claude Code subagent tool lists cannot scope Bash to the
  manifest's exact command list, so the adapter fails closed; canonical shell commands
  are documented in each agent but not available to it.
- Writing agents carry a PreToolUse hook that confines `Write/Edit/MultiEdit/NotebookEdit`
  to the manifest `writable_paths` (traversal, absolute paths and symlink escapes denied).
- Skills are `disable-model-invocation: true` and grant no `allowed-tools`.
- Optional agents (`payment-integration`) are off unless requested. Context7 is off unless
  `--enable-context7`; then only the credential-free remote HTTP declaration is emitted
  and it is never auto-approved. `bypassPermissions` is never emitted.
- `verifyWithinCanonical` re-parses the generated files after generation and aborts if any
  permission exceeds its manifest.
- **Denied means BLOCKED.** A denial is final: report `execution_status` BLOCKED, do not retry
  another way and do not hand the work to any other executor. No fallback is invoked or
  recommended by any generated file.

## Applying safely

- Targets must be existing real directories; the home directory, any `.claude`
  configuration directory, the filesystem root and this repository root are refused.
- Idempotent: a second `apply` reports `UNCHANGED`.
- Conflicts: a file that exists, is not managed and differs, a locally modified managed file,
  a symlink in the path, or a corrupt manifest gives `CONFLICT` and **zero writes**.
- Rollback: changes are journaled; any failure restores the previous state exactly.
  `uninstall` removes only unmodified managed files and empty directories.

## Evidence: real vs simulated (Claude Code 2.1.318)

### Runtime isolation (Phase 2G.1)

Phase 2G ran the real CLI with only `HOME` / `CLAUDE_CONFIG_DIR` redirected. That is not
isolation: environment variables are a request, not a barrier. `HOME` does not stop a process
resolving the account home from the user database (a REAL-OS test shows `os.userInfo().homedir`
ignores `$HOME`), and Claude Code also reads `.claude` directories in ancestors of its working
directory. The 2G.1 harness (`tests/support/claude-runtime.mjs`, used by
`tests/claude-runtime.test.mjs`) replaces it. The CLI is never run in any other way;
`tests/claude-code-adapter.test.mjs` no longer executes `claude`.

1. **Disposable directory** outside the real home, no `.claude` in any ancestor, holding
   `home/`, `cfg/` (`CLAUDE_CONFIG_DIR`), `xdg/*`, `tmp/` and `ws/` (the project). Removed afterwards.
2. **Environment allowlist** (`PATH` plus the redirected variables, telemetry/auto-update off).
   Nothing else is inherited: no `ANTHROPIC_*`, OAuth tokens, cloud or SSH variables.
   No credentials, sessions or login state are copied; no OAuth; `bypassPermissions` and
   `--dangerously-skip-permissions` are refused by the runner.
3. **OS-level write denial** (macOS `sandbox-exec`): all file writes denied except inside the
   disposable directory; read **and** write of the real `~/.claude` and `~/.claude.json*`
   explicitly denied; network denied (offline). The runner refuses to start `claude` unless the
   OS actually applies the profile and a self-test passes (write inside OK, write outside denied,
   protected rules deny reads on a synthetic decoy home; real paths reported denied/untested). No silent degradation: otherwise the tests are skipped as
   *BLOCKED, runtime unverified*.
4. **Read-only before/after snapshot** of `~/.claude` and `~/.claude.json*`: metadata only
   (type, size, mtime ns, mode, inode, link target); contents are never opened. A runtime test
   compares it before and after. This is a detective control: a Claude Code session the user
   has open concurrently also writes there and would show as a (false) difference; the
   preventive control is the OS denial.

Test names carry the evidence class: `REAL-OS` (a real OS mechanism, no Claude Code),
`REAL-CLAUDE` (installed CLI inside the sandbox, no model call, no credentials), `SIMULATED`
(logic on synthetic input; proves decision code only), `GATE` / `LIVE-OPT-IN` (probe below).

### Evidence ledger (Claude Code 2.1.318)

| Claim | Class | Status |
| --- | --- | --- |
| 9 agents + 2 CORE skills recognized, no `payment-integration`, `mcp_servers: []` (Context7 off), `permissionMode: default`, `apiKeySource: none`; malformed agent not recognized; `mcp list` empty | REAL-CLAUDE | recorded in Phase 2G (HOME/CLAUDE_CONFIG_DIR only, so now superseded); **re-run required in the sandbox, see below** |
| `--tools` / `--disallowedTools` remove Write/Edit/MultiEdit/NotebookEdit/Bash from the session's tool list (exposure level only) | REAL-CLAUDE | new in 2G.1, **not executed in the authoring environment** |
| Sandbox confines writes, hides the real config, profile compiles | REAL-OS | profile compile verified; enforcement **not executed in the authoring environment** |
| Snapshot is metadata-only and stable | REAL-OS | verified |
| Scope guard denies read-only writes / confines writers / fails closed | real script, not Claude Code | verified |
| Generated frontmatter denies write tools; verification rejects tampering | SIMULATED (static) | verified |
| Claude Code honors agent `tools`/`disallowedTools`/`permissionMode`/`hooks` when a model attempts a write | needs live model | **UNVERIFIED / BLOCKED** |

The authoring session ran inside a harness that is itself sandboxed, so macOS refused to nest
a second sandbox (`sandbox_apply: Operation not permitted`). Per design, every sandbox-dependent
test was therefore skipped and `claude` was **not executed at all**. Run `npm test` from a normal
terminal on macOS to produce the REAL-CLAUDE evidence; skipped tests are not passes.

### What Linux CI verifies vs what needs macOS

`.github/workflows/pr-validation.yml` runs on `ubuntu-latest`. Its green result means:

- **Verified on Linux CI:** generator/apply/verify logic, validators, SIMULATED tests (profile text,
  env allowlist, decision logic, snapshot diff), and the evidence guard
  (`tests/runtime-evidence.test.mjs`).
- **NOT verified on Linux CI (skipped, BLOCKED):** every `REAL-OS` sandbox test and every
  `REAL-CLAUDE` test. They need macOS `sandbox-exec` (and the `claude` CLI). A skip is not a pass.
- **Required macOS evidence:** run `npm test` in a normal macOS terminal (not inside another
  sandbox) with `claude` installed; `node tests/support/runtime-evidence.mjs` must print
  `RUNTIME-CAPABLE` first.

The CI step "Phase 2G.1 runtime evidence state" prints `BLOCKED-UNVERIFIED` on Linux. Setting
`DAC_CLAIM_RUNTIME_VERIFIED=1` makes that script exit 1 unless the environment is
`RUNTIME-CAPABLE`, and a test fails if the workflow sets that variable on a non-macOS runner.

**Protected-read denial states.** `verifySandbox` proves the deny rules against a *synthetic decoy
home* (`checks.decoyProtectedReadDenied`, including `.claude.json.backup`/`.lock`/`~`/`.d/` siblings
and a readable out-of-scope control). Real `~/.claude*` are opened (zero bytes) only if they
exist: `checks.realProtectedRead` is `denied`, `violated` or `untested` (absent; no real-path
claim is made). Protection scope equals snapshot scope: `~/.claude` and every `~/.claude.json*`.

### Read-only tool enforcement probe

A real proof needs a model to *attempt* a write. The probe (`runReadOnlyProbe`) starts the
generated `code-reviewer` (`--agent code-reviewer --permission-mode plan`) in the sandbox,
asks it to create `canary.txt` (Write) and `canary2.txt` (Bash), and judges by OS facts: no
canary and a byte-identical workspace, plus the transcript (write/shell tools absent from
the session `init`, or every attempt refused). Verdicts: `ENFORCED`, `VIOLATED`,
`INCONCLUSIVE` (e.g. the model just declined; proves nothing), `UNVERIFIED`.

A model turn needs a credential and network, and this project never copies or uses the
user's credentials/OAuth. The probe therefore runs **only** if the operator explicitly sets
`DAC_PROBE_ANTHROPIC_API_KEY` (a name chosen so an ambient `ANTHROPIC_API_KEY` is never
picked up; the key enters the sandbox only as `ANTHROPIC_API_KEY`, network is then allowed).
Without it the verdict is **UNVERIFIED (BLOCKED)**, which is the current state. Instruction
text ("do not write") is never accepted as enforcement; only tool allow/deny and OS facts are.
`--bare` is not used: it ignores OAuth and needs an API key, and it skips project discovery
that the agent definitions depend on.

### Limitations

- Only macOS `sandbox-exec` (deprecated by Apple, still functional) is implemented. Linux/Windows
  and nested sandboxes: tests are skipped (BLOCKED), never weakened.
- The snapshot is detective, metadata-only, and can show false differences when another
  Claude Code session of the user runs concurrently.
- The sandbox does not block Mach/XPC services; Keychain is not read because
  `CLAUDE_CONFIG_DIR` changes the credential namespace and no credential is looked up, but this
  is not enforced by the sandbox.
- Offline `init` evidence shows what is *registered*, not what a model may do.
- That subagent `hooks` fire, and that read-only denial holds in a live session, remain unverified.
- Context7 enabled (`.mcp.json`) is content-verified only; never launched or connected.
- Skills' `adapters.claude-code` status stays `untested` in the canonical catalog.

## Warnings

- Optional agents and Context7 are opt-in; enabling is a deliberate user decision.
