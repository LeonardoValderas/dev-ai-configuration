# Architecture

This document defines the layered structure of the shared AI-development
standard and how each layer's responsibilities are bounded.

## Layers

### 1. Neutral shared standards (`standards/`)

Tool-agnostic rules, conventions, and policies that any AI coding tool
should follow: how to handle Git state, permissions, validation, and
reporting. This layer contains no references to a specific vendor, CLI,
or product. It is the single source of truth that other layers adapt
from.

### 2. Tool adapters (`adapters/`)

Thin translation layers that map the neutral standards onto the
configuration surface of a specific tool (e.g. Claude Code, Codex,
Cursor). An adapter should only translate — it must not introduce new
policy. If a tool cannot express a standard, the adapter documents the
gap rather than silently dropping it.

### 3. Templates (`templates/`)

Reusable, parameterized file/config skeletons (e.g. starter config
fragments, example policy files) that adapters or an installer can
instantiate. Templates contain placeholders, not machine-specific or
personal values.

### 4. Installer (`installer/`)

The mechanism that will eventually apply standards and adapters to a
target machine or project. It currently contains only the read-only
validator (`validate.mjs`); no installation logic is implemented.

### 5. Compatibility (`compatibility/`)

Notes and (eventually) checks describing which versions of which tools
are known to work with which versions of this standard. Currently holds
`matrix.json` (see the README for current phase state).

### 6. Docs (`docs/`)

Human-facing documentation: architecture, security principles, and
future design notes. Not consumed by tooling at runtime.

## Explicit boundaries

- **Machine-local configuration** (API keys, local paths, per-device
  settings, OS-specific state) is never part of this repository. It
  lives outside version control, on the machine where it is needed.
- **Private orchestrator configuration** (any project- or
  infrastructure-specific orchestration layer, including but not
  limited to private deployment, networking, or remote-access setups)
  is out of scope entirely. This repository does not assume, require,
  or integrate with any specific orchestrator, VPN/mesh network, or
  remote infrastructure.

## Portability and independence

This repository must be usable standalone, cloned onto any machine,
without any dependency on a specific host, private network, or
deployment environment. It does not assume the presence of any
particular remote-access tooling, virtual private server, or overlay
network. Nothing in `standards/`, `adapters/`, or `templates/` may
reference such infrastructure.

## Current status

The canonical phase state lives in one place only: the
[README](../README.md#current-status-phase-2b). This document describes the
layer structure and boundaries, which do not change between phases.
