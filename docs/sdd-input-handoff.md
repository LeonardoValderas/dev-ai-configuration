# SDD input handoff for Claude Code and Codex (PoC 2, installable)

Lets a Claude Code or Codex session hand a validated SDD Constitution/Specify envelope to the existing
[SDD Artifact Writer](sdd-artifact-writer.md) **without a manually created `sdd-input.json`**, while keeping
the Writer's human approval on `/dev/tty` untouched. Everything here is implemented and covered by
`tests/sdd-handoff.test.mjs`, `tests/claude-handoff-bootstrap.test.mjs` and `tests/codex-handoff-bootstrap.test.mjs`.

**Scope: Claude Code (sections 1-6) and Codex (section 7, local pilot).** Both use the *same* custodian, stateless proxy, Writer and
`.dac/runtime/sdd-handoff` files; only the provider configuration differs. The Cursor adapter is unchanged and has no handoff wiring
(asserted by tests). Asking the bootstrap for `--sdd-handoff` without `claude-code` or `codex` fails with `OPTIONS`, and one project carries the runtime
for exactly one of the two (they would own the same files). macOS and Linux only (Unix sockets).
**Codex runtime compatibility is UNVERIFIED until a real Codex session on the second Mac has called the tool (section 7.4).**

## 1. Components and who owns what

| Component | Runs from | Lifetime | Owns / writes |
|---|---|---|---|
| **Custodian** (`adapters/shared/sdd-handoff/custodian-cli.mjs`) | this repository checkout | started and stopped by the human, foreground | memory only; a `0600` socket and a tiny non-payload metadata file in the human-chosen runtime dir |
| **MCP proxy** (`.dac/runtime/sdd-handoff/mcp-server.mjs`) | the **target project** (installed by the bootstrap) | started by Claude Code per session, stateless | nothing |
| **Writer** (`adapters/shared/sdd-writer/cli.mjs`) | this repository checkout | run by the human | `.sdd/` only, after `/dev/tty` approval |
| **Bootstrap** (`installer/bootstrap.mjs`) | this repository checkout | run by the human | the runtime files and config below, via the existing manifest/journal |

The custodian and the Writer need this repository's schemas and clean-Git source gate, so they are deliberately **not** copied into
projects. Only the submit-only proxy and its five dependency-free helpers are installed.

## 2. What the bootstrap installs (`--sdd-handoff`, Claude Code only, off by default)

Installed through the existing Claude Code generator, `createInstaller` planner, shared journaled executor, per-provider manifest
(`.claude/dac-manifest.json`, `sdd_handoff: true`) and `.dac/standard.json` record. There is no second installer.

| Path | Purpose |
|---|---|
| `.dac/runtime/sdd-handoff/{mcp-server,client,endpoint,core,errors,identity}.mjs` | the stateless submit-only proxy (hash-tracked, self-contained: no import leaves this directory) |
| `.mcp.json` | server `dac-sdd-handoff`: `node .dac/runtime/sdd-handoff/mcp-server.mjs --target .` (no runtime-dir argument, no environment variable; merged with Context7 if that is also enabled) |
| `.claude/settings.json` | `permissions.allow` is exactly `mcp__dac-sdd-handoff__sdd_handoff_submit`; `enabledMcpjsonServers` is exactly `["dac-sdd-handoff"]`; `enableAllProjectMcpServers` stays `false` |
| `.claude/agents/technical-planner.md` | the SDD-producing role (owner of `specify`) gains the single tool in `tools:`; still read-only (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` denied, `permissionMode: plan`) |

Properties (all tested): every distributed file is project-relative (the only absolute strings are the fixed endpoint constants in `endpoint.mjs`), with no machine-specific path and no environment reference; the tool surface is exactly
`sdd_handoff_submit` (no apply, cancel, shell, Write/Edit or target selection); `code-reviewer` and all implementers are unchanged and do not get the tool; nothing is
written outside the target, nothing in `$HOME` or any user-level provider config; `.sdd/` is never touched by bootstrap `apply`/`update`/`uninstall`
(byte-for-byte), and the Writer never touches `.dac/` or `.claude/`. No Constitution/Specify content, handoff id, capability, approval
phrase or payload byte is ever stored in `.dac`, a manifest or any installed file.

Unknown or conflicting existing files fail closed with zero writes (`CONFLICT`): a foreign `.mcp.json`, a foreign file at a runtime path, a symlinked
`.dac/runtime`, or a locally edited managed runtime file (also blocks `update` and `uninstall` until restored).

## 3. Executable lifecycle

`<DAC>` is the path of your clean checkout of this repository, `<P>` the target project. Commands run from `<DAC>` unless noted.

### 3.1 Install, verify, update, uninstall

```
node installer/bootstrap.mjs plan   --provider claude-code --sdd-handoff --target <P>   # no writes; lists files + dry run
node installer/bootstrap.mjs apply  --provider claude-code --sdd-handoff --target <P>
node installer/bootstrap.mjs verify --target <P>                                         # OK | DRIFT
node installer/bootstrap.mjs update --target <P>                                         # keeps the recorded option; refreshes managed files
node installer/bootstrap.mjs uninstall --provider claude-code --target <P>               # removes exactly the managed files
```

- Existing Claude Code project: `update` never opts a project in. Add the runtime with `apply --provider claude-code --sdd-handoff` and repeat any other
  option you installed with (`--context7`, `--optional-agent`), because `apply` records the options it is given. Re-running `apply` without
  `--sdd-handoff` removes only the managed runtime files and config entries.
- `.sdd/` stays byte-identical through all of the above.

### 3.2 The runtime directory is automatic (nothing to choose, nothing to export)

The custodian, the MCP proxy and the Writer all compute the same private endpoint directory from the platform and your user id only. It never depends on
`TMPDIR`, `HOME`, the working directory or any environment variable, so shells and sandboxes started differently still agree:

| Platform | Directory |
|---|---|
| macOS | `/private/tmp/dac-sdd-<uid>` (the real path of `/tmp`) |
| Linux | `/run/user/<uid>/dac-sdd` when `/run/user/<uid>` is a real directory owned by you, mode `0700`, under safe ancestors; otherwise `/tmp/dac-sdd-<uid>` |

Everything is validated on use and nothing foreign is ever repaired: every component must be a real directory (no symlinks), the directory must be owned by you with mode
`0700` (created that way by the first `start`), ancestors must be owned by root or you and not group/world-writable unless sticky, and the socket must be a real socket owned by
you with mode `0600` whose inode matches the recorded metadata. The socket path limit is checked in bytes. Windows and other platforms are unsupported.

*Advanced / tests only, not part of the normal flow:* `--runtime-dir <absolute normalized path>` on the custodian CLI, the Writer and the MCP proxy selects a different directory
(it must then be given to all three, with the same validation). No generated configuration uses it.

### 3.3 Start, check, stop the custodian (separate terminal, left running)

```
node installer/bootstrap.mjs handoff start  --target <P>    # foreground; Ctrl-C stops it
node installer/bootstrap.mjs handoff status --target <P>    # running | not running | stale socket; never prints content
node installer/bootstrap.mjs handoff stop   --target <P>
```

These are a thin facade over `adapters/shared/sdd-handoff/custodian-cli.mjs` (same arguments; `npm run sdd-handoff -- start --target <P>` is the same entry point) and need no
Git source gate. Payloads live only in this process's memory; `stop`, Ctrl-C, SIGTERM or SIGHUP destroys all of them.

### 3.4 Open Claude Code in the target

```
cd <P> && claude
```

Start Claude **from the project root** (the project-relative script path and `--target .` resolve against it). Accept Claude Code's workspace-trust prompt once; until then Claude ignores
`permissions.allow` from project settings. If no custodian is running the tool returns `CUSTODIAN_UNAVAILABLE` with the command to start it.

### 3.5 Generate and submit

Ask the `technical-planner` role (or the main session) to produce the Constitution/Specify and call `sdd_handoff_submit`
(`project_id`, `operation`, optional `markdown`, `constitution`, `specify`). The custodian validates with the unchanged writer `plan()` (zero writes, same schemas and
SDD gates) and keeps the envelope in memory. The result contains `handoff_id`, `plan_digest`, `would_write`, `expires_at` and two **human commands**.
In an installed project they print `<DAC_CHECKOUT>` in place of `<DAC>`; substitute your checkout path. Claude must not run them; approval is not available to it.

### 3.6 Writer: plan, apply, verify (human terminal)

```
node adapters/shared/sdd-writer/cli.mjs plan  --target <P> --handoff <id>   # repeatable, never consumes
node adapters/shared/sdd-writer/cli.mjs apply --target <P> --handoff <id>   # asks for the exact phrase on /dev/tty
node adapters/shared/sdd-writer/cli.mjs verify --target <P> --project <project_id>
```

Claude may be closed before `apply`. The handoff is consumed only after a successful transactional apply. `--input <file>` keeps working exactly as before
(mutually exclusive with `--handoff`).

### 3.7 Cancellation, expiry, restarts, failures

| Situation | Behavior |
|---|---|
| Cancel | `custodian-cli.mjs cancel --target <P> --handoff <id>`; later use gives `HANDOFF_NOT_FOUND`. A handoff being applied cannot be cancelled (`HANDOFF_LEASED`). |
| TTL | Exactly 600 s from submit: live at +599999 ms, gone at +600000 ms; expired payloads are purged from memory. |
| Capacity / size | 16 live handoffs; 512 KiB envelope. |
| Denial, timeout, no TTY, drift, failed apply with clean rollback | Nothing consumed; the handoff stays retryable until TTL. |
| MCP proxy or Claude closed/restarted/`kill -9` | Handoffs are untouched; a new proxy reaches the same custodian. |
| Custodian stopped | All handoffs are destroyed; the proxy returns `CUSTODIAN_UNAVAILABLE` with the start command; Writer `--handoff` fails closed with zero writes. A restarted custodian is a new instance and old ids never resolve. |
| Hard kill (`kill -9`) of the custodian | An orphan socket remains. `status` reports `stale-socket` and removes nothing; `start` or `stop` removes it only after proving it is your private socket **and** that connecting is refused (never by age). A live listener or a non-socket file is never removed. |
| Apply persisted but commit unconfirmed, or apply failed **and** rollback failed | Exit code 3, `handoff.consumption = "uncertain"` with evidence; the Writer is never re-run automatically. Run `verify`, then cancel the handoff. |
| Unset/relative runtime dir, wrong target, substituted socket, loose permissions | Fail closed (`HANDOFF_ENDPOINT`) before any request is sent. |

Validation errors returned to the agent are redacted projections (`code`, `rule`, `path`, a bounded template message): submitted ids, field names and values are never echoed back.

## 4. Safety invariants kept from the Writer and PoC

Trusted `/dev/tty` approval of the exact plan digest and nonce (no flag, env, stdin or file can approve); unchanged schemas and SDD gates; one custodian per target
and runtime dir; Unix socket only; `probeEndpoint` is coupled to the private-socket checks (see below); the proxy accepts no endpoint, runtime or target argument from the model.

`probeEndpoint` (liveness by connect probe) **must only be used on a socket that has passed `assertPrivateSocket`** (real socket, not a symlink, owned by the current user, mode `0600`).
The check is inside the function, so an unverified path is never connected to and is reported as `HANDOFF_ENDPOINT`; deleting a socket additionally requires the
`stale` (connection refused) answer. This is regression-tested (test 16).

## 5. Evidence and honest limits

- Verified here: generation/apply/verify/update/uninstall on disposable projects, rollback at injected faults, conflicts, `.sdd` preservation, no global/HOME writes, installed proxy
  from the project root with no `sdd-input.json` through a real custodian and the Writer, real Claude Code 2.1.x starting the portable config (`connected`, exactly one tool, no model call),
  real PTY approval flow, TMPDIR/cwd independence.
- **UNVERIFIED** (needs a model credential, not available or permitted here): a live Claude model session actually calling `sdd_handoff_submit` and honoring subagent `tools`/`disallowedTools`.
- Same-uid processes can connect to the socket (Node's standard library does not expose Unix-socket peer credentials); access control is the `0700` directory and `0600` socket. A same-uid attacker can also read process memory.
- `--target .` assumes Claude was started from the project root; from a subdirectory the proxy targets that directory and finds no custodian (fails closed).
- The Writer's own error output to the human terminal is unchanged from the `--input` path and is not redacted; only forwarding to the agent is.

## 6. Skipped tests in the full suite (exactly three)

`npm test` reports `skipped 3`. Each is an honest "not proven here", never converted to a pass (`tests/skip-inventory.test.mjs` fails if this list drifts):

| Test | Why it is skipped |
|---|---|
| `LIVE-OPT-IN: read-only agent cannot write in a live model session` (`tests/claude-runtime.test.mjs`) | Needs a live model turn with an operator-supplied `DAC_PROBE_ANTHROPIC_API_KEY`; none is supplied, so the verdict stays UNVERIFIED (its companion `GATE:` test asserts exactly that). |
| `AUTHENTICATED-ENFORCEMENT: explicitly unverified; no model calls permitted` (`tests/portable-runtime.test.mjs`) | Authenticated provider enforcement is forbidden by Phase 2H scope; help/version probes are not runtime-enforcement evidence. |
| `the original skills are unmodified` (`tests/skills.test.mjs`) | Runs only when `DAC_SKILL_ORIGINALS` points at the upstream original skills, which are not in this repository. |

Other tests skip only when a prerequisite is missing (macOS sandbox, `claude` CLI, `python3` PTY) and then report `BLOCKED`/unavailable; none skipped in this environment, and `DAC_REQUIRE_PTY=1` turns a missing PTY into a failure.
The Codex handoff tests (`tests/codex-handoff-bootstrap.test.mjs`) add **no skip**: they never need or run a Codex binary, and the live-Codex question is documented as UNVERIFIED (section 7.4) instead of as a hidden skipped test.

## 7. Codex (local pilot, project-local, opt-in)

Implemented with the same engine as everything else: the shared portable generator, the `createInstaller` planner and journaled executor, the
`.codex/dac-manifest.json` ownership manifest and the `.dac/standard.json` record. No Codex-specific broker, writer or validation exists. No Codex
session was started and nothing was installed or written to `~/.codex` or any user-level configuration while implementing this. (The pre-existing
`tests/portable-runtime.test.mjs` runs only `codex --version`/`--help`, inside an OS sandbox with a disposable HOME, if a `codex` binary is on `PATH`; that is binary-startup evidence only, unchanged by this work, and proves nothing about project config loading.)

### 7.1 What `--sdd-handoff` installs for Codex

| Path | Purpose |
|---|---|
| `.dac/runtime/sdd-handoff/{mcp-server,client,endpoint,core,errors,identity}.mjs` | the identical stateless submit-only proxy that Claude Code uses (byte-equal, tested) |
| `.codex/config.toml` | the existing read-only defaults plus one table, `[mcp_servers.dac-sdd-handoff]` (below) |
| `.codex/agents/technical-planner.toml` | the SDD-producing role gains a "SDD handoff" instruction block; sandbox stays `read-only`, `shell_tool = false` |
| `.codex/dac-manifest.json` | gains `sdd_handoff: true`; `.dac/standard.json` provider entry `codex` gains `sdd_handoff: true` |

The generated server table (project-relative, no machine path, no secret):

```toml
[mcp_servers.dac-sdd-handoff]
command = "node"
args = [".dac/runtime/sdd-handoff/mcp-server.mjs", "--target", "."]
enabled = true
enabled_tools = ["sdd_handoff_submit"]
```

- **Target and endpoint are fixed by this trusted generated config**, never by model arguments: `--target .` is the project root (Codex launches the server in the
  project working directory) and the endpoint is the automatic one of section 3.2. The tool schema has no target, runtime, endpoint or apply field
  and rejects unknown fields (tested against the real proxy started with this exact command).
- `node` runs the installed proxy **directly**: no `sh -c` launcher, no `env_vars` forwarding, no variable expansion, nothing to export. `shell_tool = false`,
  `sandbox_mode = "read-only"`, `approval_policy = "never"` are unchanged and nothing else is granted. With no custodian running the tool returns `CUSTODIAN_UNAVAILABLE`.
- **Upgrading a project installed with the earlier config** (env placeholder / `sh -c` launcher): run `node installer/bootstrap.mjs update --target <P>` from a clean checkout. `update` takes no
  provider or option flags (it keeps the recorded ones), replaces only the managed handoff files, reports `CONFLICT` with zero writes if a managed file was edited locally, and leaves `.sdd/` and every unknown file untouched.
- **Exactly one tool is exposed** (`enabled_tools`); there is no Write, Edit, shell, approval or apply tool. Codex MCP servers are session-wide rather than per agent, so every
  Codex role in that project can call the submit tool; all roles remain read-only and the submit tool writes nothing. Approval exists only in the Writer on `/dev/tty`.
- The neutral `AGENTS.md` shared by Codex and Cursor is **not changed** by the option (byte-identical, tested). Its `.dac/shared.json` ledger keeps both owners; uninstalling either
  provider keeps the file while the other owns it.
- Existing files are never overwritten: a foreign `.codex/config.toml`, a foreign file at a runtime path, a symlinked `.dac/runtime` or a locally edited managed file is a `CONFLICT` with zero writes.
  Apply/update/uninstall are journaled and rolled back at every injected fault. `update` keeps the recorded option and never opts a project in; re-running `apply` without
  `--sdd-handoff` removes only the managed runtime files and the config table, restoring the previous managed bytes.
- Limits: one provider per project owns `.dac/runtime/sdd-handoff` (`--provider claude-code,codex --sdd-handoff` or adding Codex's handoff next to Claude's is refused with `OPTIONS`, zero writes);
  Codex without the option can still coexist with a Claude handoff install.

### 7.2 Exact second-Mac pilot instructions

Prerequisites on the second Mac: Node >= 20, Git, an authenticated Codex CLI >= 0.154.0 (your own login; nothing here stores credentials), a clean clone of this repository
on this branch (`<DAC>`; the bootstrap and the Writer require it to be a clean Git checkout with a verifiable HEAD, so commit nothing into it and keep it unmodified), and a disposable
target project directory `<P>` outside `<DAC>`. Use real (non-symlinked) absolute paths.

```
# 1. install (from <DAC>)
cd <DAC> && npm test && npm run validate                 # expect: fail 0, skipped 3 (section 6)
node installer/bootstrap.mjs plan  --provider codex --sdd-handoff --target <P>   # no writes
node installer/bootstrap.mjs apply --provider codex --sdd-handoff --target <P>
node installer/bootstrap.mjs verify --target <P>                                  # expect OK

# 2. custodian (terminal A, leave running; the endpoint directory is automatic, section 3.2)
cd <DAC> && node installer/bootstrap.mjs handoff start --target <P>

# 3. Codex (terminal B): from the project root, trusting the project when asked
cd <P> && codex
#   in Codex: /mcp   -> dac-sdd-handoff must be listed with exactly one tool: sdd_handoff_submit
#   ask the technical-planner role for a Constitution/Specify for project id demo-project and to call sdd_handoff_submit
#   Codex returns handoff_id, plan_digest and two human commands; it must NOT run them

# 4. human terminal C: Writer plan, then apply (approval is typed on /dev/tty; replace <DAC_CHECKOUT> with <DAC>)
node <DAC>/adapters/shared/sdd-writer/cli.mjs plan   --target <P> --handoff <id>
node <DAC>/adapters/shared/sdd-writer/cli.mjs apply  --target <P> --handoff <id>
node <DAC>/adapters/shared/sdd-writer/cli.mjs verify --target <P> --project demo-project

# 5. clean up
node installer/bootstrap.mjs handoff stop --target <P>
node installer/bootstrap.mjs uninstall --provider codex --target <P>              # .sdd/ stays
```

Do not pass `--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--sandbox workspace-write` or a profile that widens the sandbox. Keep `$CODEX_HOME` and any
global Codex config free of other `mcp_servers`/`approval_policy` overrides for this pilot (a user-level setting can outrank project config; that is outside what these files control).

### 7.3 What to record from the pilot

For each line, write PASS / FAIL / NOT-OBSERVED with the Codex CLI version: (a) project `.codex/config.toml` is loaded and the project is trusted; (b) `dac-sdd-handoff` starts (not `failed`) when
launched from the project root with no environment setup; (c) the direct `node` command starts with the project root as working directory; (d) `enabled_tools` exposes only
`sdd_handoff_submit`; (e) with `approval_policy = "never"` and `read-only`, the model is allowed to call that MCP tool (if Codex requires an MCP approval that `never` auto-denies, record it; do **not** relax
the policy to make it pass); (f) a submitted envelope appears in the custodian and `plan --handoff` shows it; (g) Codex could not write, run a shell or approve; (h) `apply --handoff` writes only `.sdd/`.

### 7.4 Evidence status (honest)

- **Verified locally (no Codex binary involved):** generation, determinism and the canonical verifier (tamper rejection), bootstrap plan/apply/verify/update/uninstall on disposable projects, existing-project update and opt-in/opt-out,
  conflicts with zero writes, rollback at injected faults, shared-`AGENTS.md` ownership with Cursor, Cursor untouched, no writes outside the managed scope and none in `$HOME`, the exact direct `node` launcher from the generated config starting the real
  proxy from the project root (one tool, unknown fields rejected, inert environment, fail-closed without a custodian), the automatic endpoint across different TMPDIR/HOME/cwd, and migration of earlier installs by `update`, and the end-to-end flow through a real custodian and the Writer with no `sdd-input.json`.
- **UNVERIFIED until the pilot above:** that real Codex (a) reads project-local `.codex/config.toml` MCP tables with these keys (`command`, `args`, `enabled`, `enabled_tools`; the table shape follows the repository's existing
  `[mcp_servers.context7]` template and the Codex configuration reference listed in [codex-cursor-adapters.md](codex-cursor-adapters.md)), (b) starts the server with the project root as working directory,
  (c) applies `enabled_tools`, (d) permits an MCP call under `approval_policy = "never"` + `read-only`, and (e) a live model actually calls `sdd_handoff_submit`. The CLI integration/enforcement status in
  `standards/manifests/adapters/codex.json` (`authenticated_enforcement: unverified`) is unchanged.
