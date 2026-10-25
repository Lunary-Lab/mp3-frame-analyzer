// Read-only GitHub artifact transport. The current checkout never executes code
// from the artifact, and failed/missing provenance is an ordinary full-run miss.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './mutation-policy.mjs';
import { CACHE_DIRECTORY } from './mutation-cache.mjs';

const NAME = 'validated-mutation-baseline';
const limit = 32 * 1024 * 1024;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
export function trustedRun(run, repository, commit) {
  return (
    positiveId(run.id) &&
    positiveId(run.repository?.id) &&
    run.head_repository?.id === run.repository.id &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.head_sha === commit &&
    run.head_branch === 'main' &&
    run.event === 'push' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.path === '.github/workflows/ci.yml'
  );
}
export function trustedArtifact(artifact, run) {
  return (
    positiveId(artifact.id) &&
    artifact.name === NAME &&
    artifact.expired === false &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= limit &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
    artifact.workflow_run?.id === run.id &&
    artifact.workflow_run.head_sha === run.head_sha &&
    artifact.workflow_run.head_branch === 'main' &&
    artifact.workflow_run.repository_id === run.repository.id &&
    artifact.workflow_run.head_repository_id === run.repository.id
  );
}
export function verifyArchive(bytes, artifact) {
  if (bytes.length > limit || `sha256:${sha256(bytes)}` !== artifact.digest)
    throw new Error('Artifact archive digest mismatch');
}
export function verifyEntries(entries) {
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(['manifest.json', 'report.json']))
    throw new Error('Unexpected baseline archive entries');
}
function gh(path, binary = false) {
  return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: limit,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export async function restoreBaseline(root, repository, commit, api = gh) {
  const cache = join(root, CACHE_DIRECTORY);
  const provenancePath = join(root, '.cache/mutation/provenance.json');
  // In CI neither a PR-scoped cache nor checkout-supplied files can seed reuse.
  await rm(cache, { recursive: true, force: true });
  await rm(provenancePath, { force: true });
  let temporary;
  try {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') ||
      !/^[a-f0-9]{40}$/.test(commit ?? '') ||
      /^0+$/.test(commit)
    )
      throw new Error('No exact baseline commit');
    const runs = JSON.parse(
      await api(
        `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&status=success&per_page=100`,
      ),
    ).workflow_runs;
    const run = runs.find((item) => trustedRun(item, repository, commit));
    if (!run) throw new Error('No successful exact-base main CI run');
    const artifacts = JSON.parse(
      await api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`),
    ).artifacts;
    const matches = artifacts.filter((item) => trustedArtifact(item, run));
    if (matches.length !== 1) throw new Error('No unique trusted baseline artifact');
    const artifact = matches[0];
    const bytes = await api(`repos/${repository}/actions/artifacts/${artifact.id}/zip`, true);
    verifyArchive(bytes, artifact);
    temporary = await mkdtemp(join(tmpdir(), 'mutation-artifact-'));
    const archive = join(temporary, 'baseline.zip');
    await writeFile(archive, bytes);
    const options = { encoding: 'utf8', maxBuffer: limit, timeout: 10_000 };
    const entries = execFileSync('unzip', ['-Z1', archive], options).trim().split('\n');
    verifyEntries(entries);
    // Read only two fixed names, never extract archive-provided paths.
    const manifestText = execFileSync('unzip', ['-p', archive, 'manifest.json'], options);
    const reportText = execFileSync('unzip', ['-p', archive, 'report.json'], options);
    const manifest = JSON.parse(manifestText);
    if (
      manifest.sourceCommit !== commit ||
      manifest.completed !== true ||
      manifest.reportSha256 !== sha256(reportText)
    )
      throw new Error('Baseline manifest/report source mismatch');
    JSON.parse(reportText);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'report.json'), reportText);
    await writeFile(join(cache, 'manifest.json'), manifestText);
    const provenance = {
      sourceCommit: commit,
      runId: run.id,
      artifactId: artifact.id,
      archiveDigest: artifact.digest,
    };
    await writeFile(provenancePath, JSON.stringify(provenance));
    return { restored: true, ...provenance };
  } catch {
    await rm(cache, { recursive: true, force: true });
    await rm(provenancePath, { force: true });
    // Do not echo API errors containing authentication or signed download URLs.
    return { restored: false, reason: 'No authenticated compatible baseline; full run required' };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await restoreBaseline(
    process.cwd(),
    process.env.GITHUB_REPOSITORY,
    process.env.MUTATION_BASE_SHA,
  );
  console.log(JSON.stringify(result));
}
