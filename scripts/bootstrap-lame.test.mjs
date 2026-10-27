import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const names = ['lame_3.100.orig.tar.gz', 'lame_3.100-6build1.debian.tar.xz'];
async function fixture(run, probeExit = 0) {
  const root = await mkdtemp(join(tmpdir(), 'mp3-lame-bootstrap-'));
  try {
    const source = join(root, 'fixture/lame-3.100');
    const distro = join(root, 'fixture/debian/patches');
    const temporary = join(root, 'runner temp');
    await mkdir(join(source, 'frontend'), { recursive: true });
    await mkdir(distro, { recursive: true });
    await mkdir(temporary);
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, '.github/security'), { recursive: true });
    const script = join(root, 'scripts/bootstrap-lame.sh');
    await cp(new URL('./bootstrap-lame.sh', import.meta.url), script);
    await writeFile(
      join(source, 'frontend/parse.c'),
      `#include <stdio.h>\nint main(void) { puts("LAME version 3.099"); return ${probeExit}; }\n`,
    );
    await writeFile(
      join(source, 'configure'),
      "#!/bin/sh\nset -eu\ncat > Makefile <<'MAKE'\nall:\n\tmkdir -p frontend\n" +
        '\t$(CC) $(CFLAGS) ../frontend/parse.c $(LDFLAGS) -o frontend/lame\nMAKE\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(distro, '07-field-width-fix.patch'),
      '--- a/frontend/parse.c\n+++ b/frontend/parse.c\n@@ -1,2 +1,2 @@\n #include <stdio.h>\n' +
        `-int main(void) { puts("LAME version 3.099"); return ${probeExit}; }\n` +
        `+int main(void) { puts("LAME version 3.100"); return ${probeExit}; }\n`,
    );
    const files = names.map((name) => join(root, name));
    for (const [index, folder, flag] of [
      [0, 'lame-3.100', '-czf'],
      [1, 'debian', '-cJf'],
    ]) {
      const result = spawnSync('tar', [flag, files[index], '-C', join(root, 'fixture'), folder], {
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const digests = await Promise.all(
      files.map(async (file) =>
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ),
    );
    const pin = join(root, '.github/security/lame-sources.sha256');
    await writeFile(pin, names.map((name, i) => `${digests[i]}  ${name}\n`).join(''));
    const destination = join(temporary, `mp3-verified-lame-3.100-${digests.join('-')}`);
    const invoke = (args = files, extra = {}) =>
      spawnSync('bash', [script, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, RUNNER_TEMP: temporary, ...extra },
      });
    await run({ root, script, temporary, files, pin, digests, destination, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('LAME bootstrap verifies both sources, applies the selected patch and builds a fresh native encoder', async () => {
  await fixture(async ({ invoke, destination }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(destination, 'lame-3.100/build/frontend/lame'));
    const probe = spawnSync(result.stdout.trim(), ['--version'], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.match(probe.stdout, /version 3\.100/);
  });
});

test('both LAME hashes are mandatory before either source is extracted or built', async () => {
  for (const kind of [
    'missing',
    'weak',
    'duplicate',
    'source',
    'source-bytes',
    'patch-bytes',
    'symlink',
  ]) {
    await fixture(async ({ root, invoke, pin, files, digests, destination }) => {
      const records = await readFile(pin, 'utf8');
      if (kind === 'missing') await writeFile(pin, records.split('\n')[0] + '\n');
      if (kind === 'weak') await writeFile(pin, records.replace(digests[0], 'abcd'));
      if (kind === 'duplicate') await writeFile(pin, (records.split('\n')[0] + '\n').repeat(2));
      if (kind === 'source') await writeFile(pin, records.replace(names[1], 'unreviewed.tar.xz'));
      if (kind === 'source-bytes') await writeFile(files[0], 'substituted source');
      if (kind === 'patch-bytes') await writeFile(files[1], 'substituted patch');
      if (kind === 'symlink') {
        const other = join(root, 'other-pin');
        await writeFile(other, records);
        await rm(pin);
        await symlink(other, pin);
      }
      const result = invoke();
      assert.notEqual(result.status, 0, kind);
      assert.equal(result.stdout, '', kind);
      await assert.rejects(stat(join(destination, 'lame-3.100')), { code: 'ENOENT' });
      await assert.rejects(stat(join(destination, 'debian')), { code: 'ENOENT' });
    });
  }
});

test('LAME native extractors and build tools do not inherit execution or configuration hooks', async () => {
  await fixture(async ({ root, invoke }) => {
    const marker = join(root, 'hook-ran');
    const hook = join(root, 'hook');
    await writeFile(hook, `#!/bin/sh\nprintf observed > '${marker}'\n`, { mode: 0o700 });
    const result = invoke(undefined, {
      TAR_OPTIONS: `--checkpoint=1 --checkpoint-action=exec=${hook}`,
      GZIP: '--not-a-gzip-option',
      XZ_OPT: '--not-an-xz-option',
      XZ_DEFAULTS: '--invalid',
      CC: hook,
      CXX: hook,
      AR: hook,
      RANLIB: hook,
      CONFIG_SITE: hook,
      MAKEFLAGS: `--eval=$(shell ${hook})`,
      MFLAGS: '--invalid',
      MAKEFILES: hook,
      CFLAGS: '-include /unreviewed',
      CPPFLAGS: '-include /unreviewed',
      LDFLAGS: '/unreviewed',
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  });
});

test('LAME rejects occupied directories, files and links without touching their contents', async () => {
  for (const kind of ['directory', 'file', 'symlink']) {
    await fixture(async ({ root, destination, invoke }) => {
      const sentinel = join(root, 'sentinel');
      await writeFile(sentinel, 'keep');
      if (kind === 'directory') await mkdir(destination);
      if (kind === 'file') await writeFile(destination, 'keep');
      if (kind === 'symlink') await symlink(sentinel, destination);
      assert.notEqual(invoke().status, 0);
      assert.equal(await readFile(sentinel, 'utf8'), 'keep');
      if (kind === 'directory') assert.ok((await stat(destination)).isDirectory());
      else assert.equal(await readFile(destination, 'utf8'), 'keep');
    });
  }
});

test('LAME concurrent acquisitions have one exclusive native build owner', async () => {
  await fixture(async ({ script, files, temporary, destination }) => {
    const run = () =>
      promisify(execFile)('bash', [script, ...files], {
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

test('LAME rejects unsupported platforms and unsafe runner roots before acquisition', async () => {
  await fixture(async ({ root, files, temporary, invoke, destination }) => {
    assert.notEqual(invoke([files[0]]).status, 0);
    for (const path of [
      'relative',
      '/',
      `${temporary}:other`,
      `${temporary}\nother`,
      `${temporary}\rother`,
    ]) {
      assert.notEqual(invoke(files, { RUNNER_TEMP: path }).status, 0);
    }
    const bin = join(root, 'platform');
    await mkdir(bin);
    await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf Darwin\n\n', { mode: 0o700 });
    const result = invoke(files, { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires Linux x86_64/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  });
});

test('LAME downloads bind both exact official HTTPS URLs and reject redirects before extraction', async () => {
  for (const status of ['200', '302']) {
    await fixture(async ({ root, files, invoke, destination }) => {
      const bin = join(root, 'transport');
      await mkdir(bin);
      const log = join(root, 'arguments.jsonl');
      await writeFile(
        join(bin, 'curl'),
        `#!${process.execPath}\n` +
          `const fs=require('node:fs'); const args=process.argv.slice(2);\n` +
          `fs.appendFileSync(process.env.ARGUMENT_LOG,JSON.stringify(args)+'\\n');\n` +
          `const source=args.at(-1).endsWith('.xz') ? process.env.PATCH_ARCHIVE : process.env.SOURCE_ARCHIVE;\n` +
          `fs.copyFileSync(source,args[args.indexOf('--output')+1]); process.stdout.write(process.env.RESPONSE_STATUS);\n`,
        { mode: 0o700 },
      );
      const result = invoke([], {
        PATH: `${bin}:${process.env.PATH}`,
        ARGUMENT_LOG: log,
        SOURCE_ARCHIVE: files[0],
        PATCH_ARCHIVE: files[1],
        RESPONSE_STATUS: status,
      });
      const calls = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(calls.length, status === '200' ? 2 : 1);
      for (const [index, args] of calls.entries()) {
        assert.equal(args[0], '--disable');
        assert.equal(
          args.at(-1),
          `https://archive.ubuntu.com/ubuntu/pool/main/l/lame/${names[index]}`,
        );
        assert.equal(args[args.indexOf('--proto') + 1], '=https');
        assert.ok(!args.includes('--location'));
      }
      if (status === '200') assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
        await assert.rejects(stat(join(destination, 'lame-3.100')), { code: 'ENOENT' });
      }
    });
  }
});

test('correct-looking LAME version output with a failing native exit never publishes a binary', async () => {
  await fixture(async ({ invoke }) => {
    const result = invoke();
    assert.equal(result.status, 17);
    assert.equal(result.stdout, '');
  }, 17);
});

test('LAME composite publishes the successful exact binary and stops on bootstrap failure', async () => {
  const source = await readFile(
    new URL('../.github/actions/setup-lame-verified/action.yml', import.meta.url),
    'utf8',
  );
  const block = source
    .split('      run: |\n')[1]
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n');
  for (const status of [0, 17]) {
    const root = await mkdtemp(join(tmpdir(), 'lame-action-'));
    try {
      await mkdir(join(root, 'scripts'));
      const binary = join(root, 'path with spaces/lame');
      await writeFile(
        join(root, 'scripts/bootstrap-lame.sh'),
        `printf '%s\\n' '${binary}'\nexit ${status}\n`,
      );
      const output = join(root, 'output');
      await writeFile(output, '');
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', block], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, status);
      assert.equal(await readFile(output, 'utf8'), status === 0 ? `binary=${binary}\n` : '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
