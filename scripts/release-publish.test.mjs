import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/publish-release.yml', import.meta.url),
  'utf8',
);
const allScripts = workflow
  .split("node --input-type=module <<'JS'\n")
  .slice(1)
  .map((part) =>
    part
      .split('\n          JS')[0]
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n'),
  );
const scripts = [allScripts[0], allScripts[2], allScripts[3]];
const authenticate = allScripts[1];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const repository = 'example/project';
const sha = 'b'.repeat(40);
const tag = 'v2.1.1';
const body = '## 2.1.1\n\nApproved user and engineering notes.\n';
const original = '## 2.1.1\n\nOriginal Release Please notes.';
const base = 'mp3-frame-analyzer-2.1.1';

function metadata() {
  const artifact = (id, name, digest) => ({
    id,
    name,
    digest: `sha256:${digest}`,
    expired: false,
    workflow_run: { id: 123, repository_id: 42, head_repository_id: 42, head_sha: sha },
  });
  return {
    repository: { id: 42, full_name: repository, private: false },
    environment: {
      id: 8,
      name: 'release',
      can_admins_bypass: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [{ type: 'User', reviewer: { id: 7, type: 'User' } }],
        },
      ],
    },
    policies: [{ branch_policies: [{ name: 'v*', type: 'tag' }] }],
    approvals: [
      {
        state: 'approved',
        user: { id: 7, type: 'User' },
        environments: [{ id: 8, name: 'release' }],
      },
    ],
    release: { id: 9, tag_name: tag, draft: true, prerelease: false, body: original },
    tagSha: sha,
    ancestry: { status: 'ahead' },
    artifacts: {
      11: artifact(11, 'release-assets-1', 'a'.repeat(64)),
      12: artifact(12, `release-notes-${tag}-1`, 'c'.repeat(64)),
    },
    assets: [],
    releases: [],
  };
}

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = process.env.FIXTURE_ROOT;
const state = JSON.parse(fs.readFileSync(root + '/state.json', 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls.jsonl', JSON.stringify(args) + '\\n');
function save() { fs.writeFileSync(root + '/state.json', JSON.stringify(state)); }
function api() {
  const path = args.find((arg) => arg.startsWith('repos/'));
  const suffix = path.slice('repos/example/project'.length).replace(/^\\//, '');
  if (!suffix) return state.repository;
  if (suffix === 'environments/release') return state.environment;
  if (suffix.includes('deployment-branch-policies')) return state.policies;
  if (suffix === 'actions/runs/123') return state.run;
  if (suffix === 'actions/runs/123/approvals') return state.approvals;
  if (suffix.startsWith('actions/artifacts/')) return state.artifacts[suffix.split('/').at(-1)];
  if (suffix === 'releases/9') return state.release;
  if (suffix === 'commits/v2.1.1') return { sha: state.tagSha };
  if (suffix.startsWith('compare/')) return state.ancestry;
  if (suffix === 'releases/9/assets?per_page=100') return [state.assets];
  if (suffix === 'releases?per_page=100') return [[state.release, ...state.releases]];
  throw new Error('Unexpected API: ' + path);
}
if (args[0] === 'api') process.stdout.write(JSON.stringify(api()));
else if (args[0] === 'release' && args[1] === 'upload') {
  state.assets = args.slice(3, args.indexOf('--repo')).map((path) => ({
    name: require('node:path').basename(path), state: 'uploaded',
    digest: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex') }));
  if (state.failUpload) process.exit(1);
  if (state.revokeAfterUpload) state.approvals = [];
  if (state.moveAfterUpload) state.tagSha = 'a'.repeat(40);
  if (state.badUpload) state.assets[0].digest = 'sha256:' + '0'.repeat(64);
  save();
} else if (args[0] === 'release' && args[1] === 'edit') {
  state.release.draft = false;
  state.release.body = state.badPublication ? 'Wrong text'
    : fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
  save();
} else throw new Error('Unexpected command: ' + args);
`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'release-publish-'));
  for (const name of ['bin', 'release', 'notes']) await mkdir(join(directory, name));
  await writeFile(join(directory, 'bin/gh'), fakeGh);
  await chmod(join(directory, 'bin/gh'), 0o755);
  const runtime = {
    [`${base}.tar.gz`]: 'Tested runtime bytes',
    [`${base}.cdx.json`]: '{"bomFormat":"CycloneDX"}',
    [`${base}.manifest.json`]: JSON.stringify({ sourceCommit: sha, tag, version: '2.1.1' }),
  };
  for (const [name, data] of Object.entries(runtime))
    await writeFile(join(directory, 'release', name), data);
  const sums = Object.entries(runtime)
    .map(([name, data]) => `${hash(data)}  ${name}\n`)
    .join('');
  await writeFile(join(directory, 'release/SHA256SUMS'), sums);
  await writeFile(join(directory, 'notes/body.md'), body);
  await writeFile(
    join(directory, 'notes/manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      repository,
      repositoryId: '42',
      sha,
      tag,
      bodySha256: hash(body),
      userNotesSha256: hash(original),
      producer: { runId: '123', runAttempt: '1', workflowSha: sha },
    }),
  );
  await writeFile(join(directory, 'state.json'), JSON.stringify(metadata()));
  const env = {
    ...process.env,
    PATH: `${directory}/bin:${process.env.PATH}`,
    FIXTURE_ROOT: directory,
    GH_REPO: repository,
    RELEASE_APPROVER_ID: '7',
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_REPOSITORY_ID: '42',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: sha,
    GITHUB_REF: `refs/tags/${tag}`,
    RELEASE_TAG: tag,
    RELEASE_SHA: sha,
    RUNTIME_ID: '11',
    RUNTIME_DIGEST: 'a'.repeat(64),
    RUNTIME_ATTEMPT: '1',
    NOTES_ID: '12',
    NOTES_DIGEST: 'c'.repeat(64),
    NOTES_BODY_SHA256: hash(body),
    DRAFT_BODY_SHA256: hash(original),
    ORIGINAL_NOTES_SHA256: hash(original),
    RUNTIME_CHECKSUMS_SHA256: hash(sums),
    DRAFT_RELEASE_ID: '9',
    ENVIRONMENT_ID: '8',
    APPROVER_ID: '7',
    GITHUB_OUTPUT: join(directory, 'output'),
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
  };
  const change = async (edit) => {
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    edit(state);
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  };
  const run = (index) =>
    spawnSync(process.execPath, ['--input-type=module'], {
      input: scripts[index],
      cwd: index === 2 ? join(directory, '.release-bundle') : directory,
      env,
      encoding: 'utf8',
    });
  assert.equal(run(1).status, 0, 'Seal fixture candidate');
  env.BUNDLE_CHECKSUMS_SHA256 = hash(
    await readFile(join(directory, '.release-bundle/BUNDLE-SHA256SUMS')),
  );
  const calls = async () => {
    const content = await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return {
    directory,
    env,
    change,
    run,
    calls,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('release remains a draft until the sole native environment publication gate', async () => {
  const config = JSON.parse(
    await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
  );
  assert.equal(config.packages['.'].draft, true);
  assert.equal(config.packages['.']['force-tag-creation'], true);
  assert.equal(scripts.length, 3);
  assert.equal(workflow.match(/--draft=false/g).length, 1);
  assert.ok(workflow.includes('environment:\n      name: release'));
  assert.ok(!workflow.includes("needs.provenance.result == 'skipped'"));
  assert.ok(!workflow.includes('gh release approve'));
});

test('preflight and candidate prepare exact identities without release mutations', async () => {
  const f = await fixture();
  try {
    for (const index of [0, 1]) {
      const result = f.run(index);
      assert.equal(result.status, 0, result.stderr);
    }
    const output = await readFile(join(f.directory, 'output'), 'utf8');
    assert.ok(output.includes('approver_id=7\n'));
    assert.ok(output.includes('runtime_id=11\n'));
    assert.ok(output.includes(`notes_body_sha256=${hash(body)}\n`));
    assert.ok((await readFile(join(f.directory, 'summary'), 'utf8')).includes(body));
    assert.ok((await f.calls()).every((args) => args[0] === 'api'));
  } finally {
    await f.cleanup();
  }
});

test('publication uploads only approved files, publishes approved text, and reads back the result', async () => {
  const f = await fixture();
  try {
    const result = f.run(2);
    assert.equal(result.status, 0, result.stderr);
    const calls = await f.calls();
    const writes = calls.filter((args) => args[0] === 'release');
    assert.deepEqual(
      writes.map((args) => args[1]),
      ['upload', 'edit'],
    );
    assert.equal(writes[0].filter((arg) => arg.startsWith('release/')).length, 4);
    assert.deepEqual(writes[1], [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--notes-file',
      'notes/body.md',
      '--draft=false',
      '--latest=true',
    ]);
    assert.ok(calls.at(-1).includes('repos/example/project/releases/9/assets?per_page=100'));
  } finally {
    await f.cleanup();
  }
});

const rejected = [
  [
    'missing approval',
    (s) => {
      s.approvals = [];
    },
  ],
  [
    'other approver',
    (s) => {
      s.approvals[0].user.id = 6;
    },
  ],
  [
    'multiple decisions',
    (s) => {
      s.approvals.push(s.approvals[0]);
    },
  ],
  [
    'rejected decision',
    (s) => {
      s.approvals[0].state = 'rejected';
    },
  ],
  [
    'reviewer drift',
    (s) => {
      s.environment.protection_rules[0].reviewers[0].reviewer.id = 6;
    },
  ],
  [
    'admin bypass',
    (s) => {
      s.environment.can_admins_bypass = true;
    },
  ],
  [
    'branch policy drift',
    (s) => {
      s.policies[0].branch_policies[0].type = 'branch';
    },
  ],
  [
    'replaced repository',
    (s) => {
      s.repository.id = 99;
    },
  ],
  [
    'private repository',
    (s) => {
      s.repository.private = true;
    },
  ],
  [
    'different run',
    (s) => {
      s.artifacts['11'].workflow_run.id = 999;
    },
  ],
  [
    'different source',
    (s) => {
      s.artifacts['11'].workflow_run.head_sha = 'a'.repeat(40);
    },
  ],
  [
    'wrong artifact digest',
    (s) => {
      s.artifacts['12'].digest = 'sha256:' + '0'.repeat(64);
    },
  ],
  [
    'expired artifact',
    (s) => {
      s.artifacts['11'].expired = true;
    },
  ],
  [
    'edited draft',
    (s) => {
      s.release.body = 'Unapproved text';
    },
  ],
  [
    'already published',
    (s) => {
      s.release.draft = false;
    },
  ],
  [
    'moved tag',
    (s) => {
      s.tagSha = 'a'.repeat(40);
    },
  ],
  [
    'extra draft asset',
    (s) => {
      s.assets.push({ name: 'surprise.txt' });
    },
  ],
];
for (const [name, edit] of rejected)
  test(`publisher rejects ${name} before any mutation`, async () => {
    const f = await fixture();
    try {
      await f.change(edit);
      const result = f.run(2);
      assert.notEqual(result.status, 0);
      assert.deepEqual(
        (await f.calls()).filter((args) => args[0] === 'release'),
        [],
      );
    } finally {
      await f.cleanup();
    }
  });

test('new attempts and changed local bytes cannot reuse approval', async () => {
  for (const mutation of ['attempt', 'runtime', 'notes', 'extra']) {
    const f = await fixture();
    try {
      if (mutation === 'attempt') f.env.GITHUB_RUN_ATTEMPT = '2';
      if (mutation === 'runtime') {
        await writeFile(join(f.directory, `release/${base}.tar.gz`), 'Changed');
        await writeFile(join(f.directory, `.release-bundle/release/${base}.tar.gz`), 'Changed');
      }
      if (mutation === 'notes') {
        await writeFile(join(f.directory, 'notes/body.md'), 'Changed');
        await writeFile(join(f.directory, '.release-bundle/notes/body.md'), 'Changed');
      }
      if (mutation === 'extra') {
        await writeFile(join(f.directory, 'release/extra.txt'), 'Extra');
        await writeFile(join(f.directory, '.release-bundle/release/extra.txt'), 'Extra');
      }
      for (const index of [1, 2]) assert.notEqual(f.run(index).status, 0, mutation);
      assert.deepEqual(
        (await f.calls()).filter((args) => args[0] === 'release'),
        [],
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('bad uploaded digests stop before final publication; bad published text is reported', async () => {
  for (const field of ['badUpload', 'badPublication']) {
    const f = await fixture();
    try {
      await f.change((s) => {
        s[field] = true;
      });
      assert.notEqual(f.run(2).status, 0);
      const writes = (await f.calls()).filter((args) => args[0] === 'release');
      assert.deepEqual(
        writes.map((args) => args[1]),
        field === 'badUpload' ? ['upload'] : ['upload', 'edit'],
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('older drafts cannot move the latest release backwards', async () => {
  const f = await fixture();
  try {
    await f.change((s) => {
      s.releases.push({ tag_name: 'v3.0.0', draft: false, prerelease: false });
    });
    const result = f.run(2);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await f.calls()).find((args) => args[1] === 'edit').includes('--latest=false'));
  } finally {
    await f.cleanup();
  }
});

test('artifact authentication rejects every source and producer identity drift before download', async () => {
  const validRun = {
    id: 123,
    run_attempt: 1,
    repository: { id: 42 },
    head_repository: { id: 42 },
    head_sha: sha,
    event: 'workflow_dispatch',
    path: '.github/workflows/publish-release.yml',
  };
  for (const change of [
    null,
    (s) => {
      s.run.run_attempt = 2;
    },
    (s) => {
      s.run.id = 124;
    },
    (s) => {
      s.run.repository.id = 43;
    },
    (s) => {
      s.run.head_repository.id = 43;
    },
    (s) => {
      s.run.head_sha = 'a'.repeat(40);
    },
    (s) => {
      s.run.event = 'pull_request';
    },
    (s) => {
      s.run.path = '.github/workflows/other.yml';
    },
    (s) => {
      s.artifacts[11].id = 99;
    },
    (s) => {
      s.artifacts[11].name = 'release-assets-2';
    },
    (s) => {
      s.artifacts[12].workflow_run.repository_id = 43;
    },
    (s) => {
      s.artifacts[12].workflow_run.head_repository_id = 43;
    },
    (s) => {
      s.artifacts[12].workflow_run.id = 124;
    },
    (s) => {
      s.artifacts[12].digest = 'sha256:' + '0'.repeat(64);
    },
    (s) => {
      s.artifacts[12].expired = true;
    },
  ]) {
    const f = await fixture();
    try {
      await f.change((s) => {
        s.run = structuredClone(validRun);
        if (change) change(s);
      });
      f.env.DEPENDENCIES = JSON.stringify({
        verify: { outputs: { release_artifact_id: '11', release_artifact_digest: 'a'.repeat(64) } },
        notes: { outputs: { artifact_id: '12', artifact_digest: 'c'.repeat(64) } },
      });
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        input: authenticate,
        cwd: f.directory,
        env: f.env,
        encoding: 'utf8',
      });
      assert.equal(result.status === 0, change === null, result.stderr);
      assert.ok((await f.calls()).every((args) => args[0] === 'api' && !args.includes('POST')));
    } finally {
      await f.cleanup();
    }
  }
});

test('the reviewed owner identity cannot be replaced before preflight', async () => {
  const f = await fixture();
  try {
    f.env.RELEASE_APPROVER_ID = '999';
    assert.notEqual(f.run(0).status, 0);
    assert.notEqual(f.run(2).status, 0);
  } finally {
    await f.cleanup();
  }
});

test('provenance and publication use the same sealed candidate and cover notes as well as runtime', () => {
  const provenance = workflow.split('\n  provenance:\n')[1].split('\n  publish:\n')[0];
  const publish = workflow.split('\n  publish:\n')[1];
  for (const section of [provenance, publish]) {
    assert.ok(section.includes('*authenticate-artifacts'));
    assert.ok(section.includes('artifact-ids: ${{ needs.candidate.outputs.bundle_id }}'));
    assert.ok(section.includes('digest-mismatch: error'));
    assert.doesNotMatch(section, /actions\/checkout|npm run|node scripts\//);
  }
  assert.ok(provenance.includes('subject-path: .release-bundle/**/*'));
  assert.ok(workflow.includes("'notes/body.md', 'notes/manifest.json', 'release-identity.json'"));
  assert.equal(workflow.match(/name: release\n/g).length, 1);
});

test('upload failures and approval/source drift during upload never publish', async () => {
  for (const flag of ['failUpload', 'revokeAfterUpload', 'moveAfterUpload']) {
    const f = await fixture();
    try {
      await f.change((state) => {
        state[flag] = true;
      });
      assert.notEqual(f.run(2).status, 0);
      assert.ok(!(await f.calls()).some((args) => args[0] === 'release' && args[1] === 'edit'));
    } finally {
      await f.cleanup();
    }
  }
});

test('hosted prerequisite never executes project artifacts or requests publication approval', async () => {
  const preview = await readFile(
    new URL('../.github/workflows/release-prerequisites.yml', import.meta.url),
    'utf8',
  );
  const native = preview.split('\n  native:\n')[1].split('\n  transport:\n')[0];
  assert.ok(native.includes('contents: write'));
  assert.ok(native.includes('/releases/generate-notes'));
  assert.doesNotMatch(
    native,
    /actions\/checkout|actions\/download-artifact|node scripts\/|npm |gh release|PATCH|DELETE/,
  );
  assert.doesNotMatch(preview, /environment:|--draft=false|release.*upload/);
});

test('notes caller permits metadata authentication without elevating composition', () => {
  const notes = workflow.split('\n  notes:\n')[1].split('\n  candidate:\n')[0];
  assert.match(notes, /actions: read/);
  assert.match(notes, /pull-requests: read/);
  assert.match(notes, /contents: write/);
});
