# Adding a component

1. Pick the directory under `standards/manifests/`: `agents/`, `skills/`,
   `mcp/`, `adapters/`, `profiles/` (the directory is conventional; the
   `kind` field is authoritative).
2. Create `<id>.json` where `<id>` is kebab-case and equals the `id` field.
   Start from a valid fixture in `tests/fixtures/valid/full-set/`.
3. Set `schema_version` and `compatibility.standard` to versions listed in
   `compatibility/matrix.json`.
4. Agents and skills: add the instructions Markdown file next to the manifest
   and point `instructions_path` at it (relative path).
5. Reference other components by id (`skills`, `mcp_servers`,
   `technology_profiles`, `requires_mcp`, adapter `supports`). Define them first.
6. Grant the least permissions that work: list explicit tools and commands,
   scope `writable_paths`, keep `production_access` at `none` or `read-only`.
7. Never put absolute paths, credentials or provider-specific settings in a
   manifest. MCP manifests name environment variables only.
8. Run `npm run validate`, then `npm test`.

Adding a new adapter target tool: add its id to `supported_tools` in
`compatibility/matrix.json` first. Adding a new schema version: add it to
`supported_schema_versions`, update schemas and fixtures together.

Adding a new kind or rule: add the schema in `standards/schemas/`, register it
in `installer/lib/run.mjs`, add a valid fixture and an invalid fixture plus its
entry in `expectations.json`.
