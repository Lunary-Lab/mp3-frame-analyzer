import ts from 'typescript';

// Capability screening for the supported static-ESM contract, not a JavaScript
// sandbox. Reject indirect access instead of pretending it has no dependencies.
const opaqueGlobals = new Set([
  'eval',
  'Function',
  'fetch',
  'WebSocket',
  'Worker',
  'SharedWorker',
  'XMLHttpRequest',
  'self',
  'Deno',
  'Bun',
  'Reflect',
  'Proxy',
  'module',
  'Object',
]);
const resourceAssertions = new Set([
  // Privileged assertion state exposes filesystem-capable snapshot environments,
  // including through aliases supplied by native TestContext rather than imports.
  'getState',
  'setState',
  'snapshotState',
  'readSnapshotFile',
  'saveSnapshotFile',
  'matchSnapshot',
  'toMatchFileSnapshot',
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
]);
const vitestImports = new Set([
  'describe',
  'it',
  'test',
  'expect',
  'vi',
  'beforeAll',
  'beforeEach',
  'afterAll',
  'afterEach',
  'onTestFailed',
  'onTestFinished',
]);
const processData = new Set(['env', 'version', 'versions', 'platform', 'arch']);
const processCalls = new Set(['cwd', 'memoryUsage']);
const moduleCalls = new Set(['mock', 'doMock', 'importActual', 'importMock']);
const viCalls = new Set([
  ...moduleCalls,
  'fn',
  'mocked',
  'resetAllMocks',
  'clearAllMocks',
  'restoreAllMocks',
  'resetModules',
  'stubEnv',
  'unstubAllEnvs',
  'hoisted',
]);
const reflectiveProperties = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__lookupGetter__',
  '__lookupSetter__',
  '__defineGetter__',
  '__defineSetter__',
]);

function directCall(node) {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function literalCall(node) {
  return (
    directCall(node) &&
    node.parent.arguments.length > 0 &&
    ts.isStringLiteral(node.parent.arguments[0])
  );
}

function member(node) {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
    ? node.parent
    : null;
}

function processReference(node) {
  const access = member(node);
  if (!access) return true;
  return (
    !processData.has(access.name.text) &&
    !(processCalls.has(access.name.text) && directCall(access))
  );
}

function globalReference(node) {
  const access = member(node);
  return !access || !['gc', '__mutationIsolation'].includes(access.name.text);
}

function directVitestBinding(node) {
  const binding = node.parent;
  if (!ts.isImportSpecifier(binding) || binding.name !== node || binding.propertyName) return false;
  const declaration = binding.parent.parent.parent;
  return (
    ts.isImportDeclaration(declaration) &&
    ts.isStringLiteral(declaration.moduleSpecifier) &&
    declaration.moduleSpecifier.text === 'vitest'
  );
}

function viReference(node) {
  if (directVitestBinding(node)) return false;
  const access = member(node);
  if (!access || !viCalls.has(access.name.text) || !directCall(access)) return true;
  return moduleCalls.has(access.name.text) && !literalCall(access);
}

const expectCalls = new Set([
  'objectContaining',
  'arrayContaining',
  'stringContaining',
  'stringMatching',
  'any',
  'anything',
  'assertions',
  'hasAssertions',
  'poll',
]);
function expectReference(node) {
  if (directVitestBinding(node) || directCall(node)) return false;
  const access = member(node);
  return !access || !expectCalls.has(access.name.text) || !directCall(access);
}
function symbolReference(node) {
  const access = member(node);
  return !access || !['iterator', 'asyncIterator'].includes(access.name.text);
}

function jsonReference(node) {
  const access = member(node);
  return (
    !access ||
    !['parse', 'stringify'].includes(access.name.text) ||
    !directCall(access) ||
    access.parent.arguments.length !== 1
  );
}

const identifierChecks = new Map([
  ['process', processReference],
  ['globalThis', globalReference],
  ['global', (node) => member(node)?.name.text !== 'gc'],
  ['require', (node) => !literalCall(node)],
  ['vi', viReference],
  ['expect', expectReference],
  ['Symbol', symbolReference],
  ['JSON', jsonReference],
]);
function opaqueIdentifier(node) {
  return (
    opaqueGlobals.has(node.text) ||
    reflectiveProperties.has(node.text) ||
    (identifierChecks.get(node.text)?.(node) ?? false)
  );
}

function opaqueVitestImport(node) {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'vitest')
    return false;
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((binding) => {
    const name = (binding.propertyName ?? binding.name).text;
    return (
      !vitestImports.has(name) || (['vi', 'expect'].includes(name) && binding.name.text !== name)
    );
  });
}

function opaqueMetadata(node) {
  const access = member(node);
  return node.keywordToken !== ts.SyntaxKind.ImportKeyword || !access || access.name.text !== 'url';
}

function numericKey(node) {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return numericKey(node.expression);
  if (ts.isPostfixUnaryExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node))
    return [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.TildeToken,
      ts.SyntaxKind.PlusPlusToken,
      ts.SyntaxKind.MinusMinusToken,
    ].includes(node.operator);
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return numericKey(node.left) && numericKey(node.right);
  return [
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken,
    ts.SyntaxKind.LessThanLessThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ].includes(node.operatorToken.kind);
}

function iteratorKey(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Symbol' &&
    ['iterator', 'asyncIterator'].includes(node.name.text)
  );
}

function resourceAssertion(node) {
  if (ts.isStringLiteral(node) && node.text === 'expect') return true;
  return (
    (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
    (resourceAssertions.has(node.text) || reflectiveProperties.has(node.text))
  );
}

function opaqueElementAccess(node, reviewedSites) {
  const key = node.argumentExpression;
  if (ts.isStringLiteral(key)) return reflectiveProperties.has(key.text);
  if (iteratorKey(key) || numericKey(key)) return false;
  // Permission is exact source/path/site-bound, never inferred from a TS type,
  // variable name or the assumption that an extracted value will not be called.
  return !reviewedSites.has(node.getText());
}

function opaqueBinding(node) {
  const key = node.propertyName ?? node.name;
  if (ts.isComputedPropertyName(key)) return true;
  return (ts.isIdentifier(key) || ts.isStringLiteral(key)) && reflectiveProperties.has(key.text);
}

const nodeChecks = new Map([
  [ts.SyntaxKind.Identifier, opaqueIdentifier],
  [ts.SyntaxKind.ImportDeclaration, opaqueVitestImport],
  [ts.SyntaxKind.MetaProperty, opaqueMetadata],
  [ts.SyntaxKind.PropertyAccessExpression, (node) => reflectiveProperties.has(node.name.text)],
  [ts.SyntaxKind.ElementAccessExpression, opaqueElementAccess],
  [ts.SyntaxKind.BindingElement, opaqueBinding],
  [
    ts.SyntaxKind.ComputedPropertyName,
    (node) => !iteratorKey(node.expression) && !numericKey(node.expression),
  ],
  [
    ts.SyntaxKind.ExportDeclaration,
    (node) =>
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'vitest',
  ],
]);

export function opaqueCapability(node, reviewedSites = new Set()) {
  // Snapshot APIs can read/write arbitrary external paths through Vitest, with
  // no node:fs import in the test. They are outside the reusable pure contract.
  return resourceAssertion(node) || Boolean(nodeChecks.get(node.kind)?.(node, reviewedSites));
}
