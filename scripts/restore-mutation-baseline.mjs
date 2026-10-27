// Read-only GitHub artifact transport. Artifact code is never executed.
// Missing authentication or compatibility evidence is an ordinary full-run miss.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './mutation-policy.mjs';
import { CACHE_DIRECTORY } from './mutation-cache.mjs';
import { candidateValidator } from './mutation-baseline-validation.mjs';
import {
  BASELINE_LIMITS,
  BaselineMiss,
  baselineCandidates,
  baselineCoordinates,
  candidateArtifact,
  recheckRun,
  restoreSession,
} from './mutation-baseline-selection.mjs';
export { trustedRun, trustedArtifact } from './mutation-baseline-selection.mjs';

const limit = BASELINE_LIMITS.archiveBytes;
export function verifyArchive(bytes, artifact) {
  if (
    bytes.length > limit ||
    bytes.length !== artifact.size_in_bytes ||
    `sha256:${sha256(bytes)}` !== artifact.digest
  )
    throw new Error('Artifact archive digest mismatch');
}
export function verifyEntries(entries) {
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(['manifest.json', 'report.json']))
    throw new Error('Unexpected baseline archive entries');
}
function gh(path, binary = false, timeout = BASELINE_LIMITS.elapsedMs) {
  return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: limit,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function nativeArchiveOptions(session) {
  return {
    encoding: 'utf8',
    maxBuffer: limit,
    timeout: Math.min(10_000, session.remaining()),
    // Preserve the independently reviewed native-option isolation hardening.
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  };
}
async function readArchive(bytes, artifact, session) {
  let temporary;
  try {
    verifyArchive(bytes, artifact);
    temporary = await mkdtemp(join(tmpdir(), 'mutation-artifact-'));
    const archive = join(temporary, 'baseline.zip');
    await writeFile(archive, bytes);
    const read = (args) => execFileSync('unzip', args, nativeArchiveOptions(session));
    verifyEntries(read(['-Z1', archive]).trim().split('\n'));
    // Read only two fixed names, never extract archive-provided paths.
    return {
      manifestText: read(['-p', archive, 'manifest.json']),
      reportText: read(['-p', archive, 'report.json']),
    };
  } catch (error) {
    if (error instanceof BaselineMiss) throw error;
    throw new BaselineMiss('archive-rejected');
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
function sourceManifest(contents, commit) {
  try {
    const manifest = JSON.parse(contents.manifestText);
    if (
      manifest.sourceCommit !== commit ||
      manifest.completed !== true ||
      manifest.reportSha256 !== sha256(contents.reportText)
    )
      throw new Error('Source mismatch');
    JSON.parse(contents.reportText);
    return manifest;
  } catch {
    throw new BaselineMiss('source-rejected');
  }
}
async function validateCandidate(contents, manifest, validate) {
  try {
    if (!(await validate({ manifest, reportText: contents.reportText })))
      throw new Error('No reusable validated kills');
  } catch {
    throw new BaselineMiss('compatibility-rejected');
  }
}
async function restoreCandidate(paths, coordinates, run, session, validate) {
  const { repository, anchor, currentHead } = coordinates;
  const artifact = await candidateArtifact(repository, run, session);
  const bytes = await session.request(
    `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    true,
  );
  const contents = await readArchive(bytes, artifact, session);
  const manifest = sourceManifest(contents, run.head_sha);
  await validateCandidate(contents, manifest, validate);
  await recheckRun(repository, run, session);
  session.remaining();
  const provenance = {
    sourceCommit: run.head_sha,
    anchorCommit: anchor,
    testedCommit: currentHead,
    runId: run.id,
    // The run may retain an earlier job's artifact after rerun-failed-only.
    // GitHub's artifact response does not identify its producing job attempt.
    observedRunAttempt: run.run_attempt,
    artifactId: artifact.id,
    archiveDigest: artifact.digest,
  };
  await mkdir(paths.cache, { recursive: true });
  await writeFile(join(paths.cache, 'report.json'), contents.reportText);
  await writeFile(join(paths.cache, 'manifest.json'), contents.manifestText);
  // Provenance last: partial output cannot authorize a later invocation.
  await writeFile(paths.provenance, JSON.stringify(provenance));
  return { restored: true, ...provenance, reasonCodes: [...session.reasons] };
}
async function restoreCandidates(paths, coordinates, session, validate) {
  const { repository, anchor, currentHead } = coordinates;
  for await (const run of baselineCandidates(repository, anchor, currentHead, session)) {
    try {
      return await restoreCandidate(paths, coordinates, run, session, validate);
    } catch (error) {
      if (!(error instanceof BaselineMiss)) throw error;
      session.reasons.add(error.code);
      if (error.code === 'restore-budget-exhausted') throw error;
    }
  }
  throw new BaselineMiss('no-compatible-baseline');
}
const missed = (reasons) => ({
  restored: false,
  reason: 'No authenticated compatible baseline; full run required',
  reasonCodes: [...reasons],
});
async function clearRestoredState(paths) {
  await rm(paths.cache, { recursive: true, force: true });
  await rm(paths.provenance, { force: true });
}
export async function restoreBaseline(root, repository, anchor, api = gh, options = {}) {
  const paths = {
    cache: join(root, CACHE_DIRECTORY),
    provenance: join(root, '.cache/mutation/provenance.json'),
    lock: join(root, '.cache/mutation/run.lock'),
  };
  const session = restoreSession(api, options.now);
  await mkdir(join(root, '.cache/mutation'), { recursive: true });
  try {
    await mkdir(paths.lock);
  } catch {
    // Never delete or overwrite an active invocation's validated state.
    return missed(['workspace-busy']);
  }
  try {
    await clearRestoredState(paths);
    baselineCoordinates(repository, anchor, options.currentHead);
    const validate = options.validateCandidate ?? (await candidateValidator(root));
    return await restoreCandidates(
      paths,
      { repository, anchor, currentHead: options.currentHead },
      session,
      validate,
    );
  } catch (error) {
    session.reasons.add(
      error instanceof BaselineMiss ? error.code : 'restore-inputs-or-io-unavailable',
    );
    await clearRestoredState(paths);
    // Static codes only: API errors can contain tokens or signed download URLs.
    return missed(session.reasons);
  } finally {
    await rm(paths.lock, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(
    JSON.stringify(
      await restoreBaseline(
        process.cwd(),
        process.env.GITHUB_REPOSITORY,
        process.env.MUTATION_BASE_SHA,
        gh,
        { currentHead: process.env.GITHUB_SHA },
      ),
    ),
  );
}
