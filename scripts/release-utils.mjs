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
    if (!entry.startsWith(`${base}/`) || entry.includes('\\') || seen.has(entry)) {
      throw new Error(`Unexpected archive member: ${entry}`);
    }
    seen.add(entry);
    const path = entry.slice(base.length + 1);
    const parts = path.split('/');
    if (parts.some((part) => part === '..' || part === '.')) {
      throw new Error(`Unexpected archive member: ${entry}`);
    }
    const isDirectory = entry.endsWith('/');
    if (isDirectory) {
      if (path !== '' && path !== 'dist/' && !/^dist\/(?:[\w-]+\/)+$/.test(path)) {
        throw new Error(`Unexpected archive directory: ${entry}`);
      }
    } else if (!rootFiles.has(path) && !/^dist\/(?:[\w-]+\/)*[\w.-]+\.js$/.test(path)) {
      throw new Error(`Unexpected runtime file: ${entry}`);
    }
    required.delete(path);
  }
  if (required.size > 0) throw new Error(`Runtime archive is missing: ${[...required].join(', ')}`);
}
