import assert from 'node:assert/strict';
import { cp, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { repositoryRoot, runNpm } from './release-utils.mjs';

test('build removes emitted modules after their source is renamed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp3-build-clean-'));
  try {
    for (const file of ['package.json', 'tsconfig.json', 'src', 'scripts']) {
      await cp(join(repositoryRoot, file), join(root, file), { recursive: true });
    }
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    await writeFile(
      join(root, 'src/retired-module.ts'),
      'export const marker = "build regression";\n',
    );
    await runNpm(['run', 'build'], { cwd: root });
    assert.equal((await stat(join(root, 'dist/retired-module.js'))).isFile(), true);
    await rename(join(root, 'src/retired-module.ts'), join(root, 'src/current-module.ts'));
    await runNpm(['run', 'build'], { cwd: root });
    await assert.rejects(stat(join(root, 'dist/retired-module.js')), { code: 'ENOENT' });
    assert.equal((await stat(join(root, 'dist/current-module.js'))).isFile(), true);
    assert.equal((await stat(join(root, 'dist/server.js'))).isFile(), true);
    assert.equal((await stat(join(root, 'src/current-module.ts'))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
