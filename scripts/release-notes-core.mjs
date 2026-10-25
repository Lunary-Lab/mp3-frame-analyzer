import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const shaPattern = /^[0-9a-f]{40}$/;
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export function validateIdentity({ repository, tag, sha }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(tag, tagPattern);
  assert.match(sha, shaPattern);
}

export function changelogEntry(changelog, repository, tag) {
  const entries = changelog.split(/(?=^## \[\d+\.\d+\.\d+\]\()/m);
  const matches = entries.filter((entry) => entry.startsWith(`## [${tag.slice(1)}](`));
  assert.equal(matches.length, 1, 'Expected exactly one Release Please entry for this version');
  const notes = matches[0].trim();
  const header = notes.split('\n')[0];
  const prefix = `## [${tag.slice(1)}](https://github.com/${repository}/compare/`;
  assert.ok(header.startsWith(prefix), 'Release notes require an explicit previous release tag');
  const range = header.slice(prefix.length).split(')')[0].split('...');
  assert.equal(range.length, 2);
  assert.match(range[0], tagPattern);
  assert.equal(range[1], tag, 'Changelog comparison must end at the requested release');
  assert.notEqual(range[0], tag);
  return { userNotes: notes, previousTag: range[0] };
}

export function compareCommits(pages, previousSha, sha) {
  assert.ok(Array.isArray(pages) && pages.length > 0, 'Comparison pages are missing');
  const first = pages[0];
  assert.equal(first.status, 'ahead', 'Previous release must be an ancestor of the release');
  assert.equal(first.base_commit.sha, previousSha);
  assert.equal(
    first.merge_base_commit.sha,
    previousSha,
    'Diverged histories are not a release range',
  );
  assert.ok(Number.isSafeInteger(first.total_commits) && first.total_commits > 0);
  const commits = pages.flatMap((page) => {
    assert.equal(page.total_commits, first.total_commits, 'Comparison changed during pagination');
    assert.equal(page.status, first.status);
    assert.ok(Array.isArray(page.commits));
    return page.commits;
  });
  const shas = commits.map((commit) => {
    assert.match(commit.sha, shaPattern);
    assert.equal(typeof commit.commit.message, 'string');
    return commit.sha;
  });
  assert.equal(new Set(shas).size, shas.length, 'Duplicate comparison commits');
  assert.equal(shas.length, first.total_commits, 'Incomplete paginated comparison');
  assert.ok(shas.includes(sha), 'Comparison does not contain the requested release commit');
  assert.ok(!shas.includes(previousSha), 'Previous release is an exclusive boundary');
  return commits;
}

export function auditPullRequests(commits, associations, repository) {
  const shas = new Set(commits.map((commit) => commit.sha));
  const pullRequests = new Map();
  const directCommits = [];
  for (const commit of commits) {
    const candidates = associations[commit.sha];
    assert.ok(Array.isArray(candidates), `Missing PR lookup for ${commit.sha}`);
    const merged = candidates.filter((pr) => pr.merged_at && pr.base.repo.full_name === repository);
    const included = merged.filter((pr) => shas.has(pr.merge_commit_sha));
    if (included.length === 0) {
      directCommits.push({
        sha: commit.sha,
        commit: { message: commit.commit.message.split('\n')[0] },
      });
    }
    for (const pr of included) {
      assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0);
      assert.match(pr.merge_commit_sha, shaPattern);
      const previous = pullRequests.get(pr.number);
      if (previous)
        assert.equal(previous.merge_commit_sha, pr.merge_commit_sha, 'Conflicting PR identities');
      pullRequests.set(pr.number, { number: pr.number, merge_commit_sha: pr.merge_commit_sha });
    }
  }
  return {
    pullRequests: [...pullRequests.values()].sort((a, b) => a.number - b.number),
    directCommits,
  };
}

export function verifyPullRequestInventory(commits, pullRequests, pages, repository) {
  assert.ok(Array.isArray(pages) && pages.every(Array.isArray), 'Invalid closed-PR pagination');
  const shas = new Set(commits.map((commit) => commit.sha));
  const expected = pages
    .flat()
    .filter(
      (pr) =>
        pr.merged_at && pr.base.repo.full_name === repository && shas.has(pr.merge_commit_sha),
    );
  const numbers = expected.map((pr) => pr.number).sort((a, b) => a - b);
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    'Closed PR inventory changed during pagination',
  );
  assert.deepEqual(
    pullRequests.map((pr) => pr.number),
    numbers,
    'Commit associations omit or add merged PRs',
  );
}

function nativeEntries(body, repository) {
  // New-contributor bullets can repeat a PR URL; they are attribution, not changes.
  const changes = body.split(/^## New Contributors\s*$/m)[0];
  const suffix = ` in https://github.com/${repository}/pull/`;
  return changes.split('\n').flatMap((line) => {
    if (!/^[-*] /.test(line) || !line.includes(suffix)) return [];
    const number = line.slice(line.lastIndexOf(suffix) + suffix.length).trim();
    assert.match(number, /^[1-9]\d*$/, 'Unrecognized native PR entry; review the generator format');
    return [{ line, number: Number(number) }];
  });
}

export function engineeringNotes(plan, native) {
  assert.equal(typeof native.body, 'string', 'Native generation returned no Markdown body');
  const entries = nativeEntries(native.body, plan.repository);
  const numbers = entries.map((entry) => entry.number);
  assert.equal(new Set(numbers).size, numbers.length, 'Native notes contain duplicate PR entries');
  const expected = plan.pullRequests.map((pr) => pr.number).sort((a, b) => a - b);
  assert.deepEqual(
    [...numbers].sort((a, b) => a - b),
    expected,
    'Native notes have missing or extra PRs',
  );
  const compare = `https://github.com/${plan.repository}/compare/${plan.previousTag}...${plan.tag}`;
  const fullComparison = native.body
    .split('\n')
    .find((line) => line.startsWith('**Full Changelog**: '));
  assert.equal(
    fullComparison?.trim(),
    `**Full Changelog**: ${compare}`,
    'Native release range does not match',
  );
  let body = native.body.trim();
  for (const { line, number } of entries) {
    const pr = plan.pullRequests.find((candidate) => candidate.number === number);
    const url = `https://github.com/${plan.repository}/commit/${pr.merge_commit_sha}`;
    body = body.replace(line, `${line} ([commit](${url}))`);
  }
  if (plan.directCommits.length) {
    const direct = plan.directCommits.map((commit) => {
      const title = commit.commit.message
        .split('\n')[0]
        .replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
      const url = `https://github.com/${plan.repository}/commit/${commit.sha}`;
      return `- ${title} ([${commit.sha.slice(0, 7)}](${url}))`;
    });
    body += `\n\n## Commits without a merged pull request\n\n${direct.join('\n')}`;
  }
  const immutable = `https://github.com/${plan.repository}/compare/${plan.previousSha}...${plan.sha}`;
  return `${body}\n\n[Exact commit comparison](${immutable})`;
}

export function composeReleaseNotes(plan, native) {
  validateIdentity(plan);
  assert.match(plan.previousSha, shaPattern);
  assert.match(plan.previousTag, tagPattern);
  assert.equal(
    changelogEntry(plan.userNotes, plan.repository, plan.tag).previousTag,
    plan.previousTag,
  );
  const engineering = engineeringNotes(plan, native);
  const count = plan.pullRequests.length;
  const body =
    `${plan.userNotes}\n\n## Engineering changes\n\n<details>\n` +
    `<summary>All ${count} merged pull requests and additional commits</summary>\n\n${engineering}\n\n</details>\n`;
  // GitHub release bodies have a size limit; never silently truncate the complete view.
  assert.ok(
    Buffer.byteLength(body, 'utf8') <= 125_000,
    'Combined release notes exceed the supported body size',
  );
  const manifest = {
    schemaVersion: 1,
    repository: plan.repository,
    tag: plan.tag,
    sha: plan.sha,
    previousTag: plan.previousTag,
    previousSha: plan.previousSha,
    pullRequests: plan.pullRequests.map((pr) => ({ number: pr.number, sha: pr.merge_commit_sha })),
    directCommits: plan.directCommits.map((commit) => commit.sha),
    userNotesSha256: digest(plan.userNotes),
    nativeNotesSha256: digest(native.body),
    bodySha256: digest(body),
    producer: plan.producer,
  };
  return { body, manifest };
}
