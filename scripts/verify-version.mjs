import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMain, readJson, repositoryRoot, runFile } from './release-utils.mjs';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitSha = /^[0-9a-f]{40}$/i;

function isCommit(value) {
  return typeof value === 'string' && value.length === 40 && commitSha.test(value);
}

function validatePackageIdentity(pkg) {
  if (
    pkg.name !== 'mp3-frame-analyzer' ||
    typeof pkg.version !== 'string' ||
    pkg.version.trim() !== pkg.version ||
    !stableVersion.test(pkg.version)
  ) {
    throw new Error('package.json must name mp3-frame-analyzer and use a stable X.Y.Z version');
  }
}

function validateVersionAgreement(pkg, lock, manifest) {
  if (
    lock.name !== pkg.name ||
    lock.version !== pkg.version ||
    lock.packages?.['']?.name !== pkg.name ||
    lock.packages?.['']?.version !== pkg.version ||
    manifest['.'] !== pkg.version
  ) {
    throw new Error(
      'package.json, package-lock.json root, and release manifest versions must agree',
    );
  }
}

function validateSourceCommit(gitHead, sourceCommit, ci) {
  if (!isCommit(gitHead)) throw new Error('The checked-out Git HEAD must be a full commit SHA');
  if (sourceCommit !== undefined && !isCommit(sourceCommit)) {
    throw new Error('SOURCE_COMMIT must be a full 40-character hexadecimal commit SHA');
  }
  if (ci && sourceCommit !== undefined && sourceCommit.toLowerCase() !== gitHead.toLowerCase()) {
    throw new Error('SOURCE_COMMIT does not match the checked-out Git HEAD');
  }
}

export function validateVersionMetadata(pkg, lock, manifest, options = {}) {
  const { tag, sourceCommit, gitHead, ci = false } = options;
  validatePackageIdentity(pkg);
  validateVersionAgreement(pkg, lock, manifest);
  if (tag !== undefined && tag !== `v${pkg.version}`) {
    throw new Error('RELEASE_TAG must be the exact stable vX.Y.Z tag matching package.json');
  }
  validateSourceCommit(gitHead, sourceCommit, ci);
  return {
    name: pkg.name,
    version: pkg.version,
    tag: `v${pkg.version}`,
    sourceCommit: (sourceCommit ?? gitHead).toLowerCase(),
  };
}

export async function loadVersionMetadata(root = repositoryRoot) {
  const [pkg, lock, manifest, git] = await Promise.all([
    readJson(join(root, 'package.json')),
    readJson(join(root, 'package-lock.json')),
    readJson(join(root, '.release-please-manifest.json')),
    runFile('git', ['rev-parse', 'HEAD'], { cwd: root }),
  ]);
  return validateVersionMetadata(pkg, lock, manifest, {
    tag: process.env.RELEASE_TAG || undefined,
    sourceCommit: process.env.SOURCE_COMMIT || undefined,
    gitHead: git.stdout.trim(),
    ci:
      ![undefined, '', 'false', '0'].includes(process.env.CI) ||
      process.env.GITHUB_ACTIONS === 'true',
  });
}

if (isMain(import.meta.url)) {
  const metadata = await loadVersionMetadata();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${metadata.version}\ntag=${metadata.tag}\nsource_commit=${metadata.sourceCommit}\n`,
    );
  }
  console.log(JSON.stringify(metadata, null, 2));
}
