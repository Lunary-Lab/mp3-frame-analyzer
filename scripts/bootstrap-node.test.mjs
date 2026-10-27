import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

// Fixed harmless shell executables; official release archives are replayed separately.
const fixtures = {
  '24.22.1': {
    digest: '32b1e238796f6eafc866904bf07777f94833d50d4a56a50ec40c86707cc26fc8',
    bytes:
      'H4sIAAAAAAACA+3SW0vDMBQH8D7nUxw73R4ka5puEwSFMocr6Fq0T14QdREDkkkvo+j23U3rNi/P4oP+fy8n5xLOQ2JmU8XnsteVsuvzJ23KileDnnenjWdsz/kBwtrr95tofY8ikJvee90PxCBwSDi/oMyL28yud/6n1lbz1PkjuyR3u+XSAfl0Te021blf55zPVZbrmbH1xYJUpQuSdpy/2InXSXw0uomTNIon57vVclVIwnT8kQ3j0yQ6sTEcjkdNOQ3Pvlw6vogSe3A/rQjYPh3WG8TO5jcuPVWp+7JQU5c9Z9oUD9RZf94r02HNRcEcAAAAAAAAAAAAAAAAAAAAAACAv+8NVVEEWgAoAAA=',
  },
  '26.12.1': {
    digest: '86eec00e90cbf6533b2844c37e9ebb6565b6297baa252c869a5426ec168bc050',
    bytes:
      'H4sIAAAAAAACA+3SW0vDMBQH8DznUxw73R4ka9JuFQSFMocr6Fq0T14QdRELkkkvo+j23U2rzsuz+KD/38vJuYTzkJj5TIuFF/SV11fiITNVLepg4N5kxjW2x36AtHaGwzZa36P0vXXvta58GQwYSfYLqqK8zu169j91NtqnLu75OTmbHYf2SNEldbvU5KrJhVjovMjmxtaXS9J1VpJnx8WTnXiexgfjqzhJo3h6ul2v3gpJmE4+slF8nERHNoajybgtp+HJl0uHZ1FiD86nFT7fpf1mg9xa/8aVq2t9W5V65vDHPDPlHfXeP++F6fH2ouQMAAAAAAAAAAAAAAAAAAAAAADg73sBeAJt6wAoAAA=',
  },
};
const failedProbe = {
  digest: '5aa93f9b4e6006b6d9f8959f1451601cb4ed1e5a06c887e173246de02424c8c2',
  bytes:
    'H4sIAAAAAAACA+3Sy0rDQBQG4KznKY6ptguZZnJpCoJCqMUGtAmalRdE7YgBmUouZdD23Z0E26prcaH/tzmXOcNZzKj5TPKFF/Q9r+/y51zVmuswcO5z5ShzZv0AYQwHgzYa36PwvXCTt33XF2FgkbB+QV1Wd4VZb/1PnZ32qcsndkX2bsemQ3Lphrpdamq3qTlfyKLM58r0l0uSOq/IM+P81Uy8TZPj8W2SZnEyvdjXq49GGmWTbTVKztL41MRoNBm37Sw6/3Lp5DJOTWJ/WuGzAzpqNoi9zW9cOVLLh7qSM5u9FLmqHqm3/rzXqsfai+6QWQAAAAAAAAAAAAAAAAAAAAAAAH/eOzXsXIMAKAAA',
};

async function fixture(run, version = '24.22.1', release = fixtures[version]) {
  const root = await mkdtemp(join(tmpdir(), 'mp3-node-bootstrap-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, '.github/security'), { recursive: true });
    const temporary = join(root, 'runner temp');
    await mkdir(temporary);
    const script = join(root, 'scripts/bootstrap-node.sh');
    await writeFile(script, await readFile(new URL('./bootstrap-node.sh', import.meta.url)));
    const pin = join(root, '.github/security/node-archives.sha256');
    const records = Object.keys(fixtures).map(
      (selected) =>
        `${selected === version ? release.digest : fixtures[selected].digest}  node-v${selected}-linux-x64.tar.gz`,
    );
    await writeFile(pin, `${records.join('\n')}\n`);
    const file = join(root, 'archive.tar.gz');
    await writeFile(file, Buffer.from(release.bytes, 'base64'));
    const destination = join(temporary, `mp3-verified-node-${version}-${release.digest}`);
    const invoke = (args = [version, file], extra = {}) =>
      spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, RUNNER_TEMP: temporary, ...extra },
      });
    await run({ root, temporary, script, pin, file, destination, invoke, version });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('both reviewed Node archives publish only their deterministic verified runtime root', async () => {
  for (const version of Object.keys(fixtures)) {
    await fixture(async ({ invoke, destination }) => {
      const result = invoke();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), join(destination, `node-v${version}-linux-x64`));
      assert.ok((await stat(join(result.stdout.trim(), 'executed'))).isFile());
    }, version);
  }
});

test('correct-looking stdout from a failed Node probe never publishes a runtime', async () => {
  await fixture(
    async ({ invoke }) => {
      const result = invoke();
      assert.equal(result.status, 17);
      assert.equal(result.stdout, '');
    },
    '24.22.1',
    failedProbe,
  );
});

test('missing, weak, duplicate, wrong-source and substituted Node pins fail closed', async () => {
  for (const kind of ['missing', 'weak', 'duplicate', 'source', 'tampered', 'symlink']) {
    await fixture(async ({ root, invoke, pin, file, destination }) => {
      const records = await readFile(pin, 'utf8');
      if (kind === 'missing') await writeFile(pin, '');
      if (kind === 'weak')
        await writeFile(pin, records.replace(fixtures['24.22.1'].digest, 'abcd'));
      if (kind === 'duplicate') await writeFile(pin, `${records.split('\n')[0]}\n`.repeat(2));
      if (kind === 'source')
        await writeFile(pin, records.replace('node-v24.22.1-linux-x64', 'other'));
      if (kind === 'tampered') await writeFile(file, 'substituted archive');
      if (kind === 'symlink') {
        const other = join(root, 'unreviewed-pin');
        await writeFile(other, records);
        await rm(pin);
        await symlink(other, pin);
      }
      const result = invoke();
      assert.notEqual(result.status, 0, kind);
      assert.equal(result.stdout, '', kind);
      await assert.rejects(stat(join(destination, 'node-v24.22.1-linux-x64')), { code: 'ENOENT' });
    });
  }
});

test('occupied Node destinations are never followed, reused or removed', async () => {
  for (const kind of ['directory', 'file', 'symlink']) {
    await fixture(async ({ root, invoke, destination }) => {
      const sentinel = join(root, 'untouched');
      await writeFile(sentinel, 'keep');
      if (kind === 'directory') await mkdir(destination);
      if (kind === 'file') await writeFile(destination, 'keep');
      if (kind === 'symlink') await symlink(sentinel, destination);
      assert.notEqual(invoke().status, 0, kind);
      assert.equal(await readFile(sentinel, 'utf8'), 'keep');
      if (kind === 'directory') assert.ok((await stat(destination)).isDirectory());
      else assert.equal(await readFile(destination, 'utf8'), 'keep');
    });
  }
});

test('concurrent Node acquisitions have exactly one exclusive owner', async () => {
  await fixture(async ({ script, file, temporary, destination, version }) => {
    const run = () =>
      promisify(execFile)('bash', [script, version, file], {
        env: { ...process.env, RUNNER_TEMP: temporary },
        timeout: 30_000,
      }).then(
        () => 0,
        (error) => error.code,
      );
    assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 1]);
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
  });
});

test('Node download uses only the bound HTTPS source and rejects redirects', async () => {
  for (const status of ['200', '302']) {
    await fixture(async ({ root, file, invoke, destination, version }) => {
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
      const result = invoke([version], {
        PATH: `${bin}:${process.env.PATH}`,
        ARGUMENT_LOG: log,
        FIXTURE_ARCHIVE: file,
        RESPONSE_STATUS: status,
      });
      const args = JSON.parse(await readFile(log, 'utf8'));
      assert.equal(args[0], '--disable');
      assert.equal(
        args.at(-1),
        `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.gz`,
      );
      assert.equal(args[args.indexOf('--proto') + 1], '=https');
      assert.ok(!args.includes('--location'));
      if (status === '200') assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        await assert.rejects(stat(join(destination, `node-v${version}-linux-x64`)), {
          code: 'ENOENT',
        });
      }
    });
  }
});

test('unsupported Node versions, platforms and unsafe PATH roots fail before acquisition', async () => {
  await fixture(async ({ root, file, temporary, invoke, destination, version }) => {
    assert.notEqual(invoke(['24', file]).status, 0);
    for (const path of [
      'relative',
      `${temporary}:other`,
      `${temporary}\nother`,
      `${temporary}\rother`,
    ]) {
      const result = invoke([version, file], { RUNNER_TEMP: path });
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /Unsafe runner temporary path/);
    }
    const bin = join(root, 'platform');
    await mkdir(bin);
    await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf Darwin\\n\n', { mode: 0o700 });
    const result = invoke([version, file], { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires Linux x86_64/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  });
});

test('ambient extractor and Node preload/cache options cannot alter initial probes', async () => {
  await fixture(async ({ root, invoke }) => {
    const marker = join(root, 'executed-hook');
    const command = join(root, 'tar-checkpoint');
    await writeFile(command, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
    const result = invoke(undefined, {
      TAR_OPTIONS: `--checkpoint=1 --checkpoint-action=exec=${command}`,
      GZIP: '--not-a-valid-gzip-option',
      NODE_OPTIONS: '--require=/unreviewed',
      NODE_PATH: '/unreviewed',
      NODE_COMPILE_CACHE: '/unreviewed',
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  });
});

test('Node composite rejects unreviewed inherited process settings before invoking acquisition', async () => {
  const source = await readFile(
    new URL('../.github/actions/setup-node-verified/action.yml', import.meta.url),
    'utf8',
  );
  const block = source
    .split('      run: |\n')[1]
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n');
  for (const setting of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_COMPILE_CACHE',
    'NODE_DISABLE_COMPILE_CACHE',
  ]) {
    const env = {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      NODE_COMPILE_CACHE: '',
      NODE_DISABLE_COMPILE_CACHE: '1',
    };
    env[setting] = setting === 'NODE_DISABLE_COMPILE_CACHE' ? '0' : '/unreviewed';
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', block], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1, setting);
    assert.equal(result.stdout, '', setting);
    assert.equal(result.stderr, '', setting);
  }
});

test('Node composite publishes the verified path only after a successful clean-profile acquisition', async () => {
  await fixture(async ({ root, file, destination, version }) => {
    const source = await readFile(
      new URL('../.github/actions/setup-node-verified/action.yml', import.meta.url),
      'utf8',
    );
    const block = source
      .split('      run: |\n')[1]
      .split('\n')
      .map((line) => line.replace(/^ {8}/, ''))
      .join('\n');
    const transport = join(root, 'transport');
    await mkdir(transport);
    await writeFile(
      join(transport, 'curl'),
      '#!/bin/sh\n' +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = --output ]; then shift; output="$1"; fi\n' +
        '  shift\ndone\ncp "$FIXTURE_ARCHIVE" "$output"\nprintf 200\n',
      { mode: 0o700 },
    );
    const pathFile = join(root, 'github-path');
    const outputFile = join(root, 'github-output');
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', block], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${transport}:${process.env.PATH}`,
        RUNNER_TEMP: join(root, 'runner temp'),
        NODE_VERSION: version,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        NODE_COMPILE_CACHE: '',
        NODE_DISABLE_COMPILE_CACHE: '1',
        FIXTURE_ARCHIVE: file,
        GITHUB_PATH: pathFile,
        GITHUB_OUTPUT: outputFile,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const verified = join(destination, `node-v${version}-linux-x64`);
    assert.equal(await readFile(pathFile, 'utf8'), `${verified}/bin\n`);
    assert.equal(await readFile(outputFile, 'utf8'), `root=${verified}\n`);
  });
});
