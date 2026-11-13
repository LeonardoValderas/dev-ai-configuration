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

**Real** (installed CLI, temp project, `HOME` and `CLAUDE_CONFIG_DIR` redirected to a temp
directory outside the user's home; no model call, no credentials):

- the CLI's offline `init` event lists all 9 generated agents and both skills, not
  `payment-integration`, with `mcp_servers: []` and `permissionMode: default`;
- an agent file without frontmatter is *not* recognized (detection is not vacuous);
- `claude mcp list` reports no servers for the default project.

**Real, but not through Claude Code**: the scope-guard script is executed as a subprocess with
Claude-style PreToolUse JSON (read-only write is denied with `BLOCKED`, in-scope allowed,
garbage input fails closed with exit 2); apply/conflict/idempotence/rollback/uninstall run on
real temp directories; SDD project records validate against the generated workflow.

**Simulated / untested** (cannot be proven safely without a model session or network):

- that Claude Code honors `tools`/`disallowedTools`/`permissionMode` per agent at run time;
  the read-only denial is proven on the generated files and the guard, not by a live session;
- that the frontmatter `hooks` of a subagent actually fire in 2.1.318;
- Context7 enabled (`.mcp.json`): content is verified, but never launched or connected;
- skills' `adapters.claude-code` status stays `untested` in the canonical catalog, so the
  adapter manifest declares agents only.

## Warnings

- Tests that run the real CLI are skipped when it is absent or when no temp directory exists
  outside the home directory: Claude Code also loads `.claude` directories found in
  *ancestors* of its working directory, which would read user-level configuration.
- Optional agents and Context7 are opt-in; enabling is a deliberate user decision.
