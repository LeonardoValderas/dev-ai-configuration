# dev-ai-configuration

A portable, tool-agnostic standard for how AI coding tools should
operate: Git hygiene, permission handling, validation, and reporting
conventions that are shared across tools rather than owned by any one
of them.

## Purpose

AI coding assistants (Claude Code, Codex, Cursor, and others) each have
their own configuration surface, but the underlying expectations for
how they should behave — safety, validation rigor, honest reporting —
should not need to be redefined per tool. This repository defines
those expectations once, as a neutral standard, and provides adapters
that translate them into each tool's native configuration.

## Scope

In scope:
- Neutral, tool-agnostic standards for safe and validated AI-assisted
  development.
- Documentation of the architecture that separates standards from
  tool-specific adapters.
- A scaffold for future adapters, templates, installer logic, and
  compatibility notes.

Out of scope (not included in this repository, ever):
- Any specific private orchestrator, deployment, or infrastructure
  configuration.
- Machine-local or per-device configuration.
- Secrets, credentials, tokens, or session data.

## Portability and independence

This repository is self-contained and portable. It does not depend on,
reference, or assume any specific host, private network, or deployment
environment — including any particular remote-access tooling, virtual
private server, or overlay network. It can be cloned onto any machine
and used standalone.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full layer
breakdown. In summary:

- `standards/` — neutral, tool-agnostic rules.
- `adapters/` — per-tool translations of those rules (e.g. Claude Code,
  Codex, Cursor).
- `templates/` — reusable config skeletons consumed by adapters or an
  installer.
- `installer/` — future mechanism to apply standards to a target
  machine or project.
- `compatibility/` — notes on which tool versions are known to work
  with this standard.
- `docs/` — human-facing documentation.

Machine-local configuration and private orchestrator configuration are
explicitly excluded from all of the above — see
[docs/architecture.md](docs/architecture.md#explicit-boundaries).

## Security principles

See [docs/security-principles.md](docs/security-principles.md).

## Quick Start (real commands only)

Prerequisites (this repository installs none of them): Node 20+, git, and the tool for each
provider you choose:

- `claude-code`: Claude Code CLI.
- `codex`: Codex CLI.
- `cursor`: Cursor IDE and/or Cursor Agent CLI. These are distinct surfaces. The
  adapter writes project files usable by both, but capability and enforcement evidence
  differs between them.

1. Clone this repository on the new Mac, check it out cleanly, then run `npm test` and
   `npm run validate`. The bootstrap refuses to run from a checkout that is not a valid Git
   repository, has uncommitted or untracked changes, or has an unverifiable `HEAD`.

```
git clone https://github.com/LeonardoValderas/dev-ai-configuration.git
cd dev-ai-configuration
npm test
npm run validate
```

2. Target: a new or existing project directory (it may contain unrelated changes). Existing
   files that are not managed by the bootstrap are never merged or overwritten; they cause a
   CONFLICT with zero writes.
3. Plan, then apply (replace `<dir>`; `--provider` is repeatable or comma-separated, so Codex
   and Cursor can be installed together):

```
node installer/bootstrap.mjs plan --provider codex,cursor --target <dir>
node installer/bootstrap.mjs apply --provider codex,cursor --target <dir>
```

4. Verify at any time (no writes; reports missing, modified or invalid managed files):

```
node installer/bootstrap.mjs verify --target <dir>
```

5. Start SDD: `cd` into the target project and launch your installed provider tool (see
   [docs/project-bootstrap.md](docs/project-bootstrap.md#2a-provider-workflows)). Ask it to
   write the specification first under the canonical SDD in [docs/sdd.md](docs/sdd.md), and
   choose a mode (Full, Lightweight or Hotfix). Do not request implementation before the
   gates pass. Such a request is guidance only, not enforcement; the adapter does not execute
   SDD, and Spec Kit is not installed.
6. Update (explicit, never automatic): `git pull` here, then
   `node installer/bootstrap.mjs update --target <dir>`. Locally modified managed files make the
   update fail closed with zero writes.
7. Uninstall one provider: `node installer/bootstrap.mjs uninstall --provider <p> --target <dir>`.
   The shared `AGENTS.md` is kept while another provider still owns it.

### `dac` shortcut (claude-code or codex; thin facade, see [docs/dac-cli.md](docs/dac-cli.md))

Optional one-time command install (user-owned symlink, no `sudo`, manual PATH; see
[docs/dac-cli.md](docs/dac-cli.md#install-the-dac-command-one-time-user-owned-symlink)). From inside a
Git project, using this clean checkout (`dac init` with no flags in a terminal is interactive: path,
package name, provider, optional confirmed `git init`, then a preview and a `[y/N]` before any write):

```
node <clone>/bin/dac.mjs init                       # interactive (terminal only)
node <clone>/bin/dac.mjs init --provider codex      # non-interactive: shows the dry-run, then applies
node <clone>/bin/dac.mjs update                     # bootstrap update for the installed project
node <clone>/bin/dac.mjs start                      # foreground custodian (Ctrl-C stops)
node <clone>/bin/dac.mjs status [--json]
node <clone>/bin/dac.mjs sdd plan --handoff <ID>    # then: sdd apply --handoff <ID>; sdd verify --project <ID>
node <clone>/bin/dac.mjs stop
node <clone>/bin/dac.mjs brief                      # open DAC Brief Studio (local HTML form -> PRD + DAC prompt); works outside a DAC project
node <clone>/bin/dac.mjs implement <task-id>        # implement one persisted SDD task in an isolated worktree (trusted-terminal authorization, blocking audit)
node <clone>/bin/dac.mjs review <task-id>           # independent read-only review of the audited run (separate session, exact audit/diff hash)
```

`dac brief` opens [DAC Brief Studio](docs/brief-studio.md), a static local HTML form (`tools/brief-studio/index.html`) that turns an
idea into a PRD and a DAC prompt for read-only SDD planning. It runs entirely in the browser: no server, no network
transmission of the form, no dependencies; it keeps a draft in the browser's `localStorage` (do not enter secrets or customer
data). On macOS it opens the file in the default browser; on other platforms it prints the absolute path. It needs no DAC project.

`dac implement` / `dac review` (Increment B, [docs/dac-implement-review.md](docs/dac-implement-review.md)): the Writer now also
persists Plan/Tasks as `.sdd/artifacts/<project-id>/project.json` (documentation only; it authorizes nothing). `implement`
verifies the persisted context, asks on the trusted terminal for an authorization bound to the exact task, base, scope,
validation commands and prompt, creates the branch/worktree itself, launches Codex only through an explicit safe profile and
audits everything afterwards (a worktree is not a sandbox). It never commits, merges, publishes or cleans up. **Verified with
simulated runners only; real Codex behavior is pending the second-Mac pilot** in that document.

Each project records the standard version and the full 40-hex source commit in
`.dac/standard.json`, and the shared `AGENTS.md` ownership in `.dac/shared.json`. The per-provider
commands under `adapters/<provider>/cli.mjs` still exist (single provider, legacy manifests).
Use `installer/bootstrap.mjs` for new projects; it migrates a legacy Codex or Cursor install
on `apply` or `update` only when its `AGENTS.md` is still the canonical, unmodified file.

Known limitations: Context7 is off by default (`--context7` is an explicit opt-in); authenticated
enforcement is UNVERIFIED; Claude Code does not create `CLAUDE.md`. Cursor: the IDE and the Agent
CLI are separate surfaces and enforcement is unverified for both; see
[docs/codex-cursor-adapters.md](docs/codex-cursor-adapters.md). Transactions are in-process
journaled rollbacks, not protection against a process kill mid-apply.

## Contracts, manifests and validators (Phase 2B)

- `standards/schemas/` — JSON Schema (draft 2020-12) for the task contract,
  result format, and agent / skill / MCP / adapter / technology-profile
  manifests (single source of truth).
- `compatibility/matrix.json` — supported schema versions, standard versions
  and target tools.
- `installer/validate.mjs` — dependency-free, read-only, credential-free
  validator (`npm run validate`; tests via `npm test`, Node 20+).
- `tests/fixtures/` — valid and invalid fixtures, each invalid one tied to an
  expected error code.

See [docs/manifest-format.md](docs/manifest-format.md) and
[docs/adding-components.md](docs/adding-components.md).

## Current status: Phase 2I-B (project bootstrap)

_This section is the single canonical phase-state reference; other documents link here._

Phase 2I-B implements the portable project bootstrap designed in
[docs/project-bootstrap.md](docs/project-bootstrap.md): `installer/bootstrap.mjs` with `plan`,
`apply`, `verify`, `update` and `uninstall`, built on the Phase 2H generators and the shared
transactional installer. Provider enforcement of the generated read-only/deny settings remains
**UNVERIFIED**, and the macOS provider-CLI gate is not part of this phase.

Phase 2A scaffold plus the shared contracts, schemas and validators above, and
(Phase 2C) the portable catalog of the 12 original agents (10 manifests:
8 primary, 2 optional; 2 redundant entries without manifest) under
`standards/manifests/agents/`, see [docs/agent-catalog.md](docs/agent-catalog.md),
and PR validation CI, and (Phase 2D) the portable skill catalog of the 21
original skills (2 CORE manifests, 18 quarantined, 1 deprecated, no adapters
claimed) under `standards/manifests/skills/`, see
[docs/skill-catalog.md](docs/skill-catalog.md), and (Phase 2E) the
provider-neutral Spec-Driven Development (SDD) methodology under
`standards/sdd/`: one canonical ten-phase workflow, Full / Lightweight / Hotfix
modes, blocking gates, artifact contracts, an agent-to-phase map (all 8 primary
agents plus the independent `code-reviewer`), and a declarative, **not
installed, untested and not executable** integration manifest pinned to GitHub
Spec Kit v1.4.0. See [docs/sdd.md](docs/sdd.md) and
[docs/sdd-adoption.md](docs/sdd-adoption.md); artifact persistence: [docs/sdd-artifact-writer.md](docs/sdd-artifact-writer.md). Spec Kit is neither installed, run
nor copied by this repository; no provider compatibility is claimed.

**Third-party skill provenance and license.** The CORE skill
`supabase-postgres-best-practices` is carried from the official Supabase
repository (https://github.com/supabase/agent-skills, snapshot commit
`f421451c7956d9a79b8257ccc24a7ab6d16037e2`, path
`skills/supabase-postgres-best-practices`), MIT licensed, Copyright (c) 2026
Supabase. The full MIT text and a modification notice are in
`standards/manifests/skills/licenses/`. Of the 37 original files, 30 rule files
are carried over unchanged; the entry instructions are a modified rewrite. The
commit and URLs are recorded evidence, not checked at run time, and the snapshot
may be older than current upstream `main`. The following are **not yet
included** and are planned for later phases:

- Spec Kit installation and execution (only the declarative manifest exists).
- Context7 installation and runtime connection (declaration and validation are delivered).
- Executable MCP (Model Context Protocol) client/server configuration (declarations,
  policy validation and non-executable provider templates are delivered).

Phase 2G adds the portable Claude Code project adapter (`adapters/claude-code/`):
it generates and safely applies project-scoped agents, the two CORE skills, SDD
and contract rules, and a disabled-by-default Context7 setting. See
[docs/claude-code-adapter.md](docs/claude-code-adapter.md) for usage and the
separation of real versus simulated evidence. Phase 2G.1 runs the real CLI only in a
disposable, OS-sandboxed runtime (`CLAUDE_CONFIG_DIR` plus OS write denial, never the
user's `~/.claude`); live read-only tool enforcement remains UNVERIFIED (see the doc).

The SDD Artifact Writer can receive its input from a Claude Code session without a manual
`sdd-input.json`: `node installer/bootstrap.mjs apply --provider claude-code --sdd-handoff --target <dir>`
installs a stateless, submit-only MCP proxy (`.dac/runtime/sdd-handoff/`, project-relative config) while a
human-started in-memory custodian holds the envelope and the Writer still requires `/dev/tty` approval.
Claude Code is integrated; Codex has the same opt-in flag (`--provider codex --sdd-handoff`, project-local
`.codex/config.toml` MCP table exposing only `sdd_handoff_submit`) as a local pilot whose runtime
compatibility is **UNVERIFIED** until a real Codex session on the second Mac (exact instructions in
[docs/sdd-input-handoff.md](docs/sdd-input-handoff.md#7-codex-local-pilot-project-local-opt-in)). Cursor is unchanged.
That document also holds the exact lifecycle, failure behavior and the three honestly skipped tests.

Phase 2F adds an optional, disabled Context7 declaration and a sanitized,
quarantined MCP reference inventory. See the [portable MCP catalog, policy,
compatibility and adoption guide](docs/mcp-catalog.md). Provider templates are
non-executable specifications for future installer work; no servers are enabled.

Phase 2H adds native portable Codex and Cursor adapters. Both derive nine agents,
the two CORE skills, Full/Lightweight/Hotfix SDD and task/result contracts from the
canonical sources through shared renderers. They ship conservative read-only
settings: implementation and shell actions are BLOCKED until native enforcement
can preserve the canonical scope. Context7 remains disabled and disconnected.
See [the Phase 2H usage, compatibility and evidence ledger](docs/codex-cursor-adapters.md).
CLI help/version tests require proven macOS isolation; they never authenticate or
call a model. A sandbox refusal is reported as unverified, never silently bypassed.
