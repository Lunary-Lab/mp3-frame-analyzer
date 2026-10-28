import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const title = parse(
  await readFile(new URL('../.github/workflows/pr-title.yml', import.meta.url), 'utf8'),
);
const step = title.jobs.title.steps.find(
  (item) => item.if === "github.event_name == 'merge_group'",
);
const source = step.run.match(/<<'JS'\n([\s\S]+)\nJS\n?$/)[1].replace(/^import .+;\n/gm, '');
const repo = 'example/project';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const event = () => ({
  action: 'checks_requested',
  repository: { full_name: repo },
  merge_group: { base_ref: 'refs/heads/main', head_sha: head, base_sha: base },
});
const candidate = () => ({
  number: 15,
  title: 'chore(main): release 2.2.1',
  state: 'OPEN',
  baseRefName: 'main',
  headRefOid: 'c'.repeat(40),
  repository: { nameWithOwner: repo },
  mergeQueueEntry: {
    headCommit: { oid: head },
    baseCommit: { oid: base },
  },
});
const page = (nodes) => ({ data: { repository: { pullRequests: { nodes } } } });

function run({
  payload = event(),
  pages = [page([candidate()])],
  sha = head,
  apiError = false,
} = {}) {
  const calls = [];
  runInNewContext(source, {
    assert,
    process: { env: { GH_REPO: repo, GITHUB_SHA: sha, GITHUB_EVENT_PATH: 'event.json' } },
    readFileSync: (path) => {
      assert.equal(path, 'event.json');
      return JSON.stringify(payload);
    },
    execFileSync: (command, args) => {
      calls.push([command, ...args]);
      if (apiError) throw new Error('API unavailable');
      return JSON.stringify(pages);
    },
  });
  return calls;
}

test('queue title check uses live candidate metadata without executing PR code or assuming a PR event', () => {
  assert.deepEqual(title.on.merge_group, { types: ['checks_requested'] });
  assert.deepEqual(title.permissions, { 'pull-requests': 'read' });
  assert.doesNotMatch(JSON.stringify(title), /checkout@|:write|update-branch/);
  assert.equal(title.jobs.title.steps[0].if, "github.event_name == 'pull_request_target'");
  const [call] = run();
  assert.equal(call[0], 'gh');
  assert.ok(call.includes('--paginate') && call.includes('--slurp'));
  assert.ok(call.some((arg) => arg.includes('$endCursor') && arg.includes('after:$endCursor')));
  assert.ok(call.some((arg) => arg.includes('pageInfo { hasNextPage endCursor }')));
  assert.ok(call.some((arg) => arg.includes('pullRequests(states:OPEN,baseRefName:"main"')));
  assert.ok(call.some((arg) => arg.includes('mergeQueueEntry { headCommit { oid }')));
  assert.ok(call.every((arg) => !arg.includes('mergeQueue(')));
});

test('later main activity and unrelated queue entries do not substitute for the exact candidate', () => {
  const unrelated = candidate();
  unrelated.mergeQueueEntry.headCommit.oid = 'd'.repeat(40);
  unrelated.title = 'invalid unrelated title';
  const unqueued = { ...candidate(), mergeQueueEntry: null };
  assert.equal(run({ pages: [page([unrelated, unqueued]), page([candidate()])] }).length, 1);
  assert.throws(() => run({ pages: [page([unrelated])] }), /current queue candidate/);
});

test('missing, duplicate, superseded, malformed and unavailable queue candidates fail closed', () => {
  for (const pages of [
    [],
    {},
    [page([])],
    [page([candidate(), candidate()])],
    [{ data: { repository: { pullRequests: null } } }],
    [{ ...page([candidate()]), errors: [{ message: 'incomplete query' }] }],
  ])
    assert.throws(() => run({ pages }));
  assert.throws(() => run({ apiError: true }), /API unavailable/);
  for (const modify of [
    (value) => {
      value.mergeQueueEntry.baseCommit.oid = 'd'.repeat(40);
    },
    (value) => {
      value.mergeQueueEntry.headCommit = null;
    },
    (value) => {
      value.mergeQueueEntry = null;
    },
    (value) => {
      value.state = 'CLOSED';
    },
    (value) => {
      value.baseRefName = 'other';
    },
    (value) => {
      value.repository.nameWithOwner = 'other/project';
    },
    (value) => {
      value.headRefOid = 'short';
    },
    (value) => {
      value.title = 'not conventional';
    },
    (value) => {
      value.title = 'fix: valid\nspoofed';
    },
  ]) {
    const value = candidate();
    modify(value);
    assert.throws(() => run({ pages: [page([value])] }));
  }
});

test('event SHA and base remain bound even if main advances while CI runs', () => {
  assert.throws(() => run({ sha: 'd'.repeat(40) }));
  for (const modify of [
    (value) => {
      value.action = 'destroyed';
    },
    (value) => {
      value.repository.full_name = 'other/project';
    },
    (value) => {
      value.merge_group.base_ref = 'refs/heads/other';
    },
    (value) => {
      value.merge_group.base_sha = 'short';
    },
  ]) {
    const payload = event();
    modify(payload);
    assert.throws(() => run({ payload }));
  }
});
