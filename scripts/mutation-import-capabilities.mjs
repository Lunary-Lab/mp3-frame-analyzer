import ts from 'typescript';

// An installed-byte fingerprint does not make every export harmless. In
// particular crypto.setEngine can load native code from an arbitrary file.
// Only reviewed bindings of the pinned library/builtin surface are supported.
const bindings = new Map([
  [
    'vitest',
    new Set([
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
    ]),
  ],
  [
    'fast-check',
    new Set([
      'assert',
      'asyncProperty',
      'array',
      'boolean',
      'constantFrom',
      'integer',
      'record',
      'uint8Array',
    ]),
  ],
  ['node:crypto', new Set(['createHash'])],
  ['node:stream', new Set(['Readable'])],
  ['node:timers/promises', new Set(['setImmediate'])],
]);

function namedBindings(clause, allowed) {
  const named = clause.namedBindings;
  if (clause.name || !named || !ts.isNamedImports(named)) return false;
  return named.elements.every(
    (item) => item.isTypeOnly || allowed.has((item.propertyName ?? item.name).text),
  );
}

export function supportedExternalImport(specifier, declaration) {
  if (!declaration || !ts.isImportDeclaration(declaration)) return false;
  const clause = declaration.importClause;
  if (!clause) return false;
  const allowed = bindings.get(specifier);
  if (!allowed) return false;
  return clause.isTypeOnly || namedBindings(clause, allowed);
}
