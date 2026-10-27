import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const digest = '4d6ab1a3178a984f7ceb47d0caeee316dde0e586068f2c1e2175e1ac27f72902';
const archiveName = 'go1.27.3.linux-amd64.tar.gz';
// A fixed, harmless executable fixture; real release bytes are tested separately.
const archive = Buffer.from(
  'H4sIAAAAAAACA+3Rz0vDMBQH8Jz7VzzrRtHD2maLBQfeZHgxMIcnL7W+1oIm0mQy/3vTquCv6+bA7+fykrwHL/BtbCq2LQsKpYYafK+/nE+mSgpSYgfWzpddWCn+p8amt61J9yz/IpfIf5f5N/YP85fFj/xnaiYoQ/5bd3gw5O/uo1M6o3i00EutVylvuFp7voujqnQc3nMayZhaExElnh/4kX33QraukyPiTespo/m8b7J5poW+Pl9eXejL0HzqWuNrShqbT2Qxmd6Y5Mtkv+7T2Nj1Ax//iN9Gj9935EV/Z1dWkQAAAAAAAAAAAAAAAAAAAACAwSsLTeR7ACgAAA==',
  'base64',
);

async function fixture(run, bytes = archive, checksum = digest) {
  const root = await mkdtemp(join(tmpdir(), 'mp3-go-bootstrap-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, '.github/security'), { recursive: true });
    const temporary = join(root, 'runner temp');
    await mkdir(temporary);
    const script = join(root, 'scripts/bootstrap-go.sh');
    await writeFile(script, await readFile(new URL('./bootstrap-go.sh', import.meta.url)));
    const pin = join(root, '.github/security/go-archive.sha256');
    await writeFile(pin, `${checksum}  ${archiveName}\n`);
    const file = join(root, archiveName);
    await writeFile(file, bytes);
    const destination = join(temporary, `mp3-verified-go-1.27.3-${checksum}`);
    const invoke = (args = [file], extra = {}) =>
      spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, RUNNER_TEMP: temporary, ...extra },
      });
    await run({ root, temporary, script, pin, file, destination, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('verified offline Go archive publishes only its own compiler root', async () => {
  await fixture(async ({ invoke, destination }) => {
    const result = invoke(undefined, { GOROOT: '/unreviewed', GOCACHEPROG: '/bin/false' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(destination, 'go'));
    assert.ok((await stat(join(destination, 'go/executed'))).isFile());
  });
});

test('a failed compiler probe cannot publish a root even when stdout looks correct', async () => {
  const failedProbe = Buffer.from(
    'H4sIAAAAAAACA+3RQUvDMBQH8Jz7KZ51UuZhbdrVgAVvMrwYmOLJS62vtaCJNJnMb2+2gczhdVPY/3d5IXmPF/h3NhX7lgWqLNc12K2/nC+KMhdUigNYOF8PYaU4Tp1Nn3qT/rP8lcyR/yHz7+wf5l9kcjf/6VQJypD/3p2erPN3L9ElXVE8mum51vcpL7lZeH6Oo6Z2HO4ljfKYehMRJZ5f+Y398Em2bZMx8bL3lFFVrR7ZfNBMP1zP7270bXh8H3rjW0o6Kye5mhSPJqk2E1L9GFnt3eo/c6Hz+0PxpvV8vD3Krm4iAQAAAAAAAAAAAAAAAAAAAHDcvgDUZpBYACgAAA==',
    'base64',
  );
  await fixture(
    async ({ invoke }) => {
      const result = invoke();
      assert.equal(result.status, 17);
      assert.equal(result.stdout, '');
    },
    failedProbe,
    'e2e00e47657440ac6543419733bcfc35a13008a60154f94fc313dfec604f227a',
  );
});

test('missing hashes, substituted bytes and wrong source identity fail before extraction', async () => {
  for (const kind of ['missing', 'weak', 'source', 'tampered']) {
    await fixture(async ({ invoke, pin, file, destination }) => {
      if (kind === 'missing') await writeFile(pin, '');
      if (kind === 'weak') await writeFile(pin, `abcd  ${archiveName}\n`);
      if (kind === 'source') await writeFile(pin, `${digest}  other.tar.gz\n`);
      if (kind === 'tampered') await writeFile(file, 'substituted archive');
      const result = invoke();
      assert.notEqual(result.status, 0, kind);
      assert.equal(result.stdout, '', kind);
      await assert.rejects(stat(join(destination, 'go')), { code: 'ENOENT' });
    });
  }
});

test('occupied Go destinations are never followed, reused or removed', async () => {
  for (const kind of ['directory', 'file', 'symlink']) {
    await fixture(async ({ root, invoke, destination }) => {
      const sentinel = join(root, 'untouched');
      await writeFile(sentinel, 'keep');
      if (kind === 'directory') await mkdir(destination);
      if (kind === 'file') await writeFile(destination, 'keep');
      if (kind === 'symlink') await symlink(sentinel, destination);
      assert.notEqual(invoke().status, 0, kind);
      assert.equal(await readFile(sentinel, 'utf8'), 'keep');
      if (kind !== 'directory') assert.equal(await readFile(destination, 'utf8'), 'keep');
      else assert.ok((await stat(destination)).isDirectory());
    });
  }
});

test('concurrent Go acquisitions have exactly one owner', async () => {
  await fixture(async ({ script, file, temporary, destination }) => {
    const run = () =>
      promisify(execFile)('bash', [script, file], {
        env: { ...process.env, RUNNER_TEMP: temporary },
        timeout: 30_000,
      }).then(
        () => 0,
        (error) => error.code,
      );
    assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 1]);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.ok((await stat(join(destination, 'go/executed'))).isFile());
  });
});

test('Go download requires the exact HTTPS source and rejects redirects before extraction', async () => {
  for (const status of ['200', '302']) {
    await fixture(async ({ root, file, invoke, destination }) => {
      const bin = join(root, 'transport');
      await mkdir(bin);
      const log = join(root, 'arguments.json');
      await writeFile(
        join(bin, 'curl'),
        `#!${process.execPath}\n` +
          `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
          `fs.writeFileSync(process.env.ARGUMENT_LOG, JSON.stringify(args));\n` +
          `fs.copyFileSync(process.env.FIXTURE_ARCHIVE, args[args.indexOf('--output') + 1]);\n` +
          `process.stdout.write(process.env.RESPONSE_STATUS);\n`,
        { mode: 0o700 },
      );
      const result = invoke([], {
        PATH: `${bin}:${process.env.PATH}`,
        ARGUMENT_LOG: log,
        FIXTURE_ARCHIVE: file,
        RESPONSE_STATUS: status,
      });
      const args = JSON.parse(await readFile(log, 'utf8'));
      assert.equal(args[0], '--disable', 'Ambient curl configuration must be ignored');
      assert.equal(args.at(-1), `https://dl.google.com/go/${archiveName}`);
      assert.equal(args[args.indexOf('--proto') + 1], '=https');
      assert.ok(!args.includes('--location'));
      if (status === '200') assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /without redirects/);
        assert.equal(result.stdout, '');
        await assert.rejects(stat(join(destination, 'go')), { code: 'ENOENT' });
      }
    });
  }
});

test('unsupported platforms and unsafe PATH roots fail before acquisition', async () => {
  await fixture(async ({ root, file, temporary, invoke, destination }) => {
    for (const path of ['relative', `${temporary}:other`, `${temporary}\nother`]) {
      const result = invoke([file], { RUNNER_TEMP: path });
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /Unsafe runner temporary path/);
    }
    const bin = join(root, 'platform');
    await mkdir(bin);
    await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf Darwin\\n\n', { mode: 0o700 });
    const result = invoke([file], { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires Linux x86_64/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  });
});

test('ambient tar checkpoint commands and gzip options cannot alter extraction', async () => {
  await fixture(async ({ root, file, invoke }) => {
    const marker = join(root, 'tar-executed');
    const command = join(root, 'tar-checkpoint');
    await writeFile(command, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
    const result = invoke([file], {
      TAR_OPTIONS: `--checkpoint=1 --checkpoint-action=exec=${command}`,
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  });
  await fixture(async ({ file, invoke }) => {
    const result = invoke([file], { GZIP: '--not-a-valid-gzip-option' });
    assert.equal(result.status, 0, result.stderr);
  });
});
