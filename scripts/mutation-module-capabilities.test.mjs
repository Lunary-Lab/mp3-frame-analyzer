import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import { opaqueCapability } from './mutation-module-capabilities.mjs';
import { reviewedDataAccess } from './mutation-reviewed-data-access.mjs';

function opaqueNodes(source, path = 'test.ts') {
  const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, source);
  const result = [];
  function visit(node) {
    if (opaqueCapability(node, reviewedDataAccess(path, source))) result.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

for (const source of [
  "process['getBuiltinModule']('fs').readFileSync('docs/input.md');",
  "const get = process.getBuiltinModule; get('fs');",
  "const p = process; p.getBuiltinModule('fs');",
  "const { getBuiltinModule: get } = process; get('fs');",
  "globalThis.process.getBuiltinModule('fs');",
  "globalThis['process'].getBuiltinModule('fs');",
  "const g = globalThis; g.process.getBuiltinModule('fs');",
  "globalThis['gc']();",
  'globalThis.fetch(url);',
  "process.binding('fs');",
  "const r = require; r('node:fs');",
  "require.resolve('node:fs');",
  'require(name);',
  'require(`node:fs`);',
  "import { vi as v } from 'vitest'; v.importActual(name);",
  "import { vitest as v } from 'vitest'; v.importActual(name);",
  "import * as toolkit from 'vitest'; toolkit.vi.importActual(name);",
  "import toolkit from 'vitest'; toolkit.vi.importActual(name);",
  "export { vi as toolkit } from 'vitest';",
  "export * from 'vitest';",
  "import { vi } from 'vitest'; const v = vi; v.importActual(name);",
  "import { vi } from 'vitest'; vi['importActual'](name);",
  "import { vi } from 'vitest'; const load = vi.importActual; load(name);",
  "import { vi } from 'vitest'; vi.mock(name);",
  "import { vi } from 'vitest'; vi.importMock(`module`);",
  "import { vi } from 'vitest'; vi.unknown('./module.js');",
  "import.meta.glob('docs/*.md');",
  "import.meta.resolve('node:fs');",
  "import.meta['url'];",
  'const meta = import.meta;',
  'const execute = eval; execute(code);',
  'const Constructor = Function; new Constructor(code)();',
  'const get = fetch; get(url);',
  'new Worker(url);',
  'new SharedWorker(url);',
  'new WebSocket(url);',
  'new XMLHttpRequest();',
  'const get = Reflect.get; get(globalThis, name);',
  'new Proxy({}, {});',
  'global.process;',
  'window.fetch(url);',
  'self.fetch(url);',
  'Deno.readFile(path);',
  'Bun.file(path);',
  'module.createRequire(path);',
  "(() => {}).constructor('return process')();",
  "(() => {})['constructor']('return process')();",
  'Object.getPrototypeOf(() => {});',
  'Object.getOwnPropertyDescriptor(object, name);',
  'Object.defineProperty(object, name, descriptor);',
  "Object['getPrototypeOf'](() => {});",
  'const object = Object; object.getPrototypeOf(value);',
  'value.__proto__;',
  'value.prototype;',
])
  test(`rejects indirect or opaque execution capability: ${source}`, () => {
    assert.ok(opaqueNodes(source).length > 0, source);
  });

for (const source of [
  "const seed = process.env['PROPERTY_SEED'];",
  "process.env.MUTATION_ISOLATION_PROBE = 'set';",
  'const version = [process.version, process.versions.v8, process.platform, process.arch];',
  'const cwd = process.cwd(); const heap = process.memoryUsage().heapUsed;',
  'globalThis.gc?.();',
  'const collect = global.gc; collect?.();',
  "globalThis.__mutationIsolation = 'set';",
  "require('./helper.js');",
  "import { vi } from 'vitest'; vi.mock('./helper.js', () => ({}));",
  "import { vi } from 'vitest'; vi.doMock('./helper.js');",
  "import { vi } from 'vitest'; vi.importActual('./helper.js');",
  "import { vi } from 'vitest'; vi.importMock('./helper.js');",
  "import { vi } from 'vitest'; vi.fn();",
  "const url = new URL('./fixture.json', import.meta.url);",
  'JSON.parse(text); JSON.stringify(value);',
  'class Reader { constructor(input: Uint8Array) { this.input = input; } }',
  'const byte = buffer[0]; const span = lengths[+index];',
  'const iterate = { [Symbol.asyncIterator]() { return this; } };',
])
  test(`retains supported direct data and module access: ${source}`, () => {
    assert.deepEqual(opaqueNodes(source), []);
  });

test('current parser and selected native test syntax stays within the supported contract', async () => {
  const project = new URL('../', import.meta.url);
  const config = await readFile(new URL('vitest.mutation.config.ts', project), 'utf8');
  const selected = [...config.matchAll(/'([^']+\.test\.ts)'/g)].map((match) => match[1]);
  const parser = (await readdir(new URL('src/mp3/', project)))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/mp3/${name}`);
  const helpers = (await readdir(new URL('tests/helpers/', project)))
    .filter((name) => !['http.ts', 'upload-socket.ts'].includes(name))
    .map((name) => `tests/helpers/${name}`);
  for (const path of [...selected, ...parser, ...helpers])
    assert.deepEqual(opaqueNodes(await readFile(new URL(path, project), 'utf8'), path), [], path);
});

for (const source of [
  "expect(value).toMatchFileSnapshot('docs/input.md');",
  'expect(value).toMatchSnapshot();',
  "const match = expectation.toMatchFileSnapshot; match('docs/input.md');",
  "const name = ['toMatch', 'FileSnapshot'].join(''); expect(value)[name]('docs/input.md');",
  "const name = 'fetch'; globalThis[name](url);",
  "import { Snapshots } from 'vitest';",
  "import { chai } from 'vitest';",
  "import { expect as check } from 'vitest';",
]) {
  test(`resource assertions and indirect assertion capabilities fail closed: ${source}`, () => {
    const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
    let opaque = false;
    function visit(node) {
      opaque ||= opaqueCapability(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(opaque, true);
  });
}

for (const source of [
  "const key='con'+'structor'; const load=(()=>{})[key]; load(code)();",
  "const assertion=expect(value); const method=assertion[['toMatch','FileSnapshot'].join('')]; method.call(assertion,path);",
  'const { constructor: load } = (()=>{}); load(code)();',
  'const { constructor } = (()=>{}); constructor(code)();',
  'let load; ({ constructor: load } = (()=>{})); load(code)();',
  'let constructor; ({ constructor } = (()=>{})); constructor(code)();',
  "const key='constructor'; const { [key]: load } = (()=>{});",
  "let load; const key='constructor'; ({ [key]: load } = (()=>{}));",
  "let load; ({ ['constructor']: load } = (()=>{}));",
  'const { __proto__: load } = (()=>{});',
  'const { prototype: load } = (()=>{});',
  'const check=expect; check.getState();',
  "expect.getState().snapshotState.environment.readSnapshotFile('docs/input.md');",
  "it('reads', (context) => context['expect'].getState());",
  "it('reads', (context) => { const {'expect': check}=context; check.getState(); });",
  "const assertion=expect(value); vi.spyOn(assertion, ['toMatch','FileSnapshot'].join(''));",
  'expect(value).matchSnapshot();',
  "const Symbol = {asyncIterator:'constructor'}; const load=(()=>{})[Symbol.asyncIterator];",
]) {
  test(`rejects the entire indirect extraction family: ${source}`, () => {
    const ast = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
    let opaque = false;
    function visit(node) {
      opaque ||= opaqueCapability(node);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(opaque, true);
  });
}

// Cover the AST property-name families, not just alternative spellings of one
// element access: declaration/assignment, binding/shorthand/property assignment,
// quoted/computed names and escaped source text all identify the same capability.
for (const source of [
  "let load; ({ 'constructor': load } = (() => {}));",
  'let load; ({ "constructor": load } = (() => {}));',
  "let load; ({ '\\x63onstructor': load } = (() => {}));",
  "let load; ({ '__proto__': load } = (() => {}));",
  "let load; ({ 'prototype': load } = (() => {}));",
  "const { 'constructor': load } = (() => {});",
  'const { constructor: { constructor: load } } = (() => {});',
  "const { ...rest } = (() => {}); const load=rest['constructor'];",
  "let rest; ({ ...rest } = (() => {})); const load=rest['constructor'];",
  'const load=(()=>{})[`constructor`];',
  "const load=(()=>{})['con'+'structor'];",
  'let load; ({ [`constructor`]: load } = (() => {}));',
]) {
  test(`rejects reflective property-name AST family: ${source}`, () => {
    assert.ok(opaqueNodes(source).length > 0, source);
  });
}

for (const source of [
  'Object.entries(value);',
  'Object.values(value);',
  'Object.keys(value);',
  'Object.assign({}, value);',
  "const check=context['expect']; const method=Object.entries(check).find(([name])=>name===['get','State'].join(''))[1]; method();",
  "const {'expect':check}=context;",
  "context.__lookupGetter__('expect');",
  "const getter=value['__lookupGetter__'];",
  "let getter; ({ '__lookupSetter__': getter } = value);",
  'JSON.stringify(value, (key, value) => value);',
  'JSON.parse(text, reviver);',
  'const stringify=JSON.stringify; stringify(value, callback);',
  'const json=JSON; json.stringify(value);',
  "JSON['stringify'](value);",
]) {
  test(`reflective enumeration or callback extraction is unsupported: ${source}`, () => {
    assert.ok(opaqueNodes(source).length > 0, source);
  });
}
