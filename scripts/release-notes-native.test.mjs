import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const repository = 'example/project';
const head = 'b'.repeat(40);
const base = 'a'.repeat(40);
const tag = 'v2.0.0';
const previousTag = 'v1.2.0';
const workflow = readFileSync(
  new URL('../.github/workflows/release-notes.yml', import.meta.url),
  'utf8',
);
const native = workflow.split('\n  native:\n')[1].split('\n  compose:\n')[0];
const script = native
  .match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s+JS\n/)[1]
  .split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');

function invoke(initial, change = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-native-offline-'));
  const routes = {
    '': { full_name: repository, id: 12345 },
    [`commits/${tag}`]: { sha: head },
    [`commits/${previousTag}`]: { sha: base },
    'git/matching-refs/tags/?per_page=100': [[{ ref: `refs/tags/${tag}` }]],
    'releases?per_page=100': [[{ tag_name: tag, draft: true }]],
    [`contents/.github/release-notes-initial.json?ref=${head}`]: {
      encoding: 'base64',
      content: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          repositoryId: '12345',
          baseSha: base,
        }),
      ).toString('base64'),
    },
  };
  change(routes);
  try {
    writeFileSync(join(directory, 'routes.json'), JSON.stringify(routes));
    writeFileSync(join(directory, 'calls.jsonl'), '');
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith('repos/')).slice('repos/${repository}/'.length);
const payload = args.includes('POST') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync('calls.jsonl', JSON.stringify({path, payload})+'\\n');
if (path === 'releases/generate-notes') process.stdout.write(JSON.stringify({body:'Native fixture'}));
else {
  const routes = JSON.parse(fs.readFileSync('routes.json', 'utf8'));
  if (!Object.hasOwn(routes, path)) process.exit(1);
  process.stdout.write(JSON.stringify(routes[path]));
}
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        GH_REPO: repository,
        GH_TOKEN: 'offline-fixture',
        RELEASE_TAG: tag,
        RELEASE_SHA: head,
        GITHUB_SHA: head,
        GITHUB_REF: `refs/tags/${tag}`,
        GITHUB_REPOSITORY_ID: '12345',
        PREVIOUS_TAG: initial ? '' : previousTag,
        PREVIOUS_SHA: base,
        INITIAL_RELEASE: String(initial),
      },
    });
    assert.ifError(result.error);
    return {
      ...result,
      calls: readFileSync(join(directory, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('native first-release job omits previous_tag_name and never invents or mutates a tag', () => {
  const result = invoke(true);
  assert.equal(result.status, 0, result.stderr);
  const posts = result.calls.filter(({ payload }) => payload);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    path: 'releases/generate-notes',
    payload: {
      tag_name: tag,
      target_commitish: head,
      configuration_file_path: '.github/release.yml',
    },
  });
});

test('ordinary native generation keeps an explicit existing previous tag', () => {
  const result = invoke(false);
  assert.equal(result.status, 0, result.stderr);
  const post = result.calls.find(({ payload }) => payload);
  assert.equal(post.payload.previous_tag_name, previousTag);
});

test('native job rejects a replaced repository or existing history before generating anything', () => {
  for (const change of [
    (r) => {
      r[''].id = 999;
    },
    (r) => {
      r['releases?per_page=100'][0].push({ tag_name: previousTag, draft: true });
    },
    (r) => {
      r['git/matching-refs/tags/?per_page=100'][0].push({ ref: `refs/tags/${previousTag}` });
    },
    (r) => delete r[`contents/.github/release-notes-initial.json?ref=${head}`],
    (r) => {
      r[`commits/${tag}`].sha = base;
    },
  ]) {
    const result = invoke(true, change);
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.every(({ payload }) => !payload));
  }
});
