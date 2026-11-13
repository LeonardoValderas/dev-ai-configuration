import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validatePaths, REPO_ROOT, DEFAULT_INPUTS } from '../installer/lib/run.mjs';
import { semanticIdentity, safeEndpoint } from '../installer/lib/mcp.mjs';

const source = join(REPO_ROOT, 'standards/manifests/mcp');
const load = p => JSON.parse(readFileSync(p, 'utf8'));
const base = load(join(source, 'context7.json'));
function scenario(fn = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'dac-mcp-fixture-'));
  cpSync(source, root, { recursive: true });
  const add = (file, doc) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  const edit = (file, fn) => { const d = load(join(root, file)); fn(d); add(file, d); };
  try { fn({ root, add, edit }); return validatePaths([root], { root }).errors; }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function bad(name, fn, rule) {
  test(`MCP rejects ${name}`, () => {
    const errors = scenario(fn);
    assert.ok(errors.length, 'unsafe fixture was accepted');
    if (rule) assert.ok(errors.some(e => e.rule === rule), JSON.stringify(errors));
  });
}
const editContext = fn => ({ edit }) => edit('context7.json', fn);
test('MCP canonical positive fixture validates offline', () => assert.deepEqual(scenario(), []));
test('MCP additions preserve all existing manifests', () => assert.deepEqual(validatePaths(DEFAULT_INPUTS).errors, []));
test('MCP inventory contains exactly the requested references', () => {
  const c = load(join(source, 'mcp-catalog.json'));
  assert.deepEqual(c.entries.map(e => e.id).sort(), ['chrome-devtools','cmem','context7','exa','firecrawl','n8n-mcp']);
  assert.ok(c.entries.every(e => e.auto_enable === false));
  assert.ok(c.entries.slice(1).every(e => e.classification === 'QUARANTINED' && e.inventory.permissions.length === 0));
});
for (const f of load(join(REPO_ROOT, 'tests/mcp-fixtures/negative.json'))) {
  bad(f.name, ({edit}) => edit(f.file, d => {
    let target = d;
    for (const k of f.path.slice(0, -1)) target = target[k];
    if (f.remove) delete target[f.path.at(-1)]; else target[f.path.at(-1)] = f.value;
  }));
}
for (const url of ['http://example.invalid/mcp','ftp://example.invalid/mcp','https://localhost/mcp','https://127.0.0.1/mcp','https://10.0.0.1/mcp','https://example.invalid/mcp?q=private','https://example.invalid/mcp#private','https://user:pass@example.invalid/mcp','https://example.invalid/%73ecret']) {
  bad(`unsafe endpoint ${url.split(':')[0]}`, ({add}) => add('docs-lookup.json', {...base, portable:undefined, id:'docs-lookup',url}));
}
for (const host of [
  'fc00::', 'fc00::1', 'FC00:0000:0000:0000:0000:0000:0000:0001',
  'fd00::1', 'FD00:0000:0000:0000:0000:0000:0000:0001', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  'fe80::', 'fe80::1', 'FE80:0000:0000:0000:0000:0000:0000:0001', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
]) {
  test(`MCP rejects private/link-local IPv6 endpoint [${host}]`, () => {
    const url = `https://[${host}]/mcp`;
    const doc = { ...base, portable: undefined, id: 'docs-lookup', url };
    assert.equal(safeEndpoint(url), false);
    assert.equal(semanticIdentity(doc), null);
    const errors = scenario(({ add }) => add('docs-lookup.json', doc));
    assert.ok(errors.some(e => e.code === 'MCP_POLICY' && e.rule === 'unsafe-endpoint' && e.path === '$.url'), JSON.stringify(errors));
  });
}
for (const key of Object.keys(base.portable.policy)) {
  bad(`missing policy ${key}`, editContext(d => { delete d.portable.policy[key]; }));
}
for (const key of ['mutations','shell','install','oauth']) bad(`Context7 ${key}`, editContext(d => {d.portable.policy[key] = true;}));
for (const pkg of ['example-mcp','example-mcp@latest','example-mcp@^1.2.3','example-mcp@1','example-mcp@main']) {
  bad(`unpinned package ${pkg}`, ({add}) => add('sample.json', { ...base, id:'sample', portable:undefined, url:undefined, transport:'stdio',command:'npx',args:['-y',pkg]}), 'pinned-stdio-declaration');
}
test('legacy pinned stdio manifest remains valid', () => {
  assert.deepEqual(scenario(({add})=>add('sample.json',{...base,id:'sample',portable:undefined,url:undefined,transport:'stdio',command:'npx',args:['-y','example-mcp@1.2.3']})),[]);
});
bad('remote semantic alias with different name and env', ({add}) => add('alias.json', {...base, id:'alias',portable:undefined,env_vars:['OTHER_KEY'],url:'https://MCP.CONTEXT7.COM:443/mcp/'}),'semantic-duplicate');
bad('stdio semantic duplicate despite package version and launcher flags', ({add}) => {
  for (const [id,version,args] of [['one','1.2.3',[]],['two','2.0.0',['-y']]]) add(`${id}.json`,{...base,id,portable:undefined,url:undefined,transport:'stdio',command:'npx',args:[...args,`example-mcp@${version}`]});
},'semantic-duplicate');
bad('catalog semantic duplicate ID', ({edit})=>edit('mcp-catalog.json',d=>d.entries.push({...d.entries[1], inventory:{...d.entries[1].inventory,reason:'Duplicate alias'}})), 'duplicate-entry');
bad('missing canonical manifest', ({root})=>rmSync(join(root,'context7.json')), 'catalog-reference');
bad('missing catalog', ({root})=>rmSync(join(root,'mcp-catalog.json')), 'missing-catalog');
bad('quarantined manifest', ({add})=>add('cmem.json',{...base,id:'cmem',portable:undefined,url:'https://example.invalid/mcp'}),'quarantined-manifest');
bad('quarantined reference promoted without verified manifest', ({edit})=>edit('mcp-catalog.json',d=>{d.entries[1].classification='OPTIONAL'; d.entries[1].manifest_id='chrome-devtools';}),'catalog-reference');
for (const kind of ['agent','technology-profile','adapter']) bad(`${kind} automatically claiming catalog MCP`, ({add}) => {
 const common={kind,id:'sample',schema_version:'1.0',version:'1.0.0',name:'sample',description:'Sample',compatibility:{standard:['1.0']}};
 const extra=kind==='agent'?{permissions:{tools:['Read']},mcp_servers:['context7']}:kind==='adapter'?{target_tool:'codex',output_dir:'build/codex',supports:{mcp_servers:['context7']}}:{languages:['typescript'],validation_commands:['npm test'],mcp_servers:['context7']};
 add('sample.json',{...common,...extra});
},'automatic-enablement-or-untested-claim');
bad('machine path', editContext(d=>{d.description='Reads '+ '/'+'Users'+'/synthetic/config';}));
bad('OpenClaw coupling', editContext(d=>{d.description='Requires open'+'claw';}));
for (const command of ['rm -rf /','git push --force','sudo tool','bash -c anything','tool --yolo','npm install package','oauth login']) bad(`executable instruction ${command.split(' ')[0]}`,editContext(d=>{d.description=command;}));
test('MCP diagnostics never include credential values', () => {
  const secret = 'synthetic-' + 'confidential-value';
  const errors = scenario(editContext(d=>{d.description=`Authorization: Bearer ${secret}`;}));
  assert.ok(errors.some(e=>e.rule==='inline-secret'));
  assert.ok(!JSON.stringify(errors).includes(secret));
});
test('semantic identity refuses private/authenticated URLs', () => {
  assert.equal(semanticIdentity({...base,portable:undefined,url:'https://user:password@example.invalid/mcp'}),null);
  assert.equal(semanticIdentity({...base,url:'https://mcp.context7.com/mcp/'}),semanticIdentity(base));
  assert.equal(safeEndpoint('https://example.invalid/mcp'),true);
});
test('templates contain references and no executable client configuration', () => {
 for(const f of readdirSync(join(source,'templates'))) {
  const d=load(join(source,'templates',f));
  assert.equal(d.policy_ref,'context7#/portable/policy');
  assert.equal(d.status,'untested');
  assert.equal(d.executable,false);
  assert.equal(d.command,undefined);
  assert.equal(d.url,undefined);
 }
});
bad('Context7 alias across remote and stdio transports', ({add}) => add('aaa-alias.json', {...base,id:'aaa-alias',portable:undefined,url:undefined,transport:'stdio',command:'npx',args:['-y','@upstash/context7-mcp@4.6.0']}), 'semantic-duplicate');
bad('duplicate catalogs', ({add}) => add('another-catalog.json',load(join(source,'mcp-catalog.json'))), 'duplicate-catalog');
bad('template referring to a missing canonical policy', ({edit}) => edit('templates/cursor.json', d => { d.policy_ref='missing#/policy'; }));
