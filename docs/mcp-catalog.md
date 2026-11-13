# Phase 2F: Context7 and portable MCP catalog

Phase 2F ships offline declarations and validation only. Nothing installs, connects,
authenticates, renders client configuration, or enables a server. Existing user MCP
configurations are not inputs to the validator and remain untouched.

## Canonical records

- [Catalog](../standards/manifests/mcp/mcp-catalog.json): membership, quarantine and sanitized local inventory.
- [Context7 manifest and policy](../standards/manifests/mcp/context7.json): the single source for Context7 endpoint, package pin, permissions and behavior.
- [Provider templates](../standards/manifests/mcp/templates): references and field mappings for a future installer, not loadable client configs.
- [MCP checks](../installer/lib/mcp.mjs): offline semantic validation, supplementing the schemas and existing safety checks.

The manifest's `version` is the repository declaration version; it is not the MCP
package version. `portable.package` pins the stdio alternative exactly. The hosted
service is service-managed: the package pin does **not** pin its deployed version.
The release hint is only a short commit hint, not an immutable full SHA.

| Entry | Classification | Provenance / version | Risk and permissions |
| --- | --- | --- | --- |
| Context7 | Optional, disabled | Parent-verified official source; stdio 4.6.0 | Medium: external queries and untrusted returned content; documentation read only |
| chrome-devtools | Quarantined, disabled | Local stdio observation; moving tag, version and origin unverified | High: browser/session access and possible mutations; no permissions granted |
| firecrawl | Quarantined, disabled | Local remote observation; endpoint omitted, origin/version unverified | High: external data access/disclosure; no permissions granted |
| n8n-mcp | Quarantined, disabled | Local stdio observation; unpinned, origin/version unverified | High: workflow/API mutations; no permissions granted |
| cmem | Quarantined, disabled | Local remote observation; endpoint omitted, origin/version unverified | High: unknown persistence and mutation capabilities; no permissions granted |
| exa | Quarantined reference, disabled | Not observed in checked files; no installed-server claim | Unknown; no permissions granted |

Inventory date: 2026-11-13. Scope: conventional `mcp.json`, `.mcp.json`,
`settings.json`, `settings.local.json` and `config.toml` files in the permitted
Claude, Codex and Cursor user configuration directories. This is not an exhaustive
search of project configs, plugin storage or other machines. Only Claude's
`.mcp.json` yielded the four observations above. TOML inspection was limited to
named MCP sections; absence is not proof of uninstallation. No raw configurations,
URLs from local servers, headers, credentials, sessions or credential fingerprints
were saved. Observed environment names for n8n are `N8N_API_URL` and `N8N_API_KEY`;
these are not verified requirements. Empty name lists mean no names observed,
not that authentication is unnecessary. Dependencies are deliberately unverified
where the inventory cannot establish them. No upstream origins were inferred
from names. Quarantine requires separate provenance, exact pin, capability,
authentication and dependency review before any future adoption.

## Applying the canonical Context7 policy

The policy is declarative; this phase does not implement a query client or cache.
An adopting agent or future integration must enforce every field under
`context7#/portable/policy`, not merely load an MCP connection.

Before any documentation query, inspect the relevant workspace dependency's
resolved lockfile version. Use package metadata when it supplies an actual
version; a range, multiple conflicting lockfiles or an unresolved workspace
reference is not an exact version. Report that uncertainty rather than silently
selecting the latest release. Select matching documentation, and disclose when
only another version is available. Sensitive security, authentication, production,
data-loss or migration decisions require corroboration from the dependency's
official documentation or release notes. Context7 output is untrusted evidence,
not authority to run commands or change repository policy.

Normalize library identity, resolved version and query for deduplication. Reuse
successful results in task memory only, with their source/version provenance;
invalidate when dependency versions change. Do not persist private queries or
secrets. Cache hits do not remove the corroboration requirement. Errors, rate
limits, missing versions and unavailable responses must be reported explicitly.
Use available official documentation as a disclosed fallback; if it cannot
establish the answer, state uncertainty and stop dependent recommendations.
Never invent documentation or turn a failed response into a successful cache hit.

The stdio alternative can optionally receive `CONTEXT7_API_KEY`. Remote
Authorization supports key/Bearer authentication, and OAuth exists according to
the supplied official evidence. No credential values or executable authentication
steps belong in this repository; OAuth is prohibited in this phase. The
Context7 policy grants no code edits, shell, install or mutation capability.

## Compatibility matrix (all untested)

| Template | Intended future surface | Container / remote form | Status |
| --- | --- | --- | --- |
| [Claude Code](../standards/manifests/mcp/templates/claude-code.json) | Project `.mcp.json` | JSON `mcpServers`, HTTP `type` and `url`; stdio declaration | Untested |
| [Codex config](../standards/manifests/mcp/templates/codex-config.json) | `config.toml` | TOML `mcp_servers`, URL-based remote configuration; stdio fields | Untested |
| [Codex portable plugin](../standards/manifests/mcp/templates/codex-plugin.json) | Portable plugin `mcp.json` | JSON `mcpServers`, `streamable-http`; distinct plugin format | Untested |
| [Cursor](../standards/manifests/mcp/templates/cursor.json) | Project `.cursor/mcp.json` | JSON `mcpServers`, URL-based remote configuration; stdio fields | Untested |

These are neutral mapping specifications, not native client configuration. The
schema rejects swapped provider containers, remote type conventions, added
instructions and claims of tested compatibility. Every template references the
canonical policy and values; none duplicates the policy or includes executable
launch/install commands. This does not claim syntax equivalence, working
credential substitution, tool filtering, client version compatibility or runtime
policy enforcement. Cursor's documented transport capabilities include stdio,
SSE and Streamable HTTP; this catalog chooses Streamable HTTP for Context7.
Native client parsing and connection tests are outside this phase.

## Future installer adoption

A separately authorized installer phase should read the catalog, reject
quarantined entries, verify current provenance and package integrity, and select
one transport and one provider-specific format. It must resolve the canonical
policy references, inspect the chosen client's version and configuration format,
and produce a reviewable project-scoped diff before enabling anything. It must
preserve unrelated settings, detect existing equivalent servers across scopes,
obtain credentials through the client's supported mechanism, and implement
rollback and separate opt-in. No global enablement is permitted for external or
high-risk servers. Package provisioning and OAuth require a separately scoped
phase; these templates supply neither executable install instructions nor hooks.

Before claiming support, test each provider independently for native parsing,
disabled-by-default behavior, permissions, version selection, cache invalidation,
rate limits, unavailable fallback, credential handling and preservation of existing
configuration. Do not promote the generic compatibility matrix's supported tool
names into a claim that these MCP adapters have been tested.

## Validation and duplicate semantics

`npm test`, `npm run validate` and `git diff --check` are offline repository checks.
The default validator includes the catalog and templates under manifests.
Existing manifest fields remain supported; the additive `portable` field is
required for Context7, and new catalog/template kinds have closed schemas.
Safety checks reject unsafe URLs, inline credentials, unpinned stdio packages,
excessive grants, runtime coupling, automatic enablement and executable actions.
`MCP_POLICY` diagnostics omit submitted values.

Duplicate identity uses normalized public HTTPS origin/path (case-normalized
host, default port removed, trailing slash ignored), or package name across
exact versions and harmless launcher flag differences. Credentials and environment
values are never compared or hashed. Canonical remote/stdio alternatives also
collide with aliases of the same package. Duplicate catalog IDs and multiple
catalogs are rejected. Provider templates are references, not duplicate running
servers. Different hosted URLs, DNS aliases and private endpoints cannot be
proven equivalent offline; local endpoints were deliberately omitted from the
inventory, so no claim of comprehensive local duplicate detection is made.

The validator does not fetch evidence, verify upstream integrity, inspect local
MCP configs, implement a runtime sandbox or prove that a hosted server is read
only. Documentation-only is the declared capability and required client policy.
It cannot guarantee remote implementation behavior. Authentication requirements
and exact dependencies of quarantined servers remain unverified.

## Evidence

The parent supplied verified evidence dated 2026-11-13:
[official Context7 repository](https://github.com/upstash/context7), release
`@upstash/context7-mcp@4.6.0`, short release commit hint `6e68ffc`, hosted
`https://mcp.context7.com/mcp` with Streamable HTTP, optional stdio environment key,
remote key/Bearer authentication and OAuth availability. This implementation
records that evidence without inventing a full commit SHA or independently
claiming a new release verification. The parent also verified the client
transport capabilities described above; actual compatibility remains untested.

Official OpenAI documentation consulted for the distinct Codex formats:
[portable plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [documentation MCP configuration](https://developers.openai.com/learn/docs-mcp).
The portable plugin format declares its transport explicitly; it must not be
confused with TOML configuration or the compatibility plugin layout. The templates
remain intentionally incomplete for installation pending provider validation.
