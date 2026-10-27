import ts from 'typescript';
import { posix } from 'node:path';

const builtins = new Set([
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:path',
  'node:os',
  'node:url',
  'node:crypto',
]);
const packages = new Set(['vitest/package.json', '@stryker-mutator/core/package.json']);

// These modules run outside isolated Vitest files. Their entire static import
// closure stays global, even when an otherwise unrelated tooling file joins it.
export function runtimeDependencyPaths(files) {
  const paths = new Set();
  function visit(path) {
    if (paths.has(path)) return;
    if (!files.has(path)) throw new Error(`Unresolved mutation runtime dependency: ${path}`);
    paths.add(path);
    const ast = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) throw new Error(`Invalid mutation runtime source: ${path}`);
    function inspect(node) {
      inspectImport(node, path, files, visit);
      if (ts.isImportEqualsDeclaration(node) || dynamicModuleAccess(node) || opaqueResolution(node))
        throw new Error(`Opaque mutation runtime dependency: ${path}`);
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
  if (files.has('scripts/run-mutations.mjs')) visit('scripts/run-mutations.mjs');
  return paths;
}

function inspectImport(node, path, files, visit) {
  if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier)
    return;
  if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error('Opaque mutation runtime import');
  const specifier = node.moduleSpecifier.text;
  if (specifier.startsWith('.')) visit(resolve(path, specifier, files));
  else if (!builtins.has(specifier) && !['typescript', 'yaml'].includes(specifier))
    throw new Error(`Unreviewed mutation runtime package: ${specifier}`);
}

function dynamicModuleAccess(node) {
  if (!ts.isCallExpression(node)) return false;
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

function resolve(path, specifier, files) {
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  const candidates = [...new Set([target, target.replace(/\.js$/, '.ts')])].filter((candidate) =>
    files.has(candidate),
  );
  if (target.startsWith('../') || candidates.length !== 1)
    throw new Error(`Unresolved mutation runtime import: ${path} -> ${specifier}`);
  return candidates[0];
}

function opaqueResolution(node) {
  if (!ts.isMetaProperty(node)) return false;
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access)) return true;
  if (access.name.text === 'url') return false;
  const call = access.parent;
  return (
    access.name.text !== 'resolve' ||
    !ts.isCallExpression(call) ||
    call.expression !== access ||
    call.arguments.length !== 1 ||
    !ts.isStringLiteral(call.arguments[0]) ||
    !packages.has(call.arguments[0].text)
  );
}
