# Manifest, contract and validator reference

All formats are JSON, described by JSON Schema (draft 2020-12) files in
[`standards/schemas/`](../standards/schemas/). Those schema files are the
single source of truth. JSON was chosen over YAML because it needs no parser
dependency and Node can read it natively.

The validator (`installer/lib/schema.mjs`) implements a documented subset of
2020-12 and **throws on any keyword it does not implement**, so a schema
cannot silently assert something the validator ignores.

Manifests describe a component and reference other components **by id only**.
They never embed provider-specific configuration (that belongs to adapters
generating output at install time) and never contain credentials: MCP
manifests list environment variable *names* only.

## Common manifest fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | string `"MAJOR.MINOR"` | must be listed in `compatibility/matrix.json` |
| `kind` | const | `agent`, `skill`, `mcp`, `adapter`, `technology-profile` |
| `id` | string | kebab-case, unique per kind; file name must be `<id>.json` |
| `version` | semver | version of the component |
| `name`, `description` | non-empty string | |
| `compatibility.standard` | string[] | standard versions supported; each must be in the matrix |

## Kind-specific fields

- **agent**: `permissions` (required), `instructions_path`, `skills[]`, `mcp_servers[]`, `technology_profiles[]`.
- **skill**: `instructions_path` (required), `requires_mcp[]`, `permissions`.
- **mcp**: `transport` (`stdio`|`http`), `access` (`read-only`|`read-write`|`admin`), `command`+`args` (stdio, command required) or `url` (http, `https://` and no embedded userinfo, required), `env_vars[]` (names, `UPPER_SNAKE`).
- **adapter**: `target_tool` (must be in the matrix), `tool_versions {min,max}`, `output_dir`, `supports {agents,skills,mcp_servers,technology_profiles}` (ids).
- **technology-profile**: `languages[]`, `validation_commands[]`, `skills[]`, `mcp_servers[]`.

`permissions`: `tools[]` (required), `shell_commands[]`, `writable_paths[]`,
`permission_mode` (`default`|`acceptEdits`|`plan`|`bypassPermissions`),
`production_access` (`none`|`read-only`|`mutate`).

`instructions_path` is relative to the manifest's directory; the file must
exist (Markdown files next to manifests are allowed).

## Task contract (`kind: "task-contract"`)

`objective`, `verified_context[{statement, source}]`, `allowed_paths` (≥1),
`prohibited_paths`, `constraints`, `authorized_tools` (≥1),
`acceptance_criteria` (≥1), `required_evidence`, `validation_commands`,
`rollback`, plus `schema_version` and `kind`. All paths are relative.

## Result (`kind: "result"`)

`execution_status` (`COMPLETE`|`PARTIAL`|`BLOCKED`), `validation_result`
(`PASS`|`FAIL`|`BLOCKED`), `files_changed`, `evidence[{description, command?,
output_summary?}]`, `warnings`, `unresolved_blockers`. Consistency rules
(`RESULT_INCONSISTENT`): `COMPLETE` must have no blockers; `BLOCKED` must list
blockers and cannot be `PASS`.

## Compatibility matrix

`compatibility/matrix.json` (`kind: compatibility-matrix`) lists
`supported_schema_versions`, `supported_standard_versions` and
`supported_tools`. Anything declaring an unlisted value fails with
`UNSUPPORTED_COMPATIBILITY`.

## Validator

```
node installer/validate.mjs [--json] [--matrix <file>] [path ...]
npm run validate     # default: standards/manifests + compatibility
npm test             # unit tests over all valid and invalid fixtures
```

Exit codes: `0` valid, `1` validation errors, `2` usage error. It needs no
network, credentials, or OpenClaw, and only reads files (it never writes,
follows symlinks, or spawns processes; a test enforces this).

Pass a whole directory tree so cross-file checks (duplicates, references) see
every component. Error output: `ERROR <CODE>[rule] <file> <json-path>: message`.
Secret findings never echo the matched value.

| Code | Meaning |
|---|---|
| `INVALID_JSON`, `UNKNOWN_KIND`, `FILE_STRUCTURE` | unparsable file, unknown `kind`, bad file name / stray file / symlink |
| `SCHEMA_MISSING_FIELD`, `SCHEMA_WRONG_TYPE`, `SCHEMA_UNKNOWN_FIELD`, `SCHEMA_INVALID_VALUE`, `SCHEMA_CONSTRAINT` | schema violations |
| `DUPLICATE_ID` | same `kind`+`id` defined twice |
| `MISSING_REFERENCE` | undefined component id or missing instructions file |
| `DANGEROUS_PERMISSION` | rules: `force-push`, `bypass-permissions`, `destructive-delete`, `production-mutation`, `broad-tool-grant`, `broad-path-grant` |
| `ABSOLUTE_PATH`, `PATH_TRAVERSAL` | machine-specific or escaping paths |
| `SECRET_PATTERN` | credential-shaped values (cloud/VCS/payment keys, private keys, JWTs, `key=value` assignments, URL userinfo) |
| `UNSUPPORTED_COMPATIBILITY` | version or tool not in the matrix |
| `RESULT_INCONSISTENT` | contradictory result statuses |

Dangerous-permission checks inspect `tools`, `shell_commands`,
`authorized_tools`, `validation_commands`, MCP `command`/`args`, and path
grants. Narrow operations stay allowed (for example `git push origin
feature`, `git push --force-with-lease ...`, `rm -rf node_modules`,
`Bash(git status)`). These checks are heuristic guardrails, not a sandbox.

## Fixtures

`tests/fixtures/valid/<case>/` must produce zero errors.
`tests/fixtures/invalid/<case>/` must produce exactly the error codes (and
rule, where given) listed for it in `tests/fixtures/invalid/expectations.json`.
Credential-shaped and machine-specific values are written as `@@TOKEN@@`
placeholders and composed by the test at run time into a temporary copy, so
the repository holds no such literals. Running the validator directly on raw
fixtures therefore does not exercise those cases; use `npm test`.
