import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  auditPullRequests,
  changelogEntry,
  compareCommits,
  composeReleaseNotes,
  digest,
  validateIdentity,
  verifyPullRequestInventory,
} from './release-notes-core.mjs';
import { githubReader, prepareReleaseNotes, verifyTags } from './release-notes.mjs';

const repository = 'example/project';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const middle = 'c'.repeat(40);
const tag = 'v2.0.0';
const previousTag = 'v1.2.0';
const identity = { repository, tag, sha: head };
const compareUrl = `https://github.com/${repository}/compare/${previousTag}...${tag}`;
const userNotes =
  `## [2.0.0](${compareUrl}) (2026-10-25)\n\n` +
  '### ⚠ BREAKING CHANGES\n\n- Change the default. Set `includeHeader=true` to retain the old behavior.\n\n' +
  `### Features\n\n- New behavior ([commit](https://github.com/${repository}/commit/${middle})).`;
const producer = { runId: '123', runAttempt: '1', workflowSha: head };
const commit = (sha, message = 'chore: engineering change') => ({ sha, commit: { message } });
const pull = (number, sha = head, extra = {}) => ({
  number,
  merge_commit_sha: sha,
  merged_at: '2026-10-25T00:00:00Z',
  base: { ref: 'main', repo: { full_name: repository } },
  ...extra,
});
const comparison = (commits, total = commits.length) => ({
  status: 'ahead',
  base_commit: { sha: base },
  merge_base_commit: { sha: base },
  total_commits: total,
  commits,
});
const plan = (prs = [pull(1)], direct = []) => ({
  ...identity,
  previousTag,
  previousSha: base,
  userNotes,
  producer,
  pullRequests: prs,
  directCommits: direct,
});
const native = (numbers = [1], extra = '') => ({
  name: 'Native release name is not another version authority',
  body:
    `## What's Changed\n${numbers
      .map((n) => `* Change ${n} by @author in ` + `https://github.com/${repository}/pull/${n}`)
      .join('\n')}\n\n${extra}` + `**Full Changelog**: ${compareUrl}`,
});

test('composition is deterministic and preserves every user/breaking/migration byte', () => {
  const result = composeReleaseNotes(plan(), native());
  assert.deepEqual(composeReleaseNotes(plan(), native()), result);
  assert.ok(result.body.startsWith(`${userNotes}\n\n## Engineering changes`));
  assert.ok(result.body.includes(`([commit](https://github.com/${repository}/commit/${head}))`));
  assert.ok(result.body.includes(`compare/${base}...${head}`));
  assert.equal(result.manifest.userNotesSha256, digest(userNotes));
  assert.equal(result.manifest.bodySha256, digest(result.body));
  assert.deepEqual(result.manifest.producer, producer);
  // Recomposition starts from CHANGELOG, not an already composed draft body.
  assert.equal(result.body.match(/## Engineering changes/g).length, 1);
  assert.throws(
    () => changelogEntry(`${userNotes}\n\n${userNotes}`, repository, tag),
    /exactly one/,
  );
});

test('finds the requested version only and rejects unbound or wrong ranges', () => {
  const changelog = `# Changelog\n\n${userNotes}\n\n## [1.2.0](older)\n\nOld notes`;
  assert.deepEqual(changelogEntry(changelog, repository, tag), { previousTag, userNotes });
  for (const value of [
    userNotes.replace('...v2.0.0', '...v2.0.1'),
    userNotes.replace('/compare/', '/releases/tag/'),
  ]) {
    assert.throws(() => changelogEntry(value, repository, tag));
  }
  assert.throws(() => validateIdentity({ ...identity, tag: 'main' }));
  assert.throws(() => validateIdentity({ ...identity, sha: '--flag' }));
});

test('all comparison pages are required; previous boundary is exclusive', () => {
  const commits = Array.from({ length: 251 }, (_, i) =>
    commit((i + 1).toString(16).padStart(40, '0')),
  );
  commits[250] = commit(head);
  const pages = [
    comparison(commits.slice(0, 100), 251),
    comparison(commits.slice(100, 200), 251),
    comparison(commits.slice(200), 251),
  ];
  assert.equal(compareCommits(pages, base, head).length, 251);
  assert.throws(() => compareCommits(pages.slice(0, 2), base, head), /Incomplete/);
  assert.throws(
    () => compareCommits([comparison([commit(head), commit(head)])], base, head),
    /Duplicate/,
  );
  assert.throws(
    () => compareCommits([comparison([commit(base), commit(head)])], base, head),
    /exclusive/,
  );
  assert.throws(
    () => compareCommits([comparison([commit(middle)])], base, head),
    /requested release/,
  );
  assert.throws(
    () => compareCommits([{ ...pages[0], status: 'diverged' }], base, head),
    /ancestor/,
  );
  assert.throws(
    () => compareCommits([{ ...pages[0], merge_base_commit: { sha: middle } }], base, head),
    /Diverged/,
  );
  assert.throws(
    () => compareCommits([pages[0], { ...pages[1], total_commits: 252 }], base, head),
    /changed/,
  );
});

test('deduplicates multi-commit associations, includes merged PRs, and preserves direct commits', () => {
  const commits = [commit(middle), commit(head)];
  const result = auditPullRequests(
    commits,
    {
      [middle]: [pull(1), pull(1), pull(2, middle)],
      [head]: [pull(1), pull(3, head, { merged_at: null }), pull(4, base)],
    },
    repository,
  );
  assert.deepEqual(
    result.pullRequests.map((pr) => pr.number),
    [1, 2],
  );
  assert.deepEqual(result.directCommits, []);
  assert.deepEqual(
    auditPullRequests(commits, { [middle]: [], [head]: [pull(1)] }, repository).directCommits,
    [commits[0]],
  );
  assert.throws(() => auditPullRequests(commits, { [head]: [] }, repository), /Missing PR lookup/);
  assert.throws(
    () =>
      auditPullRequests(
        commits,
        {
          [middle]: [pull(1, middle)],
          [head]: [pull(1, head)],
        },
        repository,
      ),
    /Conflicting/,
  );
});

test('fails closed on missing, extra, duplicate native PRs, wrong comparisons and native errors', () => {
  for (const numbers of [[], [2], [1, 2], [1, 1]]) {
    assert.throws(() => composeReleaseNotes(plan(), native(numbers)), /missing or extra|duplicate/);
  }
  assert.throws(
    () => composeReleaseNotes(plan(), { body: native().body.replace('...v2.0.0', '...v2.0.01') }),
    /range does not match/,
  );
  assert.throws(() => composeReleaseNotes(plan(), { message: 'API unavailable' }), /no Markdown/);
  assert.throws(
    () => composeReleaseNotes(plan(), { body: native().body.replace('/pull/1', '/pull/1?bad') }),
    /Unrecognized/,
  );
  assert.throws(
    () => composeReleaseNotes(plan(), native([1], 'x'.repeat(125_000) + '\n')),
    /body size/,
  );
});

test('contributor attribution is not a duplicate; release-only PRs are not silently excluded', () => {
  const attribution =
    `## New Contributors\n* @author made their first contribution in ` +
    `https://github.com/${repository}/pull/1\n\n`;
  assert.doesNotThrow(() => composeReleaseNotes(plan(), native([1], attribution)));
  const releasePr = pull(2, head, {
    title: 'chore(main): release 2.0.0',
    labels: [{ name: 'autorelease: tagged' }],
  });
  assert.throws(
    () => composeReleaseNotes(plan([pull(1, middle), releasePr]), native()),
    /missing or extra/,
  );
  const result = composeReleaseNotes(plan([pull(1, middle), releasePr]), native([1, 2]));
  assert.equal(result.manifest.pullRequests.length, 2);
});

test('direct changes retain commit links without a manual changelog', () => {
  const direct = commit(middle, 'ci: check <details> & tools\n\nOther text');
  const result = composeReleaseNotes(plan([], [direct]), native([]));
  assert.ok(result.body.includes('Commits without a merged pull request'));
  assert.ok(result.body.includes('&#60;details&#62; &#38;'));
  assert.deepEqual(result.manifest.directCommits, [middle]);
});

function fakeReader({ anchor = base, status = 'identical', associations = [[pull(1)]] } = {}) {
  const encoded = (text) => ({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
  const config = { 'last-release-sha': anchor, packages: { '.': { 'release-type': 'node' } } };
  const requests = [];
  const routes = {
    [`commits/${tag}`]: { sha: head },
    [`commits/${previousTag}`]: { sha: base },
    [`contents/CHANGELOG.md?ref=${head}`]: encoded(userNotes),
    [`contents/release-please-config.json?ref=${head}`]: encoded(JSON.stringify(config)),
    [`contents/.github/release.yml?ref=${head}`]: encoded('changelog: {}'),
    [`compare/${base}...${head}?per_page=100`]: [comparison([commit(head)])],
    [`compare/${anchor}...${base}?per_page=1`]: { status, merge_base_commit: { sha: anchor } },
    [`commits/${head}/pulls?per_page=100`]: associations,
    ['pulls?state=closed&sort=created&direction=asc&per_page=100']: associations,
  };
  const read = async (path, paginate) => {
    requests.push({ path, paginate });
    assert.ok(Object.hasOwn(routes, path), `Unexpected API request: ${path}`);
    return structuredClone(routes[path]);
  };
  return { read, routes, requests };
}

test('preparation uses exact file SHAs, paginated endpoints and recorded previous tag', async () => {
  const { read, requests } = fakeReader({ associations: [[pull(1)], [pull(2)]] });
  const prepared = await prepareReleaseNotes(identity, read, producer);
  assert.deepEqual(
    prepared.pullRequests.map((pr) => pr.number),
    [1, 2],
  );
  assert.equal(prepared.previousSha, base);
  assert.equal(prepared.userNotes, userNotes);
  assert.equal(requests.filter((request) => request.paginate).length, 3);
  assert.ok(requests.every((request) => !request.path.includes('latest')));
});

test('anchor override, missing config, tag drift and API failures prevent completion', async () => {
  const truncated = fakeReader({ anchor: middle, status: 'behind' });
  await assert.rejects(
    prepareReleaseNotes(identity, truncated.read, producer),
    /must not truncate/,
  );
  const moved = fakeReader();
  moved.routes[`commits/${tag}`].sha = middle;
  await assert.rejects(prepareReleaseNotes(identity, moved.read, producer), /moved/);
  await assert.rejects(verifyTags(moved.read, plan()), /moved/);
  const noConfig = fakeReader();
  delete noConfig.routes[`contents/.github/release.yml?ref=${head}`];
  await assert.rejects(prepareReleaseNotes(identity, noConfig.read, producer), /Unexpected API/);
  await assert.rejects(
    prepareReleaseNotes(
      identity,
      async () => {
        throw new Error('rate limited');
      },
      producer,
    ),
    /rate limited/,
  );
});

test('API adapter performs GETs and explicitly requests all pages', async () => {
  let call;
  const read = githubReader(repository, async (command, args) => {
    call = { command, args };
    return { stdout: '[[{"number":1}],[{"number":2}]]' };
  });
  assert.equal((await read('commits/abc/pulls?per_page=100', true)).length, 2);
  assert.deepEqual(call, {
    command: 'gh',
    args: [
      'api',
      '--method',
      'GET',
      '--paginate',
      '--slurp',
      `repos/${repository}/commits/abc/pulls?per_page=100`,
    ],
  });
});

test('workflow cannot publish, mutate tags or run project code with a write token', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-notes.yml', import.meta.url),
    'utf8',
  );
  const nativeJob = workflow.split('\n  native:\n')[1].split('\n  compose:\n')[0];
  assert.ok(nativeJob.includes('contents: write'));
  assert.ok(nativeJob.includes('/releases/generate-notes'));
  assert.ok(
    !/actions\/checkout|node scripts\/|npm |gh release|release.*edit|PATCH|DELETE/.test(nativeJob),
  );
  assert.equal(workflow.match(/contents: write/g).length, 1);
  assert.ok(!workflow.includes('release-assets'));
  assert.ok(!workflow.includes('draft=false'));
  assert.ok(workflow.includes('artifact-id'));
  assert.ok(workflow.includes('artifact-digest'));
});

test('config hides ordinary maintenance from user notes but includes every PR in native notes', async () => {
  const config = JSON.parse(
    await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
  );
  const sections = config.packages['.']['changelog-sections'];
  assert.deepEqual(
    sections.filter((section) => !section.hidden).map((section) => section.type),
    ['feat', 'fix', 'perf', 'revert'],
  );
  assert.equal(config['last-release-sha'], '4fa60de8f36ed7d44a463959226b275c61189208');
  assert.equal(config['bootstrap-sha'], 'fa85190d2f4ad31453c32e90cff0b76ae432526a');
  const nativeConfig = await readFile(new URL('../.github/release.yml', import.meta.url), 'utf8');
  assert.ok(nativeConfig.includes("labels: ['*']"));
  assert.ok(nativeConfig.includes('Release preparation'));
  assert.ok(!/^\s*exclude:/m.test(nativeConfig));
});

test('independent closed-PR inventory catches missing associations and pagination duplicates', () => {
  const commits = [commit(head)];
  assert.doesNotThrow(() =>
    verifyPullRequestInventory(
      commits,
      [pull(1), pull(2)],
      [[pull(1)], [pull(2), pull(3, base), pull(4, head, { merged_at: null })]],
      repository,
    ),
  );
  assert.throws(
    () => verifyPullRequestInventory(commits, [], [[pull(1)]], repository),
    /omit or add/,
  );
  assert.throws(
    () => verifyPullRequestInventory(commits, [pull(1)], [[pull(1)], [pull(1)]], repository),
    /changed during pagination/,
  );
});

test('migration headings are retained, and changed native metadata invalidates the content hash', () => {
  const migration = `${userNotes}\n\n## Migration example\n\nKeep this complete explanation.`;
  assert.equal(changelogEntry(migration, repository, tag).userNotes, migration);
  const first = composeReleaseNotes(plan(), native());
  const changed = composeReleaseNotes(plan(), {
    ...native(),
    body: native().body.replace('Change 1', 'Revised title'),
  });
  assert.notEqual(first.manifest.bodySha256, changed.manifest.bodySha256);
  assert.notEqual(first.manifest.nativeNotesSha256, changed.manifest.nativeNotesSha256);
  assert.equal(first.manifest.userNotesSha256, changed.manifest.userNotesSha256);
});

test('Release Please search-depth truncation and inherited history filters require review', async () => {
  for (const override of [
    { 'commit-search-depth': -1 },
    { 'exclude-paths': ['scripts'] },
    { 'changelog-type': 'github' },
    { plugins: ['custom'] },
  ]) {
    const mock = fakeReader();
    const path = `contents/release-please-config.json?ref=${head}`;
    const config = JSON.parse(Buffer.from(mock.routes[path].content, 'base64').toString());
    mock.routes[path].content = Buffer.from(JSON.stringify({ ...config, ...override })).toString(
      'base64',
    );
    await assert.rejects(prepareReleaseNotes(identity, mock.read, producer));
  }
  const mock = fakeReader();
  const path = `contents/release-please-config.json?ref=${head}`;
  const config = JSON.parse(Buffer.from(mock.routes[path].content, 'base64').toString());
  mock.routes[path].content = Buffer.from(
    JSON.stringify({ ...config, 'commit-search-depth': 1 }),
  ).toString('base64');
  mock.routes[`compare/${base}...${head}?per_page=100`] = [
    comparison([commit(middle), commit(head)]),
  ];
  await assert.rejects(prepareReleaseNotes(identity, mock.read, producer), /search depth/);
});
