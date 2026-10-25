import ts from 'typescript';
import { posix } from 'node:path';

// Deliberately bounded to this project's static ESM layout. Unknown resolution
// is a cache miss, never an optimistic guess about an unaffected test.
const packages = new Set(['vitest', 'fast-check']);
const readOnlyFs = new Set([
  'readFile',
  'readFileSync',
  'createReadStream',
  'readdir',
  'readdirSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'existsSync',
  'realpath',
  'realpathSync',
]);
const harmlessBuiltins = new Set([
  'node:assert',
  'node:assert/strict',
  'node:buffer',
  'node:crypto',
  'node:events',
  'node:os',
  'node:path',
  'node:stream',
  'node:timers',
  'node:timers/promises',
  'node:util',
]);

function recordFilesystemAccess(result, declaration) {
  result.reads = true;
  const bindings =
    declaration && ts.isImportDeclaration(declaration)
      ? declaration.importClause?.namedBindings
      : null;
  if (
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.some((item) => !readOnlyFs.has((item.propertyName ?? item.name).text))
  )
    result.writes = true;
}

function resolveDependency(file, specifier, files, result) {
  const path = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (path.startsWith('../') || path.startsWith('/')) {
    result.uncertain = true;
    return;
  }
  // The repository uses NodeNext .js specifiers for .ts implementations.
  const candidates = [
    path,
    path.replace(/\.js$/, '.ts'),
    path + '.ts',
    path + '.js',
    path + '/index.ts',
    path + '/index.js',
  ];
  const matches = [...new Set(candidates)].filter((name) => files.has(name));
  if (matches.length !== 1) result.uncertain = true;
  else result.dependencies.add(matches[0]);
}

function isModuleCall(expression) {
  const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
  const requireCall = ts.isIdentifier(expression) && expression.text === 'require';
  const viImport =
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'vi' &&
    ['mock', 'doMock', 'importActual', 'importMock'].includes(expression.name.text);
  return dynamicImport || requireCall || viImport;
}

function inspectCall(node, ast, result, add) {
  const expression = node.expression;
  if (isModuleCall(expression)) {
    if (node.arguments.length && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
    else result.uncertain = true;
  }
  if (
    ts.isIdentifier(expression) &&
    ['eval', 'Function', 'fetch', 'WebSocket'].includes(expression.text)
  )
    result.uncertain = true;
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText(ast) === 'process' &&
    ['getBuiltinModule', 'binding', '_linkedBinding'].includes(expression.name.text)
  )
    result.uncertain = true;
}

function imports(file, source, files) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = {
    dependencies: new Set(),
    uncertain: ast.parseDiagnostics.length > 0,
    reads: false,
    writes: false,
  };
  function add(specifier, declaration) {
    if (specifier === 'node:fs' || specifier === 'node:fs/promises') {
      recordFilesystemAccess(result, declaration);
      return;
    }
    if (packages.has(specifier) || harmlessBuiltins.has(specifier)) return;
    if (!specifier.startsWith('.')) {
      result.uncertain = true;
      return;
    }
    resolveDependency(file, specifier, files, result);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, node);
      else result.uncertain = true;
    }
    if (ts.isImportEqualsDeclaration(node)) result.uncertain = true;
    if (ts.isCallExpression(node)) inspectCall(node, ast, result, add);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Function', 'Worker', 'WebSocket'].includes(node.expression.text)
    )
      result.uncertain = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

export function testClosures(files, tests) {
  const modules = new Map();
  function module(file) {
    if (!modules.has(file))
      modules.set(
        file,
        files.has(file)
          ? imports(file, files.get(file), files)
          : { dependencies: new Set(), uncertain: true, reads: false, writes: false },
      );
    return modules.get(file);
  }
  return new Map(
    tests.map((test) => {
      const closure = { files: new Set(), uncertain: false, reads: false, writes: false };
      function visit(file) {
        if (closure.files.has(file)) return;
        closure.files.add(file);
        const item = module(file);
        for (const flag of ['uncertain', 'reads', 'writes']) closure[flag] ||= item[flag];
        for (const dependency of item.dependencies) visit(dependency);
      }
      visit(test);
      return [test, closure];
    }),
  );
}

export function testWitnesses(report) {
  return new Map(
    Object.entries(report.testFiles ?? {}).flatMap(([file, record]) =>
      record.tests.map((test) => [
        test.id,
        { file, identity: JSON.stringify([file, record.source, test.name, test.location]) },
      ]),
    ),
  );
}

function unsupportedImpact(tests, before, after, changed) {
  for (const test of tests) {
    const old = before.get(test);
    const current = after.get(test);
    if (old.uncertain || current.uncertain) return `Unresolved import impact: ${test}`;
    // Fork isolation does not isolate shared files, subprocesses or services.
    // Opaque/state-writing graphs are outside this incremental contract.
    if (old.writes || current.writes) return `Shared external-state capability: ${test}`;
    if (changed.has(test) && (old.reads || current.reads))
      return `Changed external-input test: ${test}`;
  }
  return null;
}

/** Keep only an unchanged killed mutant with an unaffected source-backed killer. */
export function planReuse(report, currentFiles) {
  const oldFiles = new Map(currentFiles);
  for (const [file, record] of Object.entries({ ...report.files, ...report.testFiles }))
    oldFiles.set(file, record.source);
  const changed = new Set(
    [...oldFiles.keys(), ...currentFiles.keys()].filter(
      (file) => oldFiles.get(file) !== currentFiles.get(file),
    ),
  );
  const tests = Object.keys(report.testFiles);
  const before = testClosures(oldFiles, tests);
  const after = testClosures(currentFiles, tests);
  const reason = unsupportedImpact(tests, before, after, changed);
  if (reason) return { report: null, reason };
  const affected = new Set(
    tests.filter(
      (test) =>
        changed.has(test) ||
        before.get(test).reads ||
        after.get(test).reads ||
        [...changed].some(
          (file) => before.get(test).files.has(file) || after.get(test).files.has(file),
        ),
    ),
  );
  const witnesses = testWitnesses(report);
  const copy = structuredClone(report);
  let eligible = 0;
  let rerun = 0;
  for (const [file, record] of Object.entries(copy.files)) {
    record.mutants = record.mutants.filter((mutant) => {
      const killers = (mutant.killedBy ?? []).filter(
        (id) => witnesses.has(id) && !affected.has(witnesses.get(id).file),
      );
      const reuse =
        currentFiles.get(file) === record.source &&
        mutant.status === 'Killed' &&
        mutant.static !== true &&
        killers.length > 0;
      if (reuse) {
        mutant.killedBy = killers;
        eligible++;
      } else rerun++;
      return reuse;
    });
  }
  return {
    report: copy,
    eligible,
    rerun,
    affectedTests: [...affected].sort(),
    changedFiles: [...changed].sort(),
    reason: changed.size
      ? 'validated unaffected killing-test witnesses'
      : 'validated unchanged inputs',
  };
}
