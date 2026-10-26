// Shared source-backed inputs for fast cache/authentication regression tests.
import { readFileSync } from 'node:fs';
import { sha256 } from './mutation-policy.mjs';
import { sourceInput } from './mutation-compatibility.mjs';

export function fixtureInputs(files, testFiles) {
  const contents = {
    ...Object.fromEntries(files),
    'package.json': '{"type":"module","private":true}',
    'tsconfig.json': '{}',
    'vitest.config.ts':
      "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/**/*.test.ts'], isolate: true, fsModuleCache: false } });",
    'vitest.mutation.config.ts': "export { default } from './vitest.config.js';",
    'stryker.config.json': readFileSync(new URL('../stryker.config.json', import.meta.url), 'utf8'),
  };
  if (testFiles)
    contents['vitest.mutation.config.ts'] =
      `import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ${JSON.stringify(testFiles)}, isolate: true, fsModuleCache: false } });`;
  return {
    files: Object.entries(contents).map(([path, source]) => [path, 0o644, sha256(source)]),
    sources: Object.fromEntries(Object.entries(contents).filter(([path]) => sourceInput(path))),
  };
}
