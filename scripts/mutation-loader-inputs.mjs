// The transformers/resolvers are the pinned installed toolchain. Project config
// may not introduce extra execution roots or untracked external configuration.
const configurations = new Set([
  'vitest.config.ts',
  'vitest.mutation.config.ts',
  'stryker.config.json',
]);
const compilerOptions = new Set([
  'target',
  'module',
  'moduleResolution',
  'rootDir',
  'outDir',
  'lib',
  'types',
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noUnusedLocals',
  'noUnusedParameters',
  'noPropertyAccessFromIndexSignature',
  'noUncheckedSideEffectImports',
  'verbatimModuleSyntax',
  'isolatedModules',
  'erasableSyntaxOnly',
  'forceConsistentCasingInFileNames',
  'skipLibCheck',
  'noEmitOnError',
  'noEmit',
]);

function requireCondition(condition, description) {
  if (!condition) throw new Error(description);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTsconfig(files, path) {
  requireCondition(
    ['tsconfig.json', 'tsconfig.lint.json'].includes(path),
    `Unreviewed compiler config: ${path}`,
  );
  const value = JSON.parse(files.get(path));
  requireCondition(
    object(value) &&
      Object.keys(value).every((key) => ['compilerOptions', 'include', 'extends'].includes(key)),
    'Unreviewed compiler config options',
  );
  if (Object.hasOwn(value, 'extends'))
    requireCondition(
      path === 'tsconfig.lint.json' &&
        value.extends === './tsconfig.json' &&
        files.has('tsconfig.json'),
      'Unbounded compiler config inheritance',
    );
  if (Object.hasOwn(value, 'include')) validateInclude(value.include);
  validateCompilerOptions(Object.hasOwn(value, 'compilerOptions') ? value.compilerOptions : {});
}

function validateInclude(include) {
  const allowed = new Set([
    'src/**/*.ts',
    'tests/**/*.ts',
    'bench/**/*.ts',
    'vitest.config.ts',
    'vitest.mutation.config.ts',
  ]);
  requireCondition(
    Array.isArray(include) && include.every((path) => allowed.has(path)),
    'Unbounded compiler input selection',
  );
}

function validateCompilerOptions(options) {
  requireCondition(
    object(options) && Object.keys(options).every((key) => compilerOptions.has(key)),
    'Unreviewed compiler loader options',
  );
  requireCondition(
    !Object.hasOwn(options, 'types') || JSON.stringify(options.types) === '["node"]',
    'Unreviewed compiler type entry points',
  );
  for (const [key, item] of Object.entries(options))
    requireCondition(
      ['types', 'lib'].includes(key) || ['boolean', 'string'].includes(typeof item),
      'Non-data compiler options',
    );
  if (Object.hasOwn(options, 'lib'))
    requireCondition(JSON.stringify(options.lib) === '["ES2025"]', 'Unreviewed compiler libraries');
}

function validatePackage(files, path) {
  requireCondition(path === 'package.json', `Nested package resolution boundary: ${path}`);
  const value = JSON.parse(files.get(path));
  requireCondition(object(value) && value.type === 'module', 'Unreviewed package module mode');
  for (const key of [
    'imports',
    'exports',
    'main',
    'module',
    'browser',
    'loader',
    'vitest',
    'vite',
    'stryker',
  ])
    requireCondition(!Object.hasOwn(value, key), `Unreviewed package resolver: ${key}`);
}

export function validateLoaderInputs(files) {
  requireCondition(files.has('package.json'), 'Missing package resolution source');
  requireCondition(files.has('tsconfig.json'), 'Missing bounded root tsconfig');
  for (const path of files.keys()) {
    if (/^\.?(?:vitest|vite|stryker)[^/]*\.(?:[cm]?[jt]s|json)$/.test(path))
      requireCondition(configurations.has(path), `Unreviewed configuration root: ${path}`);
    if (/(?:^|\/)tsconfig[^/]*\.json$/.test(path)) validateTsconfig(files, path);
    if (/(?:^|\/)package\.json$/.test(path)) validatePackage(files, path);
  }
}
