import ts from 'typescript';
import { validateLoaderInputs } from './mutation-loader-inputs.mjs';

// This is a recognizer for the reviewed, data-only configuration contract, not
// a config loader. Never execute configuration to decide whether it is safe.
const basePath = 'vitest.config.ts';
const mutationPath = 'vitest.mutation.config.ts';
const strykerPath = 'stryker.config.json';
const testKeys = [
  'include',
  'environment',
  'execArgv',
  'testTimeout',
  'benchmark',
  'coverage',
  'isolate',
  'fsModuleCache',
  'maxWorkers',
];

function requireCondition(condition, description) {
  if (!condition) throw new Error(description);
}

function onlyKeys(value, keys, description) {
  requireCondition(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => keys.includes(key)),
    description,
  );
}

function equals(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function propertyName(node) {
  requireCondition(ts.isIdentifier(node) || ts.isStringLiteral(node), 'Computed config property');
  requireCondition(node.text !== '__proto__', 'Prototype config property');
  return node.text;
}

function objectValue(node, base) {
  const value = Object.create(null);
  const declared = new Set();
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = dataValue(property.expression, base);
      onlyKeys(spread, ['test', ...testKeys], 'Unsupported config spread');
      Object.assign(value, spread);
    } else {
      requireCondition(ts.isPropertyAssignment(property), 'Executable config property');
      const key = propertyName(property.name);
      requireCondition(!declared.has(key), 'Duplicate config property');
      declared.add(key);
      value[key] = dataValue(property.initializer, base);
    }
  }
  return value;
}

function baseValue(node, base) {
  if (base && ts.isIdentifier(node) && node.text === 'base') return base;
  if (base && ts.isPropertyAccessExpression(node) && node.getText() === 'base.test')
    return base.test;
  throw new Error('Executable or unsupported config expression');
}

const literals = new Map([
  [ts.SyntaxKind.TrueKeyword, true],
  [ts.SyntaxKind.FalseKeyword, false],
  [ts.SyntaxKind.NullKeyword, null],
]);
function dataValue(node, base) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (literals.has(node.kind)) return literals.get(node.kind);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => dataValue(item, base));
  if (ts.isObjectLiteralExpression(node)) return objectValue(node, base);
  return baseValue(node, base);
}

function singleNamedBinding(binding, name, kind) {
  if (!binding || !kind(binding) || binding.elements.length !== 1) return false;
  const element = binding.elements[0];
  return element.name.text === name && !element.propertyName && !element.isTypeOnly;
}

function configImport(node, base, seen) {
  requireCondition(
    !node.attributes && ts.isStringLiteral(node.moduleSpecifier),
    'Config import attributes',
  );
  const clause = node.importClause;
  requireCondition(clause && !clause.isTypeOnly, 'Config side-effect or type import');
  if (node.moduleSpecifier.text === 'vitest/config') {
    requireCondition(
      !clause.name &&
        !seen.has('defineConfig') &&
        singleNamedBinding(clause.namedBindings, 'defineConfig', ts.isNamedImports),
      'Unsupported defineConfig import',
    );
    seen.add('defineConfig');
  } else {
    requireCondition(base !== null, 'Base config cannot import itself');
    requireCondition(
      node.moduleSpecifier.text === './vitest.config.js' &&
        clause.name?.text === 'base' &&
        !clause.namedBindings &&
        !seen.has('base'),
      'Unreviewed config dependency',
    );
    seen.add('base');
  }
}

function baseReexport(node) {
  if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.attributes) return false;
  const specifier = node.moduleSpecifier;
  return (
    specifier &&
    ts.isStringLiteral(specifier) &&
    specifier.text === './vitest.config.js' &&
    singleNamedBinding(node.exportClause, 'default', ts.isNamedExports)
  );
}

function exportedConfig(node, seen, base) {
  requireCondition(
    ts.isExportAssignment(node) && !node.isExportEquals,
    'Executable config statement',
  );
  const call = node.expression;
  requireCondition(
    ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === 'defineConfig' &&
      seen.has('defineConfig') &&
      call.arguments.length === 1 &&
      !call.typeArguments,
    'Unsupported config export',
  );
  return dataValue(call.arguments[0], seen.has('base') ? base : null);
}

function configValue(files, path, base = null) {
  requireCondition(files.has(path), `Missing config source: ${path}`);
  const ast = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.Latest, true);
  requireCondition(ast.parseDiagnostics.length === 0, `Invalid config syntax: ${path}`);
  if (base && ast.statements.length === 1 && baseReexport(ast.statements[0])) return base;
  const seen = new Set();
  let value = null;
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node)) {
      requireCondition(value === null, 'Config import after export');
      configImport(node, base, seen);
    } else {
      requireCondition(value === null, 'Duplicate config export');
      value = exportedConfig(node, seen, base);
    }
  }
  onlyKeys(value, ['test'], 'Unsupported top-level config');
  onlyKeys(value.test, testKeys, 'Unsupported test configuration root');
  return value;
}

function optional(value, key, predicate) {
  requireCondition(
    !Object.hasOwn(value, key) || predicate(value[key]),
    `Unsupported ${key} option`,
  );
}

function testOptions(config, mutation) {
  const value = config.test;
  optional(value, 'environment', (item) => item === 'node');
  optional(value, 'execArgv', (item) => equals(item, ['--expose-gc']));
  optional(value, 'isolate', (item) => item === true);
  optional(value, 'fsModuleCache', (item) => item === false);
  optional(value, 'maxWorkers', (item) => item === 1);
  optional(value, 'testTimeout', (item) => Number.isSafeInteger(item) && item > 0);
  optional(value, 'benchmark', (item) => equals(item, { include: ['bench/**/*.bench.ts'] }));
  optional(value, 'coverage', (item) =>
    equals(item, {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 },
      reporter: ['text', 'lcov'],
    }),
  );
  requireCondition(
    !mutation || value.fsModuleCache === false,
    'Mutation module cache must be disabled',
  );
  requireCondition(
    Array.isArray(value.include) && value.include.length > 0,
    'Missing test selection',
  );
}

function strykerOptions(files) {
  requireCondition(files.has(strykerPath), 'Missing Stryker configuration');
  const value = JSON.parse(files.get(strykerPath));
  const required = {
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    coverageAnalysis: 'perTest',
    mutate: ['src/mp3/**/*.ts'],
    reporters: ['clear-text', 'progress', 'json'],
    thresholds: { high: 100, low: 100, break: 0 },
    tempDirName: '.stryker-tmp',
    ignorePatterns: ['reports/**', 'coverage/**', 'dist/**', '.git/**', '.cache/**'],
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    vitest: { configFile: mutationPath, related: false, pool: 'forks' },
    incremental: true,
    incrementalFile: '.cache/mutation/working.json',
  };
  onlyKeys(
    value,
    [...Object.keys(required), '$schema', 'concurrency', 'timeoutMS'],
    'Unsupported Stryker execution root',
  );
  requireCondition(
    Object.entries(required).every(([key, expected]) => equals(value[key], expected)),
    'Unreviewed Stryker execution configuration',
  );
  requireCondition(
    [1, 2].includes(value.concurrency) &&
      Number.isSafeInteger(value.timeoutMS) &&
      value.timeoutMS > 0,
    'Unsupported Stryker execution limits',
  );
  optional(
    value,
    '$schema',
    (item) => item === './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  );
}

function testSelection(files, include) {
  const globPrefixes = new Map([
    ['tests/**/*.test.ts', 'tests/'],
    ['tests/mp3/**/*.test.ts', 'tests/mp3/'],
  ]);
  if (include.length === 1 && globPrefixes.has(include[0]))
    return [...files.keys()]
      .filter((path) => path.startsWith(globPrefixes.get(include[0])) && /\.test\.ts$/.test(path))
      .sort();
  requireCondition(
    include.every(
      (path) =>
        typeof path === 'string' &&
        /^tests\/(?:[\w-]+\/)*[\w.-]+\.test\.ts$/.test(path) &&
        files.has(path),
    ),
    'Unresolved or unsupported test selection',
  );
  return [...new Set(include)].sort();
}

export function executionIsolation(files) {
  try {
    validateLoaderInputs(files);
    strykerOptions(files);
    const base = configValue(files, basePath);
    testOptions(base, false);
    const mutation = configValue(files, mutationPath, base);
    testOptions(mutation, true);
    const testFiles = testSelection(files, mutation.test.include);
    requireCondition(testFiles.length > 0, 'Empty selected test inventory');
    return { supported: true, testFiles };
  } catch (error) {
    return { supported: false, reason: `Unbounded mutation execution roots: ${error.message}` };
  }
}
