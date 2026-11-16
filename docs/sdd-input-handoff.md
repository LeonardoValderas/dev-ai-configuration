# SDD input handoff for Claude Code (PoC 2, installable)

Lets a Claude Code session hand a validated SDD Constitution/Specify envelope to the existing
[SDD Artifact Writer](sdd-artifact-writer.md) **without a manually created `sdd-input.json`**, while keeping
the Writer's human approval on `/dev/tty` untouched. Everything here is implemented and covered by
`tests/sdd-handoff.test.mjs` and `tests/claude-handoff-bootstrap.test.mjs`.

**Scope: Claude Code only.** Codex and Cursor adapters are unchanged and have no handoff wiring (asserted by tests); asking
the bootstrap for `--sdd-handoff` without `claude-code` fails with `OPTIONS`. macOS and Linux only (Unix sockets).

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
| `.mcp.json` | server `dac-sdd-handoff`: `node .dac/runtime/sdd-handoff/mcp-server.mjs --target . --runtime-dir ${DAC_SDD_RUNTIME_DIR}` (merged with Context7 if that is also enabled) |
| `.claude/settings.json` | `permissions.allow` is exactly `mcp__dac-sdd-handoff__sdd_handoff_submit`; `enabledMcpjsonServers` is exactly `["dac-sdd-handoff"]`; `enableAllProjectMcpServers` stays `false` |
| `.claude/agents/technical-planner.md` | the SDD-producing role (owner of `specify`) gains the single tool in `tools:`; still read-only (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` denied, `permissionMode: plan`) |

Properties (all tested): every distributed file is project-relative or an environment reference, with no machine-specific absolute path; the tool surface is exactly
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

### 3.2 Choose a secure absolute runtime directory (once per machine/user)

The runtime directory holds the socket and metadata; it is **never** derived from `TMPDIR`, the cwd or an environment default (the proxy and custodian require
an explicit absolute, normalized path). Requirements: a real path (no symlink components; on macOS use the resolved path), owned by you, mode `0700`
(the custodian creates it if its parent exists), every ancestor real and not group/world-writable, and short (`<dir>/h2-<20 hex>.sock` must stay under 100 bytes).

```
export DAC_SDD_RUNTIME_DIR="$HOME/.dac-sdd-handoff"   # use the real path if $HOME is an alias
```

### 3.3 Start, check, stop the custodian (separate terminal, left running)

```
node adapters/shared/sdd-handoff/custodian-cli.mjs start  --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR"   # foreground
node adapters/shared/sdd-handoff/custodian-cli.mjs status --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR"   # running | not-running | stale-socket; never prints content
node adapters/shared/sdd-handoff/custodian-cli.mjs stop   --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR"
```

(`npm run sdd-handoff -- start --target ...` is the same entry point.) Payloads live only in this process's memory; `stop`, Ctrl-C, SIGTERM or SIGHUP destroys all of them.

### 3.4 Open Claude Code in the target

```
cd <P> && DAC_SDD_RUNTIME_DIR="$DAC_SDD_RUNTIME_DIR" claude
```

Start Claude **from the project root** (the project-relative script path and `--target .` resolve against it) in a shell where `DAC_SDD_RUNTIME_DIR` is exported.
Accept Claude Code's workspace-trust prompt once; until then Claude ignores `permissions.allow` from project settings. If the variable is unset, Claude
reports the server as `failed` and the tool is unavailable (verified against the real CLI, no model call); the proxy itself also refuses a non-absolute runtime dir.

### 3.5 Generate and submit

Ask the `technical-planner` role (or the main session) to produce the Constitution/Specify and call `sdd_handoff_submit`
(`project_id`, `operation`, optional `markdown`, `constitution`, `specify`). The custodian validates with the unchanged writer `plan()` (zero writes, same schemas and
SDD gates) and keeps the envelope in memory. The result contains `handoff_id`, `plan_digest`, `would_write`, `expires_at` and two **human commands**.
In an installed project they print `<DAC_CHECKOUT>` in place of `<DAC>`; substitute your checkout path. Claude must not run them; approval is not available to it.

### 3.6 Writer: plan, apply, verify (human terminal)

```
node adapters/shared/sdd-writer/cli.mjs plan  --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR" --handoff <id>   # repeatable, never consumes
node adapters/shared/sdd-writer/cli.mjs apply --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR" --handoff <id>   # asks for the exact phrase on /dev/tty
node adapters/shared/sdd-writer/cli.mjs verify --target <P> --project <project_id>
```

Claude may be closed before `apply`. The handoff is consumed only after a successful transactional apply. `--input <file>` keeps working exactly as before
(mutually exclusive with `--handoff`).

### 3.7 Cancellation, expiry, restarts, failures

| Situation | Behavior |
|---|---|
| Cancel | `custodian-cli.mjs cancel --target <P> --runtime-dir "$DAC_SDD_RUNTIME_DIR" --handoff <id>`; later use gives `HANDOFF_NOT_FOUND`. A handoff being applied cannot be cancelled (`HANDOFF_LEASED`). |
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
