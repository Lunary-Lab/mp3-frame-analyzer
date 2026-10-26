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
const identity = { repository, repositoryId: '12345', tag, sha: head };
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
    '': { full_name: repository, id: 12345 },
    'git/matching-refs/tags/?per_page=100': [
      [{ ref: `refs/tags/${previousTag}` }, { ref: `refs/tags/${tag}` }],
    ],
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
  assert.equal(requests.filter((request) => request.paginate).length, 4);
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
  // Anchors are repository state, not a changelog-type invariant.
  for (const key of ['last-release-sha', 'bootstrap-sha']) {
    if (config[key] !== undefined) assert.match(config[key], /^[0-9a-f]{40}$/);
  }
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

test('native PR titles are literal data, including every replacement-string metacharacter', () => {
  for (const title of [
    'Literal $& token',
    "Literal $' token",
    'Literal $` token',
    'Literal $$ token',
  ]) {
    const source = native([1, 2]);
    source.body = source.body.replace('Change 1', () => title);
    const original = source.body;
    const result = composeReleaseNotes(plan([pull(1, middle), pull(2, head)]), source);
    const line = `* ${title} by @author in https://github.com/${repository}/pull/1`;
    assert.ok(
      result.body.includes(`${line} ([commit](https://github.com/${repository}/commit/${middle}))`),
      `Title was not preserved literally: ${title}`,
    );
    for (const number of [1, 2]) {
      assert.equal(
        result.body.split(`https://github.com/${repository}/pull/${number}`).length - 1,
        1,
        `PR ${number} was duplicated by title interpolation`,
      );
    }
    assert.equal(result.body.split('**Full Changelog**:').length - 1, 1);
    assert.equal(source.body, original, 'Composition mutated the native input');
  }
});

test('plain historical version headings delimit one entry without swallowing old releases', () => {
  const historical = '\n\n## 1.2.0 (2026-10-24)\n\nDo not repeat.\n\n## 1.1.0 (2026-10-23)\nOld.';
  const migration = `${userNotes}\n\n## Migration example\n\nKeep the migration.`;
  assert.equal(
    changelogEntry(`# Changelog\n\n${migration}${historical}`, repository, tag).userNotes,
    migration,
  );
});

function initialReader() {
  const mock = fakeReader();
  const encode = (value) => ({
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
  });
  mock.routes['git/matching-refs/tags/?per_page=100'] = [[{ ref: `refs/tags/${tag}` }]];
  mock.routes['releases?per_page=100'] = [[]];
  mock.routes[`contents/.github/release-notes-initial.json?ref=${head}`] = encode({
    schemaVersion: 1,
    repositoryId: identity.repositoryId,
    baseSha: base,
    previousVersionTag: previousTag,
  });
  mock.routes[`contents/.release-please-manifest.json?ref=${base}`] = encode({
    '.': previousTag.slice(1),
  });
  return { ...mock, encode };
}

test('initial release requires a reviewed commit baseline without creating historical tags', async () => {
  const mock = initialReader();
  const prepared = await prepareReleaseNotes(identity, mock.read, producer);
  assert.equal(prepared.initialRelease, true);
  assert.equal(prepared.previousTag, null);
  assert.equal(prepared.previousSha, base);
  assert.equal(prepared.initialVersionTag, previousTag);
  assert.equal(prepared.repositoryId, identity.repositoryId);
  assert.ok(!mock.requests.some(({ path }) => path === `commits/${previousTag}`));
  await verifyTags(mock.read, prepared);
  const source = native();
  source.body = source.body.replace(
    `**Full Changelog**: ${compareUrl}`,
    `**Full Changelog**: https://github.com/${repository}/commits/${tag}`,
  );
  const result = composeReleaseNotes(prepared, source);
  assert.ok(result.body.includes(`compare/${base}...${head}`));
  assert.ok(!result.body.includes(`compare/${previousTag}...${tag}`));
  assert.ok(result.body.includes('Set `includeHeader=true` to retain the old behavior.'));
  assert.ok(result.body.includes('no earlier release tag was created'));
  assert.equal(result.manifest.previousTag, null);
  assert.equal(result.manifest.initialRelease, true);
  assert.equal(result.manifest.userNotesSha256, digest(userNotes));
  assert.equal(result.manifest.repositoryId, identity.repositoryId);
  assert.throws(() => composeReleaseNotes(prepared, native()), /initial-release range/);
  assert.throws(() => composeReleaseNotes(prepared, native([1, 2])), /missing or extra/);
});

test('missing or changed first-release initialization fails closed rather than guessing', async () => {
  for (const change of [
    (m) => delete m.routes[`contents/.github/release-notes-initial.json?ref=${head}`],
    (m) => {
      m.routes[''].id = 98765;
    },
    (m) => {
      m.routes['git/matching-refs/tags/?per_page=100'][0].push({ ref: 'refs/tags/unexpected' });
    },
    (m) => {
      m.routes['releases?per_page=100'] = [[{ tag_name: previousTag, draft: false }]];
    },
    (m) => {
      m.routes['releases?per_page=100'] = [[{ tag_name: 'v9.0.0', draft: true }]];
    },
    (m) => delete m.routes[`contents/.release-please-manifest.json?ref=${base}`],
    (m) => {
      m.routes[`compare/${base}...${head}?per_page=100`][0].status = 'diverged';
    },
  ]) {
    const mock = initialReader();
    change(mock);
    await assert.rejects(prepareReleaseNotes(identity, mock.read, producer));
  }
  for (const override of [
    { schemaVersion: 0 },
    { repositoryId: '999' },
    { baseSha: middle },
    { previousVersionTag: 'v0.1.0' },
  ]) {
    const mock = initialReader();
    const path = `contents/.github/release-notes-initial.json?ref=${head}`;
    const original = JSON.parse(Buffer.from(mock.routes[path].content, 'base64').toString());
    mock.routes[path] = mock.encode({ ...original, ...override });
    await assert.rejects(prepareReleaseNotes(identity, mock.read, producer));
  }
});

test('bootstrap must not truncate the initial baseline and no new boundary may appear', async () => {
  const mock = initialReader();
  const path = `contents/release-please-config.json?ref=${head}`;
  const config = JSON.parse(Buffer.from(mock.routes[path].content, 'base64').toString());
  mock.routes[path] = mock.encode({ ...config, 'bootstrap-sha': middle });
  mock.routes[`compare/${middle}...${base}?per_page=1`] = {
    status: 'behind',
    merge_base_commit: { sha: base },
  };
  await assert.rejects(prepareReleaseNotes(identity, mock.read, producer), /Bootstrap/);
  const valid = initialReader();
  const prepared = await prepareReleaseNotes(identity, valid.read, producer);
  valid.routes['git/matching-refs/tags/?per_page=100'][0].push({ ref: `refs/tags/${previousTag}` });
  await assert.rejects(verifyTags(valid.read, prepared), /exactly its own tag/);
});

test('duplicate linked and plain headings for the requested version fail closed', () => {
  assert.throws(
    () => changelogEntry(`${userNotes}\n\n## 2.0.0 (2026-10-25)\nDuplicate.`, repository, tag),
    /exactly one/,
  );
});

test('observed initial Release Please tag-link header requires an explicit verified baseline', async () => {
  const initialNotes = userNotes.replace(
    compareUrl,
    `https://github.com/${repository}/releases/tag/${tag}`,
  );
  assert.deepEqual(changelogEntry(initialNotes, repository, tag), {
    userNotes: initialNotes,
    previousTag: null,
  });
  const mock = initialReader();
  mock.routes[`contents/CHANGELOG.md?ref=${head}`].content =
    Buffer.from(initialNotes).toString('base64');
  const prepared = await prepareReleaseNotes(identity, mock.read, producer);
  assert.equal(prepared.initialVersionTag, previousTag);
  assert.equal(prepared.previousSha, base);
  const source = native();
  source.body = source.body.replace(`**Full Changelog**: ${compareUrl}`, '');
  const result = composeReleaseNotes(prepared, source);
  assert.ok(result.body.includes(`compare/${base}...${head}`));
  assert.equal(result.manifest.userNotesSha256, digest(initialNotes));
  delete mock.routes[`contents/.github/release-notes-initial.json?ref=${head}`];
  await assert.rejects(prepareReleaseNotes(identity, mock.read, producer));
  assert.throws(() =>
    composeReleaseNotes({ ...prepared, initialRelease: false, previousTag }, native()),
  );
  assert.throws(() =>
    changelogEntry(initialNotes.replace(`/tag/${tag}`, '/tag/v9.9.9'), repository, tag),
  );
});

test('duplicate native comparison lines cannot conceal a different release boundary', async () => {
  const duplicate = `${native().body}\n**Full Changelog**: https://github.com/${repository}/compare/v0.0.1...${tag}`;
  assert.throws(() => composeReleaseNotes(plan(), { body: duplicate }), /duplicate comparison/);
  const mock = initialReader();
  const prepared = await prepareReleaseNotes(identity, mock.read, producer);
  const initial = duplicate.replace(compareUrl, `https://github.com/${repository}/commits/${tag}`);
  assert.throws(() => composeReleaseNotes(prepared, { body: initial }), /duplicate comparison/);
});
