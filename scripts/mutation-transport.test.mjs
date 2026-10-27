import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
const action = parse(
  await readFile(new URL('../.github/actions/test-mutations/action.yml', import.meta.url), 'utf8'),
);
const script = action.runs.steps.find((step) => step.id === 'baseline').with.script;
const base = 'b'.repeat(40);
const good = {
  id: 7,
  head_sha: base,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  head_repository: { full_name: 'owner/repo' },
};
async function select({
  runs = [good],
  relation = 'identical',
  artifacts,
  unavailable = false,
} = {}) {
  const output = {};
  const list = async () => {
    if (unavailable) throw new Error('private transport detail');
    return { data: { workflow_runs: runs } };
  };
  const github = {
    rest: {
      actions: { listWorkflowRuns: list, listWorkflowRunArtifacts: 'artifacts' },
      repos: { compareCommits: async () => ({ data: { status: relation } }) },
    },
    paginate: async () =>
      artifacts ?? [
        { id: 9, name: 'native-baseline.json', expired: false, digest: `sha256:${'d'.repeat(64)}` },
      ],
  };
  await runInNewContext(
    `(async () => {${script}})()`,
    {
      github,
      context: { repo: { owner: 'owner', repo: 'repo' } },
      process: { env: { MUTATION_BASE_SHA: base } },
      core: {
        setOutput: (name, value) => {
          output[name] = value;
        },
        notice: () => {},
      },
    },
    { timeout: 1000 },
  );
  return output;
}
test('transport selects exact successful main or one verified ancestor, never untrusted latest', async () => {
  assert.deepEqual(await select(), { artifact: 9, run: 7, commit: base });
  const ancestor = { ...good, head_sha: 'a'.repeat(40) };
  assert.deepEqual(await select({ runs: [ancestor], relation: 'ahead' }), {
    artifact: 9,
    run: 7,
    commit: ancestor.head_sha,
  });
  assert.deepEqual(await select({ runs: [ancestor, good], relation: 'identical' }), {
    artifact: 9,
    run: 7,
    commit: base,
  });
  for (const delta of [
    { status: 'in_progress' },
    { conclusion: 'cancelled' },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'attacker/repo' } },
  ])
    assert.deepEqual(await select({ runs: [{ ...good, ...delta }] }), {});
  for (const relation of ['behind', 'diverged', 'unknown'])
    assert.deepEqual(await select({ relation }), {});
  for (const artifacts of [
    [],
    [{ name: 'native-baseline.json', expired: true }],
    [{ name: 'native-baseline.json', expired: false, digest: 'unverified' }],
  ])
    assert.deepEqual(await select({ artifacts }), {});
  assert.deepEqual(await select({ unavailable: true }), {});
});
