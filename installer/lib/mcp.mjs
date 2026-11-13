// Pure, offline checks over declarations. Never reads client configs or runs servers.
import { collectStrings, COMMAND_RULES } from './checks.mjs';
import { checkRuntimeCoupling } from './agents.mjs';

const issue = (rule, path = '$') => ({ code: 'MCP_POLICY', rule, path, message: `MCP declaration violates ${rule}; values omitted` });
const PIN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
export function safeEndpoint(value) {
  try {
    const u = new URL(value);
    // URL parsing canonicalizes IPv6 case/compression and retains brackets.
    // Explicitly reject unique-local fc00::/7 and link-local fe80::/10.
    if (/^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(u.hostname)) return false;
    return /^https:\/\//.test(value) && u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash &&
      !/[\s\\%]/.test(value) && !['localhost', '::1', '[::1]'].includes(u.hostname) &&
      !/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(u.hostname) && u.hostname.includes('.') && !u.hostname.endsWith('.local');
  } catch { return false; }
}

// Only public, credential-free metadata contributes to identity. Auth differences
// cannot hide a duplicate. Version changes are conflicts for the same package.
export function semanticIdentity(doc) {
  if (doc.kind !== 'mcp') return null;
  if (typeof doc.url === 'string' && safeEndpoint(doc.url)) {
    const u = new URL(doc.url);
    return `remote:${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  const pkg = doc.portable?.package ?? doc.args?.find((a) => typeof a === 'string' && PIN.test(a));
  return pkg && PIN.test(pkg) ? `package:${pkg.slice(0, pkg.lastIndexOf('@'))}` : null;
}

export function checkMcp(doc) {
  const errors = [...checkRuntimeCoupling(doc)];
  const add = (r, p) => errors.push(issue(r, p));
  for (const { path, key, value } of collectStrings(doc)) {
    if ((key === 'url' || /^https?:/i.test(value)) && !safeEndpoint(value)) add('unsafe-endpoint', path);
    if (/\b(?:authorization|password|secret|token|api[_-]?key)\s*[:=]\s*\S+/i.test(value.replace(/\b(?:authorization|password|secret|token|api[_-]?key)\s*[:=]\s*\$\{?[A-Z][A-Z0-9_]*\}?/gi, '')))  add('inline-secret', path);
    if (/@latest\b|(?:^|\s)(?:npm|pnpm|yarn|pip)\s+(?:install|add)\b|\boauth\s+(?:login|authorize)\b/i.test(value)) add('executable-or-unpinned', path);
    for (const [rule, test] of COMMAND_RULES) if (test(value)) add(rule, path);
  }
  if (doc.kind === 'mcp') {
    if (doc.access === 'read-write') add('least-privilege', '$.access');
    if (doc.transport === 'http' && (doc.command !== undefined || doc.args !== undefined)) add('transport-mixup');
    if (doc.transport === 'stdio') {
      if (doc.url !== undefined) add('transport-mixup');
      if (doc.command !== 'npx' || !Array.isArray(doc.args) || doc.args.filter(a => PIN.test(a)).length !== 1 || doc.args.some(a => a !== '-y' && !PIN.test(a))) add('pinned-stdio-declaration');
    }
    if (doc.id === 'context7') {
      if (!doc.portable) add('missing-context7-policy');
      if (doc.url !== 'https://mcp.context7.com/mcp' || doc.transport !== 'http') add('context7-endpoint');
      if (JSON.stringify(doc.env_vars) !== JSON.stringify(['CONTEXT7_API_KEY']) || doc.portable && (doc.portable.required_env_vars.length || JSON.stringify(doc.portable.optional_env_vars) !== JSON.stringify(['CONTEXT7_API_KEY']))) add('context7-env');
      if (doc.command || doc.args) add('context7-executable');
    } else if (doc.portable) add('unknown-portable-policy');
  }
  return errors;
}

export function checkMcpSet(docs) {
  const errors = [];
  const add = (file, rule, path) => errors.push({ file, ...issue(rule, path) });
  const catalogs = docs.filter(x => x.doc.kind === 'mcp-catalog');
  if (catalogs.length > 1) add(catalogs[1].file, 'duplicate-catalog');
  const manifests = docs.filter(x => x.doc.kind === 'mcp').sort((a, b) => Number(Boolean(b.doc.portable)) - Number(Boolean(a.doc.portable)));
  const seen = new Set();
  for (const { file, doc } of manifests) {
    const identities = [semanticIdentity(doc)];
    // A canonical declaration can describe remote and stdio alternatives.
    const pkg = doc.portable?.package;
    if (pkg && PIN.test(pkg)) identities.push(`package:${pkg.slice(0, pkg.lastIndexOf('@'))}`);
    if (identities.some(identity => identity && seen.has(identity))) add(file, 'semantic-duplicate');
    for (const identity of identities) if (identity) seen.add(identity);
  }
  const catalog = catalogs[0]?.doc;
  if (catalog) {
    const ids = new Set();
    for (const e of catalog.entries) {
      if (ids.has(e.id)) add(catalogs[0].file, 'duplicate-entry');
      ids.add(e.id);
      if (e.classification === 'OPTIONAL') {
        if (e.id !== e.manifest_id || e.inventory || !manifests.some(x => x.doc.id === e.id && x.doc.portable)) add(catalogs[0].file, 'catalog-reference');
      } else if (e.manifest_id || manifests.some(x => x.doc.id === e.id)) add(catalogs[0].file, 'quarantined-manifest');
    }
    for (const {file, doc} of manifests) if (doc.portable && !ids.has(doc.id)) add(file, 'orphan-manifest');
  }
  for (const { file, doc } of docs) {
    if (doc.kind === 'mcp-template' && (!catalog || !catalog.entries.some(e => e.id === doc.manifest_id && e.classification === 'OPTIONAL') || !manifests.some(x => x.doc.id === doc.manifest_id))) add(file, 'template-reference');
    if (doc.kind === 'mcp' && doc.portable && !catalog) add(file, 'missing-catalog');
    if (['agent','technology-profile','adapter'].includes(doc.kind)) {
      const refs = doc.kind === 'adapter' ? doc.supports?.mcp_servers : doc.mcp_servers;
      if (refs?.some(id => catalog?.entries.some(e => e.id === id) || id === 'context7')) add(file, 'automatic-enablement-or-untested-claim');
    }
  }
  return errors;
}
