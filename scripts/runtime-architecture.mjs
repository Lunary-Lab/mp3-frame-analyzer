import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { noProcessLoading } from './runtime-architecture-rule.mjs';

const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const forbiddenModules = ['child_process', 'node:child_process'];
const config = {
  files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
  languageOptions: {
    parser: tseslint.parser,
    globals: globals.node,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  plugins: { architecture: { rules: { 'no-process-loading': noProcessLoading } } },
  linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  rules: {
    'architecture/no-process-loading': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-restricted-imports': ['error', { paths: forbiddenModules }],
    'no-restricted-modules': ['error', { paths: forbiddenModules }],
    'no-restricted-syntax': [
      'error',
      {
        selector:
          'CallExpression[callee.type=Identifier][callee.name=/^(execSync|exec|spawn|eval|Function)$/]',
        message: 'Runtime source must not execute processes or dynamic code.',
      },
      {
        selector: 'NewExpression[callee.type=Identifier][callee.name=Function]',
        message: 'Runtime source must not construct dynamic code.',
      },
    ],
  },
};

export function inspectRuntimeSource(source, filename) {
  assert.ok(extensions.has(extname(filename)), 'Unsupported runtime source extension');
  const linter = new Linter();
  const messages = linter.verify(source, [config], { filename, allowInlineConfig: false });
  assert.deepEqual(
    linter.getSuppressedMessages(),
    [],
    'Runtime architecture findings were suppressed',
  );
  return messages;
}

export async function runtimeFiles(directory) {
  const metadata = await lstat(directory);
  assert.ok(
    metadata.isDirectory() && !metadata.isSymbolicLink(),
    'Runtime root must be a real directory',
  );
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await runtimeFiles(path)));
    } else {
      assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'Runtime input must be a regular file');
      assert.ok(extensions.has(extname(path)), `Unsupported runtime source: ${path}`);
      files.push(path);
    }
  }
  return files.sort();
}

async function readRuntimeSource(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok((await file.stat()).isFile(), 'Runtime input must be a regular file');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function inspectRuntime(directory) {
  const files = await runtimeFiles(directory);
  assert.ok(files.length > 0, 'Runtime source inventory is empty');
  const findings = [];
  for (const path of files) {
    const name = relative(directory, path).replaceAll('\\', '/');
    const source = await readRuntimeSource(path);
    for (const finding of inspectRuntimeSource(source, name))
      findings.push({ path: name, ...finding });
  }
  return { files: files.map((path) => relative(directory, path).replaceAll('\\', '/')), findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    2,
    'Runtime architecture scan accepts no overrides or target arguments',
  );
  const result = await inspectRuntime(fileURLToPath(new URL('../src/', import.meta.url)));
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.length > 0) process.exitCode = 1;
}
