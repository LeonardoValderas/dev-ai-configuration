// Dependency-free redaction of validation errors that cross the custodian -> MCP -> agent boundary.
// Writer validation messages may embed submitted content (ids in quotes, unknown field names in paths). Nothing the agent
// submitted is echoed back: only a fixed-shape, bounded projection is forwarded. Applied by the custodian before replying
// and again by the stateless proxy before returning a tool result (defence in depth).
export const MAX_FORWARDED_ERRORS = 50;
const MAX_MESSAGE = 160;
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RULE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,31}$/;

function redactPath(p) {
  if (typeof p !== 'string' || !p.startsWith('$')) return '$';
  const out = [];
  for (const m of p.slice(1).matchAll(/\.([^.[\]]*)|\[(\d{1,6})\]|([\s\S])/g)) {
    if (m[2] !== undefined) out.push(`[${m[2]}]`);
    else if (m[1] !== undefined) out.push(SEGMENT_RE.test(m[1]) ? `.${m[1]}` : '.<redacted>');
    else out.push('.<redacted>');
  }
  return `$${out.slice(0, 32).join('')}`;
}

function redactMessage(m) {
  if (typeof m !== 'string') return 'invalid';
  // quoted fragments are where submitted ids / keys / values are embedded; remove them, then drop anything non-printable
  const s = m.replace(/"(?:[^"\\]|\\.)*"/g, '"<redacted>"').replace(/[^\x20-\x7e]/g, '?');
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}...` : s;
}

export function sanitizeErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, MAX_FORWARDED_ERRORS).map((e) => {
    const code = typeof e?.code === 'string' && CODE_RE.test(e.code) ? e.code : 'INVALID';
    let path = redactPath(e?.path);
    let message = redactMessage(e?.message);
    // An unknown field's NAME is submitted content: never echo it (not in the path, not in the message).
    if (code === 'SCHEMA_UNKNOWN_FIELD') { path = path.replace(/\.[^.[\]]*$/, '.<unknown-field>'); message = 'unknown field'; }
    // A missing required field's name comes from the schema, not from the submission, so it stays useful (only when it is plainly an identifier).
    const miss = code === 'SCHEMA_MISSING_FIELD' ? /^missing required field "([a-z][a-z0-9_]{0,31})"$/.exec(String(e?.message)) : null;
    if (miss) message = `missing required field "${miss[1]}"`;
    return { code, rule: typeof e?.rule === 'string' && RULE_RE.test(e.rule) ? e.rule : 'schema', path, message };
  });
}
