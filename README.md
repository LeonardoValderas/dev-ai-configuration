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

## Current status: Phase 2H

_This section is the single canonical phase-state reference; other documents link here._

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
[docs/sdd-adoption.md](docs/sdd-adoption.md). Spec Kit is neither installed, run
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
