import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export function isMain(url) {
  return process.argv[1] !== undefined && url === pathToFileURL(resolve(process.argv[1])).href;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function runFile(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const details = String(error.stderr || error.message)
      .trim()
      .slice(-3000);
    throw new Error(`${command} ${args.join(' ')} failed: ${details}`, { cause: error });
  }
}

// Native archive options are not inherited; the selected host PATH remains trusted.
export function runTar(args) {
  return runFile('tar', args, { env: { PATH: process.env.PATH, LC_ALL: 'C' } });
}

export function npmCommand(args, npmExecPath = process.env.npm_execpath) {
  return npmExecPath ? [process.execPath, [npmExecPath, ...args]] : ['npm', args];
}

export function runNpm(args, options) {
  const [command, commandArgs] = npmCommand(args);
  return runFile(command, commandArgs, options);
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function releaseNames(version) {
  const base = `mp3-frame-analyzer-${version}`;
  return {
    base,
    archive: `${base}.tar.gz`,
    sbom: `${base}.cdx.json`,
    manifest: `${base}.manifest.json`,
  };
}

export function parseChecksums(contents, expectedNames) {
  const entries = new Map();
  for (const line of contents.trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !expectedNames.includes(match[2]) || entries.has(match[2])) {
      throw new Error('SHA256SUMS contains an invalid, unexpected, or duplicate entry');
    }
    entries.set(match[2], match[1]);
  }
  if (entries.size !== expectedNames.length) throw new Error('SHA256SUMS is incomplete');
  return entries;
}

function archiveMemberPath(entry, base, seen) {
  if (!entry.startsWith(`${base}/`) || entry.includes('\\') || seen.has(entry)) {
    throw new Error(`Unexpected archive member: ${entry}`);
  }
  seen.add(entry);
  const path = entry.slice(base.length + 1);
  if (path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Unexpected archive member: ${entry}`);
  }
  return path;
}

function validateRuntimePath(entry, path, rootFiles) {
  if (entry.endsWith('/')) {
    if (path !== '' && path !== 'dist/' && !/^dist\/(?:[\w-]+\/)+$/.test(path)) {
      throw new Error(`Unexpected archive directory: ${entry}`);
    }
  } else if (!rootFiles.has(path) && !/^dist\/(?:[\w-]+\/)*[\w.-]+\.js$/.test(path)) {
    throw new Error(`Unexpected runtime file: ${entry}`);
  }
}

export function validateArchiveEntries(entries, base) {
  const required = new Set([
    'dist/server.js',
    'package.json',
    'package-lock.json',
    'README.md',
    'RUNTIME.md',
    '.npmrc',
    'release-metadata.json',
  ]);
  const rootFiles = new Set([...required].filter((path) => !path.startsWith('dist/')));
  const seen = new Set();
  for (const entry of entries) {
    const path = archiveMemberPath(entry, base, seen);
    validateRuntimePath(entry, path, rootFiles);
    required.delete(path);
  }
  if (required.size > 0) throw new Error(`Runtime archive is missing: ${[...required].join(', ')}`);
}

/** Both artifact consumers require the same safe member names and entry types. */
export async function validateRuntimeArchive(archive, base, nonRegularMessage) {
  const listing = await runTar(['-tzf', archive]);
  validateArchiveEntries(listing.stdout.trimEnd().split('\n'), base);
  const verbose = await runTar(['-tvzf', archive]);
  assert.ok(
    verbose.stdout
      .trimEnd()
      .split('\n')
      .every((line) => /^[d-]/.test(line)),
    nonRegularMessage,
  );
}
