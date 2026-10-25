import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVersionMetadata } from './verify-version.mjs';
import { productionSbom } from './production-sbom.mjs';
import { isMain, releaseNames, repositoryRoot, runFile, runNpm, sha256 } from './release-utils.mjs';

async function checkCompiledFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkCompiledFiles(path);
    else if (!entry.isFile() || !entry.name.endsWith('.js')) {
      throw new Error(`dist must contain only compiled JavaScript and directories: ${path}`);
    }
  }
}

function matchesApplicationIdentity(component, name, version) {
  return (
    component?.type === 'application' &&
    component?.version === version &&
    component?.['bom-ref'] === `${name}@${version}` &&
    component?.purl === `pkg:npm/${name}@${version}`
  );
}

export function normalizeApplicationSbom(sbom, { name, version }) {
  const component = sbom.metadata?.component;
  // npm uses the checkout directory for the root's display name, but derives
  // both identifiers from package.json. Verify those before canonicalizing it.
  if (sbom.bomFormat !== 'CycloneDX' || !matchesApplicationIdentity(component, name, version)) {
    throw new Error('npm returned an SBOM for a different package or version');
  }
  component.name = name;
  return sbom;
}

async function stageRuntimeFiles(runtime, dist, serialized) {
  await mkdir(runtime);
  await cp(dist, join(runtime, 'dist'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'README.md', '.npmrc']) {
    if (!(await lstat(join(repositoryRoot, file))).isFile()) {
      throw new Error(`Runtime package input must be a regular file: ${file}`);
    }
    await cp(join(repositoryRoot, file), join(runtime, file));
  }
  if (!(await lstat(join(repositoryRoot, 'docs/runtime.md'))).isFile()) {
    throw new Error('Runtime instructions must be a regular file');
  }
  await cp(join(repositoryRoot, 'docs/runtime.md'), join(runtime, 'RUNTIME.md'));
  await writeFile(join(runtime, 'release-metadata.json'), serialized);
}

export async function packageRelease() {
  const version = await loadVersionMetadata();
  const names = releaseNames(version.version);
  const output = join(repositoryRoot, 'release');
  const dist = join(repositoryRoot, 'dist');
  if (!(await lstat(dist)).isDirectory() || !(await lstat(join(dist, 'server.js'))).isFile()) {
    throw new Error('Run npm run build before packaging the release');
  }
  await checkCompiledFiles(dist);
  const npmVersion = (await runNpm(['--version'])).stdout.trim();
  const metadata = { ...version, node: process.version, npm: npmVersion };
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  const sbom = normalizeApplicationSbom(await productionSbom(repositoryRoot), metadata);

  const stage = await mkdtemp(join(tmpdir(), 'mp3-release-stage-'));
  try {
    const runtime = join(stage, names.base);
    await stageRuntimeFiles(runtime, dist, serialized);

    // Replace only generated release output. The source and build output stay intact.
    await rm(output, { recursive: true, force: true });
    await mkdir(output);
    await runFile('tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      join(output, names.archive),
      '-C',
      stage,
      names.base,
    ]);
    await writeFile(join(output, names.sbom), `${JSON.stringify(sbom, null, 2)}\n`);
    await writeFile(join(output, names.manifest), serialized);
    const artifacts = [names.archive, names.sbom, names.manifest];
    const checksums = [];
    for (const name of artifacts) {
      checksums.push(`${await sha256(join(output, name))}  ${name}`);
    }
    await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    console.log(JSON.stringify({ ...metadata, artifacts: [...artifacts, 'SHA256SUMS'] }, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await packageRelease();
