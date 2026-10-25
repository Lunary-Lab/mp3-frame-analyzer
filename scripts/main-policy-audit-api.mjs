import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// https://cli.github.com/manual/gh_api
// https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
// The reference endpoint caps history at 1,000 suites; enumerate suites and their runs instead.
function request(execute, path, paginate) {
  assert.match(
    path,
    /^repos\/[\w.-]+\/[\w.-]+\//,
    'Only repository metadata endpoints are accepted',
  );
  const args = ['api', '--hostname', 'github.com', '--method', 'GET'];
  args.push('-H', 'X-GitHub-Api-Version: 2022-11-28');
  if (paginate) args.push('--paginate', '--slurp');
  args.push(path);
  try {
    return JSON.parse(
      execute('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
      }),
    );
  } catch {
    // Do not print response bodies, review text, tokens or CLI environment in an audit report.
    throw new Error(`GitHub historical metadata unavailable for ${path}`);
  }
}

function flattenPages(pages, field) {
  assert.ok(Array.isArray(pages) && pages.length > 0, 'Metadata pages unavailable');
  const rows = pages.flatMap((page) => {
    const values = field ? page[field] : page;
    assert.ok(Array.isArray(values), 'Malformed metadata page');
    return values;
  });
  const identities = rows.map((row) => row.id ?? row.sha);
  assert.ok(
    identities.every((identity) => identity !== undefined),
    'Metadata identity unavailable',
  );
  assert.equal(new Set(identities).size, rows.length, 'Duplicate metadata across pages');
  const count = field === 'commits' ? 'total_commits' : 'total_count';
  for (const page of pages) {
    if (page[count] !== undefined)
      assert.equal(rows.length, page[count], 'Incomplete metadata pagination');
  }
  return rows;
}

export function createMetadataApi(execute = execFileSync) {
  return {
    get: (path) => request(execute, path, false),
    list(path, field) {
      const separator = path.includes('?') ? '&' : '?';
      const pages = request(execute, `${path}${separator}per_page=100`, true);
      return flattenPages(pages, field);
    },
  };
}

export function collectChecks(api, repo, head) {
  const prefix = `repos/${repo}`;
  const suites = api.list(`${prefix}/commits/${head}/check-suites`, 'check_suites');
  return suites.flatMap((suite) => {
    const path = `${prefix}/check-suites/${suite.id}/check-runs?filter=all`;
    const runs = api.list(path, 'check_runs');
    const counts = new Map();
    for (const run of runs) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
    assert.ok(
      [...counts.values()].every((count) => count < 1000),
      'Check history may exceed GitHub retention',
    );
    return runs;
  });
}

export function collectCommits(api, repo, before, after) {
  assert.ok(
    !/^0+$/.test(before),
    'Ref creation has no prior main boundary; historical audit unavailable',
  );
  const commits = api.list(`repos/${repo}/compare/${before}...${after}`, 'commits');
  assert.ok(
    commits.length > 0 && commits.at(-1).sha === after,
    'Complete pushed commit range unavailable',
  );
  return commits;
}
