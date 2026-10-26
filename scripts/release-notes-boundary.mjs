import assert from 'node:assert/strict';

const shaPattern = /^[0-9a-f]{40}$/;

export async function readTaggedFile(read, path, sha) {
  const file = await read(`contents/${path}?ref=${sha}`);
  assert.equal(file.encoding, 'base64');
  assert.equal(typeof file.content, 'string');
  return Buffer.from(file.content, 'base64').toString('utf8');
}

export async function verifyRepository(read, identity) {
  const repository = await read('');
  assert.equal(repository.full_name, identity.repository, 'Repository name changed');
  assert.equal(String(repository.id), identity.repositoryId, 'Repository was replaced');
}

async function tagNames(read) {
  const pages = await read('git/matching-refs/tags/?per_page=100', true);
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray));
  const names = pages.flat().map((ref) => {
    assert.ok(typeof ref.ref === 'string' && ref.ref.startsWith('refs/tags/'));
    return ref.ref.slice('refs/tags/'.length);
  });
  assert.equal(new Set(names).size, names.length, 'Tag inventory changed during pagination');
  return names.sort();
}

export async function verifyInitialInventory(read, tag) {
  assert.deepEqual(await tagNames(read), [tag], 'Initial release requires exactly its own tag');
  const pages = await read('releases?per_page=100', true);
  assert.ok(Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray));
  // Read-only tokens can omit drafts; the metadata-only native job repeats
  // this check with its write token, which sees every draft.
  assert.ok(
    pages.flat().every((release) => release.tag_name === tag && release.draft === true),
    'Initial release cannot reuse an existing release history',
  );
}

async function initialBoundary(read, identity, sourcePreviousTag, config) {
  const initialization = JSON.parse(
    await readTaggedFile(read, '.github/release-notes-initial.json', identity.sha),
  );
  assert.equal(initialization.schemaVersion, 1);
  assert.equal(
    initialization.repositoryId,
    identity.repositoryId,
    'Initialization belongs to another repository',
  );
  assert.match(initialization.previousVersionTag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (sourcePreviousTag !== null) {
    assert.equal(initialization.previousVersionTag, sourcePreviousTag);
  }
  assert.match(initialization.baseSha, shaPattern);
  assert.equal(
    config['last-release-sha'],
    initialization.baseSha,
    'Initialization must match the source commit walk',
  );
  await verifyInitialInventory(read, identity.tag);
  const manifest = JSON.parse(
    await readTaggedFile(read, '.release-please-manifest.json', initialization.baseSha),
  );
  assert.equal(
    `v${manifest['.']}`,
    initialization.previousVersionTag,
    'Initialization version does not match its commit',
  );
  if (config['bootstrap-sha']) {
    assert.match(config['bootstrap-sha'], shaPattern);
    const ancestry = await read(
      `compare/${config['bootstrap-sha']}...${initialization.baseSha}?per_page=1`,
    );
    assert.ok(
      ['ahead', 'identical'].includes(ancestry.status),
      'Bootstrap must not truncate the initial range',
    );
    assert.equal(ancestry.merge_base_commit.sha, config['bootstrap-sha']);
  }
  return {
    previousTag: null,
    previousSha: initialization.baseSha,
    initialRelease: true,
    initialVersionTag: initialization.previousVersionTag,
  };
}

export async function resolveNotesBoundary(read, identity, sourcePreviousTag, config) {
  const tags = await tagNames(read);
  assert.ok(tags.includes(identity.tag), 'Release tag is missing from the inventory');
  if (!tags.includes(sourcePreviousTag)) {
    // An absent tag never implies a guessed baseline: this file must have
    // been explicitly reviewed and committed before the release was tagged.
    return initialBoundary(read, identity, sourcePreviousTag, config);
  }
  const previousSha = (await read(`commits/${sourcePreviousTag}`)).sha;
  assert.match(previousSha, shaPattern);
  return { previousTag: sourcePreviousTag, previousSha, initialRelease: false };
}
