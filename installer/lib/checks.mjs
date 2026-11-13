// Semantic (non-schema) checks: dangerous permissions, absolute paths,
// secrets, result consistency. Pure functions over parsed JSON; no I/O.

export const PATH_KEYS = new Set(['allowed_paths', 'prohibited_paths', 'files_changed', 'writable_paths', 'instructions_path', 'output_dir', 'reference_paths', 'notice_path', 'license_path']);
const COMMAND_KEYS = new Set(['tools', 'shell_commands', 'authorized_tools', 'validation_commands']);
const BROAD_PATH_KEYS = new Set(['writable_paths', 'allowed_paths']);

// Collect every string with its JSON path and nearest enclosing key.
export function collectStrings(value, path = '$', key = '', out = []) {
  if (typeof value === 'string') out.push({ path, key, value });
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, key, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${path}.${k}`, k, out);
  }
  return out;
}

// ---- dangerous permissions -------------------------------------------------
const ROOTISH = new Set(['', '.', '..', './', '~', '$HOME', '${HOME}']);

function destructiveDelete(s) {
  for (const m of s.matchAll(/\brm\b([^;&|]*)/g)) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    const recursive = tokens.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === '--recursive');
    if (!recursive) continue;
    for (let t of tokens.filter((x) => !x.startsWith('-'))) {
      t = t.replace(/["')]+$/g, '').replace(/:\*$/, '');
      if (t.endsWith('/*')) t = t.slice(0, -2);
      if (ROOTISH.has(t) || /^[*]+$/.test(t) || /^[/~$]/.test(t)) return true;
    }
  }
  return false;
}

export const COMMAND_RULES = [
  ['force-push', (s) => /\bgit\s+push\b[^;&|]*?(?:\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?=[\s:)"']|$)|\s\+\S)/.test(s)],
  ['bypass-permissions', (s) => /--dangerously-skip-permissions|bypassPermissions|--no-verify|--yolo/i.test(s)],
  ['destructive-delete', destructiveDelete],
  ['production-mutation', (s) => /--prod\b/i.test(s) ||
    (/\b(prod|production|prd)\b/i.test(s) && /\b(deploy|migrate|migration|push|apply|delete|drop|publish|release|rollout|truncate|update|write|mutate|exec|restart)\b/i.test(s))],
  ['broad-tool-grant', (s) => /^\s*(\*|Bash\(\*|Bash\(:\*|Bash)\s*\)?\s*$/.test(s) || /^\s*sudo\b/.test(s) ||
    /\|\s*(sh|bash|zsh)\b/.test(s) || /\b(sh|bash|zsh)\s+-c\b/.test(s) || /\beval\b/.test(s) || /\bchmod\s+-R\s+777\b/.test(s)],
];

export function checkDangerous(doc) {
  const errors = [];
  const add = (path, rule, message) => errors.push({ code: 'DANGEROUS_PERMISSION', rule, path, message });
  const perms = doc.permissions ?? {};
  if (perms.permission_mode === 'bypassPermissions') add('$.permissions.permission_mode', 'bypass-permissions', 'permission_mode bypassPermissions is not allowed');
  if (perms.production_access === 'mutate') add('$.permissions.production_access', 'production-mutation', 'production_access "mutate" is not allowed');
  if (doc.kind === 'mcp' && doc.access === 'admin') add('$.access', 'broad-tool-grant', 'MCP access "admin" is overly broad');
  const strings = collectStrings(doc);
  if (doc.kind === 'mcp') {
    const combined = [doc.command, ...(Array.isArray(doc.args) ? doc.args : [])].filter((x) => typeof x === 'string').join(' ');
    strings.push({ path: '$.command', key: 'command', value: combined });
  }
  for (const { path, key, value } of strings) {
    if (COMMAND_KEYS.has(key) || (doc.kind === 'mcp' && key === 'command')) {
      for (const [rule, test] of COMMAND_RULES) if (test(value)) add(path, rule, `dangerous grant (${rule})`);
    }
    if (BROAD_PATH_KEYS.has(key) && /^(\.\/?|\/|\*+|\*\*\/\*|\.\/\*\*?)$/.test(value.trim())) {
      add(path, 'broad-path-grant', `path grant "${value}" is overly broad`);
    }
  }
  return errors;
}

// ---- absolute paths --------------------------------------------------------
export const ABS_ANYWHERE = new RegExp(
  '(?:^|[\\s"\'=(:,])(?:/(?:Users|home|root|etc|var|opt|usr|private|tmp|mnt|srv|Volumes|bin)(?:/|\\b)|[A-Za-z]:[\\\\/]|~/|\\\\\\\\[^\\\\\\s]+\\\\)|file://|\\$\\{?HOME\\}?');
const ABS_START = /^(\/|~|[A-Za-z]:[\\/]|\\\\|\$\{?HOME\}?|file:\/\/)/;

export function checkPaths(doc) {
  const errors = [];
  for (const { path, key, value } of collectStrings(doc)) {
    if (key === 'url') continue;
    if (PATH_KEYS.has(key)) {
      if (ABS_START.test(value)) { errors.push({ code: 'ABSOLUTE_PATH', path, message: 'path must be relative' }); continue; }
      if (value.split(/[\\/]/).includes('..')) errors.push({ code: 'PATH_TRAVERSAL', path, message: 'path must not contain ".."' });
    } else if (ABS_ANYWHERE.test(value)) {
      errors.push({ code: 'ABSOLUTE_PATH', path, message: 'string contains an absolute or machine-specific path' });
    }
  }
  return errors;
}

// ---- secrets ---------------------------------------------------------------
export const SECRET_PATTERNS = [
  ['aws-access-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['stripe-key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['anthropic-or-openai-key', /\bsk-(ant-)?[A-Za-z0-9_-]{32,}/],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['credential-assignment', /\b(?:password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{12,}/i],
  ['url-credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

export function scanSecrets(text) {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function checkSecrets(doc) {
  const errors = [];
  for (const { path, value } of collectStrings(doc)) {
    for (const rule of scanSecrets(value)) {
      errors.push({ code: 'SECRET_PATTERN', rule, path, message: `value looks like a credential (${rule}); content not echoed` });
    }
  }
  return errors;
}

// ---- result consistency ----------------------------------------------------
// Structural check only: it rejects empty or placeholder evidence but cannot
// verify that the evidence is truthful or that the described work happened.
const PLACEHOLDER_EVIDENCE = new Set(['n/a', 'na', 'none', 'null', 'nil', 'tbd', 'todo', 'ok', 'pass', 'passed', 'nothing', 'empty', 'evidence', 'test', 'tests', 'done', 'complete', 'completed', 'unknown']);
export function hasUsefulEvidence(evidence) {
  if (!Array.isArray(evidence)) return false;
  return evidence.some((item) => {
    const d = typeof item?.description === 'string' ? item.description.trim().toLowerCase() : '';
    if (PLACEHOLDER_EVIDENCE.has(d.replace(/[.!\s]+$/g, ''))) return false;
    return (d.match(/[\p{L}\p{N}]/gu) ?? []).length >= 8;
  });
}

export function checkResult(doc) {
  const errors = [];
  const blockers = Array.isArray(doc.unresolved_blockers) ? doc.unresolved_blockers.length : 0;
  const bad = (message) => errors.push({ code: 'RESULT_INCONSISTENT', path: '$', message });
  if (doc.execution_status === 'COMPLETE' && blockers > 0) bad('COMPLETE result must not have unresolved_blockers');
  if (doc.execution_status === 'BLOCKED' && blockers === 0) bad('BLOCKED result must list unresolved_blockers');
  if (doc.execution_status === 'BLOCKED' && doc.validation_result === 'PASS') bad('BLOCKED execution cannot have validation_result PASS');
  if (doc.execution_status === 'COMPLETE' && doc.validation_result === 'PASS' && Array.isArray(doc.evidence) && !hasUsefulEvidence(doc.evidence)) {
    errors.push({ code: 'RESULT_INCONSISTENT', rule: 'empty-evidence', path: '$.evidence', message: 'COMPLETE/PASS result requires at least one evidence item with a meaningful description' });
  }
  return errors;
}
