import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMain, runFile } from './release-utils.mjs';
import {
  auditPullRequests,
  changelogEntry,
  compareCommits,
  composeReleaseNotes,
  shaPattern,
  validateIdentity,
  verifyPullRequestInventory,
} from './release-notes-core.mjs';

export function githubReader(repository, run = runFile) {
  return async (path, paginated = false) => {
    const args = ['api', '--method', 'GET'];
    if (paginated) args.push('--paginate', '--slurp');
    args.push(`repos/${repository}/${path}`);
    const result = await run('gh', args);
    return JSON.parse(result.stdout);
  };
}

async function readRepositoryFile(read, path, sha) {
  const file = await read(`contents/${path}?ref=${sha}`);
  assert.equal(file.encoding, 'base64');
  assert.equal(typeof file.content, 'string');
  return Buffer.from(file.content, 'base64').toString('utf8');
}

async function verifyReleasePleaseBoundary(read, config, previousSha, commitCount) {
  assert.deepEqual(Object.keys(config.packages ?? {}), ['.'], 'Only the root package is supported');
  const root = config.packages?.['.'];
  const setting = (key, fallback) => root[key] ?? config[key] ?? fallback;
  assert.equal(setting('release-type'), 'node');
  assert.equal(
    setting('changelog-type', 'default'),
    'default',
    'Keep Release Please as the user-facing generator',
  );
  assert.equal(setting('changelog-path', 'CHANGELOG.md'), 'CHANGELOG.md');
  assert.ok(!setting('exclude-paths', []).length, 'Excluded paths require a new boundary review');
  assert.ok(!config.plugins?.length, 'Release Please plugins require a new boundary review');
  const depth = config['commit-search-depth'] || 500; // Pinned Release Please 17.6.0 default.
  assert.ok(Number.isSafeInteger(depth) && depth > 0);
  assert.ok(commitCount <= depth, 'Range exceeds the Release Please commit search depth');
  const anchor = config['last-release-sha'];
  if (!anchor) return;
  assert.match(anchor, shaPattern);
  const comparison = await read(`compare/${anchor}...${previousSha}?per_page=1`);
  assert.ok(
    ['ahead', 'identical'].includes(comparison.status),
    'Release Please anchor must not truncate this range',
  );
  assert.equal(
    comparison.merge_base_commit.sha,
    anchor,
    'Release Please anchor is on a different lineage',
  );
}

export async function prepareReleaseNotes(identity, read, producer) {
  validateIdentity(identity);
  const { repository, tag, sha } = identity;
  assert.equal((await read(`commits/${tag}`)).sha, sha, 'Release tag moved or input SHA is wrong');
  const changelog = await readRepositoryFile(read, 'CHANGELOG.md', sha);
  const { userNotes, previousTag } = changelogEntry(changelog, repository, tag);
  const previousSha = (await read(`commits/${previousTag}`)).sha;
  assert.match(previousSha, shaPattern);
  const pages = await read(`compare/${previousSha}...${sha}?per_page=100`, true);
  const commits = compareCommits(pages, previousSha, sha);
  const config = JSON.parse(await readRepositoryFile(read, 'release-please-config.json', sha));
  await verifyReleasePleaseBoundary(read, config, previousSha, commits.length);
  // The native API uses this repository path. Require it at the release source.
  await readRepositoryFile(read, '.github/release.yml', sha);
  const associations = {};
  for (const commit of commits) {
    const prPages = await read(`commits/${commit.sha}/pulls?per_page=100`, true);
    assert.ok(
      Array.isArray(prPages) && prPages.every(Array.isArray),
      'Invalid paginated PR response',
    );
    associations[commit.sha] = prPages.flat();
  }
  const audit = auditPullRequests(commits, associations, repository);
  const closed = await read('pulls?state=closed&sort=created&direction=asc&per_page=100', true);
  verifyPullRequestInventory(commits, audit.pullRequests, closed, repository);
  return { ...identity, previousTag, previousSha, userNotes, ...audit, producer };
}

export async function verifyTags(read, plan) {
  assert.equal(
    (await read(`commits/${plan.tag}`)).sha,
    plan.sha,
    'Release tag moved during generation',
  );
  assert.equal(
    (await read(`commits/${plan.previousTag}`)).sha,
    plan.previousSha,
    'Previous tag moved during generation',
  );
}

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function planCommand() {
  const identity = {
    repository: process.env.GH_REPO,
    tag: process.env.RELEASE_TAG,
    sha: process.env.RELEASE_SHA,
  };
  assert.equal(process.env.GITHUB_SHA, identity.sha, 'Prepare notes from the exact tagged source');
  assert.equal(
    process.env.GITHUB_REF,
    `refs/tags/${identity.tag}`,
    'Invoke preparation at the release tag',
  );
  const producer = {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowSha: process.env.GITHUB_SHA,
  };
  const plan = await prepareReleaseNotes(identity, githubReader(identity.repository), producer);
  await mkdir('.release-notes-input', { recursive: true });
  await writeFile('.release-notes-input/plan.json', `${JSON.stringify(plan, null, 2)}\n`);
  await output('previous_tag', plan.previousTag);
  await output('previous_sha', plan.previousSha);
}

async function composeCommand() {
  const plan = JSON.parse(await readFile('.release-notes-input/plan.json', 'utf8'));
  const native = JSON.parse(await readFile('.release-notes-native/native.json', 'utf8'));
  assert.equal(plan.repository, process.env.GH_REPO);
  assert.equal(plan.sha, process.env.GITHUB_SHA);
  assert.equal(plan.tag, process.env.RELEASE_TAG);
  assert.equal(plan.producer.runId, process.env.GITHUB_RUN_ID);
  assert.equal(
    plan.producer.runAttempt,
    process.env.GITHUB_RUN_ATTEMPT,
    'Rerun all jobs for one consistent attempt',
  );
  await verifyTags(githubReader(plan.repository), plan);
  const { body, manifest } = composeReleaseNotes(plan, native);
  const directory = '.release-notes';
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'body.md'), body);
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await output('body_sha256', manifest.bodySha256);
}

if (isMain(import.meta.url)) {
  const commands = { plan: planCommand, compose: composeCommand };
  const command = commands[process.argv[2]];
  assert.equal(typeof command, 'function', 'Usage: node scripts/release-notes.mjs plan|compose');
  await command();
}
