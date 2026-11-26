// dac brief: path resolution, injectable launcher (no real browser) and static checks of the Brief Studio form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../installer/lib/run.mjs';
import { mainWithDeps } from '../bin/dac.mjs';

const HTML = join(REPO_ROOT, 'tools/brief-studio/index.html');
const html = readFileSync(HTML, 'utf8');
const doc = readFileSync(join(REPO_ROOT, 'docs/brief-studio.md'), 'utf8');

async function run(args, deps, cwd = realpathSync(tmpdir())) {
  const out = []; const err = [];
  const [lo, le] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '));
  try { const code = await mainWithDeps(args, cwd, {}, deps); return { code, out: out.join('\n'), err: err.join('\n') }; } finally { console.log = lo; console.error = le; }
}

test('macOS: launches the checkout HTML once through the injected opener, from any cwd (outside a DAC project)', async () => {
  const calls = [];
  const r = await run(['brief'], { platform: 'darwin', openBrowser: (f) => calls.push(f) });
  assert.equal(r.code, 0);
  assert.deepEqual(calls, [HTML]);
  assert.ok(isAbsolute(calls[0]));
  assert.match(r.out, new RegExp(HTML.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(r.err, '');
});

test('unsupported platforms: prints the absolute path, exits 0 and never launches', async () => {
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const calls = [];
    const r = await run(['brief'], { platform, openBrowser: (f) => calls.push(f) });
    assert.equal(r.code, 0);
    assert.equal(r.out, HTML);
    assert.deepEqual(calls, []);
  }
});

test('launcher failure exits 1 with the path on stderr; options are usage errors (exit 2) and launch nothing', async () => {
  const bad = await run(['brief'], { platform: 'darwin', openBrowser: () => { throw new Error('boom'); } });
  assert.equal(bad.code, 1);
  const calls = [];
  for (const a of [['brief', '--x'], ['brief', 'extra']]) {
    const r = await run(a, { platform: 'darwin', openBrowser: (f) => calls.push(f) });
    assert.equal(r.code, 2);
    assert.match(r.err, /brief/);
  }
  assert.deepEqual(calls, []);
});

test('real process on a real process: --help lists brief; the CLI source launches without a shell', () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'bin/dac.mjs'), '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^  brief /m);
  const src = readFileSync(join(REPO_ROOT, 'bin/dac.mjs'), 'utf8');
  assert.match(src, /spawnSync\('\/usr\/bin\/open', \[file\], \{ stdio: 'ignore', shell: false \}\)/);
  const brief = src.slice(src.indexOf('const openWithDefaultBrowser'), src.indexOf('const taskArg'));
  assert.doesNotMatch(brief, /\bexec\(|execSync|shell: true/);
});

test('form: both generators, scope selector, six production areas and calculator example are present', () => {
  assert.match(html, /function generatePRD\(/);
  assert.match(html, /function generatePrompt\(/);
  assert.match(html, /data-tab="prd"/); assert.match(html, /data-tab="prompt"/);
  const scope = /<select id="scope">([\s\S]*?)<\/select>/.exec(html)[1];
  for (const v of ['Prototipo', 'MVP productivo', 'Producto completo', 'Nueva funcionalidad']) assert.ok(scope.includes(`value="${v}"`), v);
  for (const id of ['prodSecurity', 'prodData', 'prodQuality', 'prodRelease', 'prodObservability', 'prodMaintenance']) assert.match(html, new RegExp(`<select id="${id}"`));
  assert.match(html, /Calculadora Material Design 3/);
  assert.match(html, /id="example"/);
  assert.match(html, /read-only/i);
});

test('form is executable: example + both generators + clear, with localStorage draft and no network calls (stubbed DOM)', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const els = new Map(); const store = new Map(); const handlers = {};
  const mk = (id) => ({ id, value: '', checked: false, textContent: '', innerHTML: '', dataset: {}, setAttribute() {}, append() {}, remove() {}, click() {}, select() {},
    addEventListener(t, f) { (handlers[id] ??= {})[t] = f; } });
  const get = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const tabs = ['prd', 'prompt'].map((t) => { const b = mk(`tab-${t}`); b.dataset.tab = t; return b; });
  const document_ = { getElementById: get, querySelectorAll: (q) => (q === '[data-tab]' ? tabs : []), createElement: () => mk('x'), body: { append() {}, appendChild() {} } };
  const net = [];
  const trap = (n) => function () { net.push(n); };
  const ls = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) };
  const form = get('briefForm'); form.reset = () => {};
  new Function('document', 'localStorage', 'navigator', 'fetch', 'XMLHttpRequest', 'WebSocket', 'confirm', 'URL', 'Blob', 'setTimeout', script)(
    document_, ls, { clipboard: { writeText: async () => {} }, sendBeacon: trap('beacon') }, trap('fetch'), trap('xhr'), trap('ws'), () => true,
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, class {}, () => {});
  handlers.example.click();
  const prd = get('output').textContent;
  assert.match(prd, /Calculadora Material Design 3/);
  for (const area of ['Seguridad y privacidad', 'Datos y persistencia', 'Pruebas y calidad', 'Despliegue y publicación', 'Monitoreo y diagnóstico', 'Mantenimiento y operación']) assert.ok(prd.includes(area), area);
  const draft = JSON.parse(store.get('dac-brief-studio-v2'));
  assert.equal(draft.project, 'Calculadora Material Design 3');
  assert.equal(draft.scope, 'Producto completo');
  tabs[1].click?.(); handlers['tab-prompt'].click();
  const prompt = get('output').textContent;
  assert.notEqual(prompt, prd);
  assert.ok(prompt.includes(prd.trim().split('\n')[0]), 'prompt embeds the PRD');
  assert.match(prompt, /read-only/i);
  get('scope').value = 'Prototipo'; handlers.briefForm.input();
  assert.match(get('scopeHelp').textContent, /Validar una idea/);
  handlers.clear.click();
  assert.equal(store.has('dac-brief-studio-v2'), false);
  assert.deepEqual(net, []);
});

test('form: no network/server transmission APIs; localStorage used only through the documented keys', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /\bimport\s*\(/]) assert.doesNotMatch(script, re, String(re));
  for (const re of [/<form[^>]*\baction=/i, /<script[^>]*\bsrc=/i, /<link[^>]*href=/i, /<img[^>]*src=["']?https?:/i, /<iframe/i]) assert.doesNotMatch(html, re, String(re));
  const uses = [...new Set([...script.matchAll(/localStorage\.(\w+)\(([^,)]+)/g)].map((m) => `${m[1]}:${m[2]}`))].sort();
  assert.deepEqual(uses, ['getItem:legacyStorageKey', 'getItem:storageKey', 'removeItem:legacyStorageKey', 'removeItem:storageKey', 'setItem:storageKey']);
  assert.match(script, /storageKey = 'dac-brief-studio-v2'/);
  assert.match(doc, /localStorage/);
  assert.match(doc, /no env[ií]a el contenido del formulario a un servicio remoto/i);
});
