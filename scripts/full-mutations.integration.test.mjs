import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentSources, runShard, collectShards } from './full-mutations.mjs';
import { sourceContext } from './mutation-policy.mjs';
import { ENCODER_TEST_NAMES } from './verify-encoder-discovery.mjs';
import { repositoryRoot } from './release-utils.mjs';

async function fixture() {
  await mkdir(join(repositoryRoot, '.cache'), { recursive: true });
  const root = await mkdtemp(join(repositoryRoot, '.cache/full-shard-toy-'));
  await mkdir(join(root, 'src/mp3'), { recursive: true });
  await mkdir(join(root, 'tests/mp3'), { recursive: true });
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const config = JSON.parse(await readFile(join(repositoryRoot, 'stryker.config.json'), 'utf8'));
  const files = {
    '.gitignore': 'node_modules/\n.cache/\nreports/\n.stryker-tmp/\n',
    'package.json': '{"type":"module"}',
    'src/mp3/a.ts': 'export const positive = (n: number) => n > 0;\n',
    'src/mp3/b.ts': 'export const negative = (n: number) => n < 0;\n',
    'vitest.config.ts':
      "export default { test: { include: ['tests/**/*.test.ts'], maxWorkers: 1 } };",
    'vitest.mutation.config.ts':
      "export default { test: { include: ['tests/mp3/**/*.test.ts'], maxWorkers: 1 } };",
    'stryker.config.json': JSON.stringify(config),
    'tests/mp3/free-format-real.test.ts': `import {test,expect} from 'vitest';
      import {positive} from '../../src/mp3/a';
      import {negative} from '../../src/mp3/b';
      for(const name of ${JSON.stringify(ENCODER_TEST_NAMES)}) test(name,()=>{
        for(const n of [-1,0,1]) {
          expect(positive(n)).toBe(n===1);
          expect(negative(n)).toBe(n===-1);
        }
      });`,
  };
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  await writeFile(
    join(root, 'mutation-equivalents.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: 100,
      strykerVersion: '10.1.1',
      equivalents: [],
      contextSha256: sourceContext(await currentSources(root)),
    }),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Mutation fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=.disabled-hooks',
      'commit',
      '-qm',
      'Native shard fixture',
    ],
    { cwd: root },
  );
  return root;
}

test(
  'native whole-file shards remain fresh and collection fails closed',
  { timeout: 90000 },
  async () => {
    const root = await fixture();
    const directory = join(root, 'reports/mutation-shards');
    const attempt = process.env.GITHUB_RUN_ATTEMPT ?? 'local';
    try {
      // The second run sees the first native working report: it must clear it.
      for (const shard of [0, 1]) {
        await runShard(root, shard);
        await cp(
          join(root, 'reports/mutation'),
          join(directory, `full-parser-shard-${attempt}-${shard}`),
          { recursive: true },
        );
      }
      await collectShards(root, directory);
      const summary = JSON.parse(await readFile(join(root, 'reports/mutation/audit.json'), 'utf8'));
      assert.equal(summary.total, 10);
      assert.equal(summary.adjustedScore, 100);
      assert.equal(summary.execution.reused, 0);
      assert.equal(summary.execution.shards, 2);
      await assert.rejects(readFile(join(root, '.cache/mutation/native-baseline.json')), {
        code: 'ENOENT',
      });
      await assert.rejects(readFile(join(root, '.cache/mutation/pr-baseline.json')), {
        code: 'ENOENT',
      });
      const changed = join(root, 'src/mp3/a.ts');
      const source = await readFile(changed, 'utf8');
      await writeFile(changed, source + '// changed input\n');
      await assert.rejects(collectShards(root, directory), /Inconsistent shard inputs/);
      await writeFile(changed, source);
      await rm(join(directory, `full-parser-shard-${attempt}-1/complete.json`));
      await assert.rejects(collectShards(root, directory), { code: 'ENOENT' });
      const testPath = join(root, 'tests/mp3/free-format-real.test.ts');
      await writeFile(
        testPath,
        (await readFile(testPath, 'utf8')) + "\ntest('failure',()=>{throw Error('expected')});",
      );
      await assert.rejects(runShard(root, 0), /did not complete cleanly/);
      await assert.rejects(readFile(join(root, 'reports/mutation/complete.json')), {
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
