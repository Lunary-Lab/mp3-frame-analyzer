import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

const workflow = async (name) =>
  parseDocument(
    await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'),
  ).toJS();
const release = await workflow('release-please');
const repo = 'example/project';
const branch = 'release-please--branches--main--components--mp3-frame-analyzer';
const head = 'a'.repeat(40);
const output = [{ number: 15, baseBranchName: 'main', headBranchName: branch }];
const metadata = () => ({
  number: 15,
  state: 'open',
  base: { ref: 'main' },
  head: { ref: branch, sha: head, repo: { full_name: repo } },
});

test('generated release PRs report native event admission without redundant dispatch or approval', () => {
  const job = release.jobs['release-pr-status'];
  assert.ok(job, 'Release PRs need a read-only status summary, not ineligible dispatched checks');
  assert.deepEqual(job.permissions, { 'pull-requests': 'read' });
  assert.equal(job.needs, 'version');
  assert.equal(job.if, "needs.version.outputs.prs_created == 'true'");
  const source = JSON.stringify(job);
  assert.doesNotMatch(source, /checkout@|\/approve|update-branch|PATCH/);
  assert.equal(job.steps.length, 1);
  assert.ok(job.steps[0].run);
  assert.deepEqual(job.steps[0].env, {
    GH_TOKEN: '${{ github.token }}',
    GH_REPO: '${{ github.repository }}',
    RELEASE_PRS: '${{ needs.version.outputs.prs }}',
  });
  assert.equal(release.jobs['check-release-pr'], undefined);
});

test('PR admission remains native and read-only while exact-tag publication remains dispatched', async () => {
  const ci = await workflow('ci');
  const title = await workflow('pr-title');
  const publisher = await workflow('publish-release');
  assert.ok(Object.hasOwn(ci.on, 'pull_request'));
  assert.deepEqual(title.on.pull_request_target.types, [
    'opened',
    'edited',
    'reopened',
    'synchronize',
  ]);
  assert.deepEqual(title.permissions, { 'pull-requests': 'read' });
  assert.doesNotMatch(JSON.stringify(title), /checkout@/);
  assert.equal(release.jobs.release.if, "needs.version.outputs.release_created == 'true'");
  assert.deepEqual(release.jobs.release.permissions, { contents: 'read', actions: 'write' });
  assert.match(release.jobs.release.steps[0].run, /'publish-release\.yml'.*'--ref', tag/);
  assert.match(release.jobs.release.steps[0].run, /`sha=\$\{sha\}`/);
  assert.equal(publisher.jobs.publish.environment.name, 'release');
});

async function runSummary(prs, pr = metadata(), status = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'release-pr-summary-'));
  try {
    const script = release.jobs['release-pr-status']?.steps[0]?.run;
    assert.ok(script, 'Missing executable native workflow summary');
    const log = join(directory, 'calls.jsonl');
    const summary = join(directory, 'summary.md');
    const shim =
      `#!${process.execPath}\n` +
      "const fs = require('node:fs');\n" +
      "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n" +
      'process.stdout.write(process.env.API_RESULT);\n' +
      'process.exit(Number(process.env.API_STATUS));\n';
    await writeFile(join(directory, 'gh'), shim, { mode: 0o700 });
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
      {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          GH_REPO: repo,
          RELEASE_PRS: JSON.stringify(prs),
          GITHUB_STEP_SUMMARY: summary,
          CALL_LOG: log,
          API_RESULT: JSON.stringify(pr),
          API_STATUS: String(status),
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    const optional = async (path) => readFile(path, 'utf8').catch(() => '');
    return { ...result, calls: await optional(log), summary: await optional(summary) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the actual shell summary reads only the expected PR and identifies the exact head and next step', async () => {
  const result = await runSummary(output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls, `${JSON.stringify(['api', `repos/${repo}/pulls/15`])}\n`);
  assert.match(result.summary, /https:\/\/github\.com\/example\/project\/pull\/15/);
  assert.ok(result.summary.includes(head));
  assert.match(result.summary, /close and reopen/);
  assert.match(result.summary, /All checks/);
  assert.match(result.summary, /Conventional Commit PR title/);
  assert.match(result.summary, /does not merge or publish/);
});

test('native summary fails closed for malformed or unexpected generated PR outputs', async () => {
  for (const prs of [
    null,
    {},
    [],
    [{ ...output[0], number: '15' }],
    [{ ...output[0], number: 0 }],
    [{ ...output[0], baseBranchName: 'other' }],
    [{ ...output[0], headBranchName: 'feature' }],
  ]) {
    const result = await runSummary(prs);
    assert.notEqual(result.status, 0, JSON.stringify(prs));
    assert.equal(result.calls, '');
    assert.equal(result.summary, '');
  }
});

test('native summary rejects stale, foreign, closed, ambiguous or failed API metadata', async () => {
  const invalid = [
    { ...metadata(), number: 16 },
    { ...metadata(), state: 'closed' },
    { ...metadata(), base: { ref: 'other' } },
    { ...metadata(), head: { ...metadata().head, ref: 'feature' } },
    { ...metadata(), head: { ...metadata().head, sha: 'short' } },
    { ...metadata(), head: { ...metadata().head, repo: { full_name: 'foreign/project' } } },
  ];
  for (const pr of invalid) {
    const result = await runSummary(output, pr);
    assert.notEqual(result.status, 0);
    assert.equal(result.summary, '');
  }
  const failure = await runSummary(output, metadata(), 1);
  assert.notEqual(failure.status, 0);
  assert.equal(failure.summary, '');
});
