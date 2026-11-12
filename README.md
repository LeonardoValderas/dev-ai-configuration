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

## Current status: Phase 2A

This repository currently contains only the minimal scaffold:
directory structure, placeholder files, and this documentation. The
following are **not yet included** and are planned for later phases:

- Agents, skills, or any agent/skill definitions.
- Spec Kit integration.
- Context7 integration.
- MCP (Model Context Protocol) server configuration.
- Any implementation tooling, installer logic, or adapter content.

Nothing in this repository should be assumed functional beyond the
scaffold and documentation described here.
