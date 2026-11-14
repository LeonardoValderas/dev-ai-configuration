# Codex and Cursor adapters (Phase 2H)

The native project adapters derive their output from the canonical agent and skill
catalogs, instruction bodies, permission ceilings, task/result schemas, SDD workflow
and agent map, and optional MCP catalog. No OpenClaw runtime or dependency is used.
Generated projects are standalone. There are no duplicated canonical instruction
bodies in adapter source. Claude Code now uses the same canonical renderers and
transactional writer; its generation behavior remains covered by existing tests.

## Usage

From this repository, choose `codex` or `cursor`:

```sh
node adapters/codex/cli.mjs plan --json
node adapters/codex/cli.mjs apply --target /path/to/project --dry-run
node adapters/codex/cli.mjs apply --target /path/to/project
node adapters/codex/cli.mjs uninstall --target /path/to/project --dry-run
```

Replace `codex` with `cursor` for Cursor. `--include-context7-template` adds an inert
catalog-derived reference; it never enables a server. No install command, package
execution, connection, credential, login or model call is involved. There is no
option for extra agents, extra skills, bypass permissions or automatic fallback.

Apply only to an explicit existing project outside this standards repository.
Home roots, provider configuration directories and symlinks are rejected. Existing
unmanaged or locally modified files produce a conflict with zero writes. Files
are tracked by SHA-256; apply is idempotent and rolls back on mutation failure.
Uninstall preserves locally modified files. `AGENTS.md` is managed as a whole file;
existing project instructions must be reconciled manually. Installing both adapters
into the same project conflicts on that file rather than silently overwriting it.
Do not edit generated settings; tampered plans fail canonical verification before
application. Concurrent installers or hostile filesystem mutation during apply
are not supported; rollback is not a replacement for filesystem backups.

## Output and native differences

| Artifact | Codex | Cursor |
| --- | --- | --- |
| Main instructions | `AGENTS.md` | `AGENTS.md`, always-applied `.cursor/rules/dac.mdc` |
| Nine specialists | `.codex/agents/*.toml`, registered in `.codex/config.toml` | `.cursor/agents/*.md` with native frontmatter |
| Two CORE skills | `.agents/skills/*/SKILL.md` and `agents/openai.yaml` invocation policy | `.cursor/skills/*/SKILL.md`, explicit invocation |
| Permissions | `read-only`, `never` approvals, shell disabled, web disabled | `readonly: true`; project CLI denies shell, writes, web and MCP |
| Contracts and SDD | `.codex/dac/` | `.cursor/dac/` |
| Optional Context7 | Native TOML entry with `enabled = false` | Empty live MCP file; reference template under `.cursor/dac/mcp/` |
| Ownership ledger | `.codex/dac-manifest.json` | `.cursor/dac-manifest.json` |

Selection is exactly the eight primary specialists plus independent `code-reviewer`.
Only `frontend-design` and `supabase-postgres-best-practices` are shipped, with their
canonical references, licenses and notices. No optional or quarantined skills are
activated. Contracts and SDD JSON are copied byte-for-byte. Full, Lightweight and
Hotfix phases, owners, human gates and limits are rendered from canonical data.

All nine agents are conservatively read-only, including the four canonical
implementers. Their canonical permission ceilings remain recorded, but writes
and shell commands are unavailable. Broad workspace write access cannot express
per-agent canonical glob scopes, and Cursor CLI permissions are not IDE permission
settings. These adapters therefore support analysis and guidance; implementation
must be reported BLOCKED. Denials cannot trigger another executor, escalation,
retry route or automatic fallback. Read-only settings alone do not prove every
runtime tool is confined. In particular, inherited MCP/global settings, trust,
CLI overrides and IDE behavior remain outside the declarative evidence boundary.
Use a clean, appropriately constrained runtime; these files are not a security
boundary against an operator changing settings. Codex shell disabling may also
reduce file-search capabilities; unavailable actions remain BLOCKED.

## Compatibility and evidence

| Runtime baseline supplied for Phase 2H | Declarative checks | CLI integration | Authenticated enforcement |
| --- | --- | --- | --- |
| Codex CLI 0.154.0 | Tested generated native files and canonical restrictions | Conditional isolated help/version only | Unverified; forbidden |
| Cursor Agent CLI 2026.11.13-eacade1 | Tested project CLI declarations | Conditional isolated help/version only | Unverified; forbidden |
| Cursor IDE 3.30.14 | Native agents, skills and rule declarations | No IDE automation | Unverified; CLI permissions are not IDE proof |

The version strings are supplied baselines, not versions observed by a skipped
probe. `runtime_evidence` and the compatibility matrix separate evidence classes.
No skill manifest claims authenticated provider support. MCP provider templates
retain their untested status because no connection has been tested.

`tests/portable-adapters.test.mjs` covers formats, selection, permissions, schema
references, unchanged canonical assets, deterministic generation, invalid options,
tampered plans (including secrets, absolute paths, bypass and fallback), conflicts,
symlinks, idempotence, template removal, rollback and uninstall. These are
**declarative and installer tests**, not model-enforced policy tests.

`tests/portable-runtime.test.mjs` allows only `codex --version`, `codex --help`,
`agent --version` and `agent --help`. Its environment is an allowlist, with disposable
HOME, CODEX_HOME, Cursor config, XDG config/data/state/cache and TMP paths. On macOS,
`sandbox-exec` denies network, external writes and real provider-profile reads.
Before invoking a CLI, controls prove disposable writes succeed, protected reads
and external writes fail, and network socket creation fails. Synthetic protected
profiles are snapshotted before/after. Real profiles are never inspected or
snapshotted because this task explicitly forbids accessing them; OS policy covers
their roots. No credentials or ambient authentication variables are passed.

When sandbox application is unavailable (including nested sandbox refusal), the
CLI tests skip with **BLOCKED-UNVERIFIED**. There is no weaker execution path. Even
successful help/version probes prove only binary startup, not parsing/loading of
project config or enforcement during a model session. Authenticated enforcement
has a separate, permanently skipped test; this phase provides no opt-in key path.

Official format references consulted for this implementation:

- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Codex skills](https://developers.openai.com/codex/skills)
- [Cursor subagents](https://cursor.com/docs/subagents)
- [Cursor skills](https://cursor.com/docs/skills)
- [Cursor CLI permissions](https://prod.cursor.com/docs/cli/reference/permissions)

Documentation can evolve beyond the supplied runtime baselines. The probes do
not establish syntax/enforcement equivalence across versions or providers.

## Release limitations and tracked technical debt

Ubuntu CI validates schemas, generation, installer behavior and the honesty of
the evidence ledger, but it cannot execute the macOS Seatbelt runtime probes.
Before claiming complete runtime compatibility, a separate macOS gate must run
the isolated CLI probes. Authenticated enforcement remains **UNVERIFIED** and is
not implied by help/version success or by declarative tool restrictions.

The Phase 2H review accepted the release with these low-severity follow-ups:

1. The runtime baseline actually exercised for Cursor was Cursor Agent CLI
   `2026.11.13-eacade1`; keep the recorded baseline synchronized with future
   probes and documentation updates.
2. Protected provider-directory checks are case-sensitive. A future portability
   pass should define behavior for case-insensitive filesystems explicitly.
3. The accepted-target realpath cache is valid only for one apply transaction;
   preserve that invariant if apply orchestration becomes long-lived.
4. Add a dedicated regression test showing that Codex and Cursor installations
   targeting the same project conflict safely over the managed `AGENTS.md`.
5. Concurrent hostile filesystem mutation remains a TOCTOU risk; the adapters
   are not a substitute for an OS sandbox or exclusive filesystem ownership.
6. Cursor intentionally emits an empty `.cursor/mcp.json` while Context7 is
   disabled; future changes must not interpret that empty file as enablement.
