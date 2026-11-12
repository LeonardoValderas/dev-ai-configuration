// Minimal, dependency-free JSON Schema (draft 2020-12 subset) validator.
// Unsupported keywords throw, so schemas and validator behavior cannot drift.

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', '$defs', 'title', 'description', 'default', 'examples']);
const ASSERTIONS = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', '$ref', 'allOf', 'if', 'then',
]);

export function assertSupportedSchema(schema, where = '#') {
  if (schema === true || schema === false) return;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`schema at ${where} is not an object`);
  }
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !ASSERTIONS.has(key)) {
      throw new Error(`unsupported schema keyword "${key}" at ${where}`);
    }
  }
  for (const [k, sub] of Object.entries(schema.properties ?? {})) assertSupportedSchema(sub, `${where}/properties/${k}`);
  for (const [k, sub] of Object.entries(schema.$defs ?? {})) assertSupportedSchema(sub, `${where}/$defs/${k}`);
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${where}/items`);
  if (typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties, `${where}/additionalProperties`);
  (schema.allOf ?? []).forEach((s, i) => assertSupportedSchema(s, `${where}/allOf/${i}`));
  if (schema.if !== undefined) assertSupportedSchema(schema.if, `${where}/if`);
  if (schema.then !== undefined) assertSupportedSchema(schema.then, `${where}/then`);
}

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string, number, boolean, object
};
const typeMatches = (want, v) => {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
};

function resolveRef(ref, root, registry) {
  const [file, pointer = ''] = ref.split('#');
  let target = file ? registry.get(file.split('/').pop()) : root;
  if (!target) throw new Error(`unresolvable $ref "${ref}"`);
  const newRoot = target;
  for (const part of pointer.split('/').filter(Boolean)) {
    target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (target === undefined) throw new Error(`unresolvable $ref "${ref}"`);
  }
  return { schema: target, root: newRoot };
}

export function validateSchema(schema, data, registry, root = schema, path = '$') {
  const errors = [];
  const add = (code, message) => errors.push({ code, path, message });
  if (schema === true) return errors;
  if (schema === false) return [{ code: 'SCHEMA_INVALID_VALUE', path, message: 'value not allowed' }];

  if (schema.$ref) {
    const r = resolveRef(schema.$ref, root, registry);
    errors.push(...validateSchema(r.schema, data, registry, r.root, path));
  }
  if (schema.type !== undefined && !typeMatches(schema.type, data)) {
    add('SCHEMA_WRONG_TYPE', `expected ${schema.type}, got ${typeOf(data)}`);
    return errors;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(data)) {
    add('SCHEMA_INVALID_VALUE', `must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) {
    add('SCHEMA_INVALID_VALUE', `must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) add('SCHEMA_CONSTRAINT', `shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength) add('SCHEMA_CONSTRAINT', `longer than maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(data)) add('SCHEMA_CONSTRAINT', `does not match pattern ${schema.pattern}`);
  }
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) add('SCHEMA_CONSTRAINT', `below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) add('SCHEMA_CONSTRAINT', `above maximum ${schema.maximum}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) add('SCHEMA_CONSTRAINT', `fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) add('SCHEMA_CONSTRAINT', `more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(data.map((d) => JSON.stringify(d))).size !== data.length) add('SCHEMA_CONSTRAINT', 'items must be unique');
    if (schema.items !== undefined) {
      data.forEach((item, i) => errors.push(...validateSchema(schema.items, item, registry, root, `${path}[${i}]`)));
    }
  }
  if (typeOf(data) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(data, key)) add('SCHEMA_MISSING_FIELD', `missing required field "${key}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (Object.hasOwn(props, key)) {
        errors.push(...validateSchema(props[key], value, registry, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ code: 'SCHEMA_UNKNOWN_FIELD', path: `${path}.${key}`, message: `unknown field "${key}"` });
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(schema.additionalProperties, value, registry, root, `${path}.${key}`));
      }
    }
  }
  for (const sub of schema.allOf ?? []) errors.push(...validateSchema(sub, data, registry, root, path));
  if (schema.if !== undefined && schema.then !== undefined) {
    if (validateSchema(schema.if, data, registry, root, path).length === 0) {
      errors.push(...validateSchema(schema.then, data, registry, root, path));
    }
  }
  return errors;
}
