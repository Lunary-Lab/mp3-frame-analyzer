"""Prove native readonly Go builds reject incomplete or substituted tool locks."""

import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOLS = {
    'actionlint': ('github.com/rhysd/actionlint/cmd/actionlint',
                   'github.com/rhysd/actionlint', 'github.com/mattn/go-shellwords'),
    'betterleaks': ('github.com/betterleaks/betterleaks',
                    'github.com/betterleaks/betterleaks', 'github.com/spf13/cobra'),
}


def environment():
    return {**os.environ, 'GOROOT': '', 'GOTOOLCHAIN': 'local', 'GOENV': 'off',
            'GOWORK': 'off', 'GOFLAGS': '', 'GOCACHEPROG': '', 'GOAUTH': 'off',
            'GOEXPERIMENT': '', 'GOFIPS140': 'off', 'GOOS': 'linux', 'GOARCH': 'amd64',
            'GOPROXY': 'off', 'GONOPROXY': '', 'GONOSUMDB': '', 'GOPRIVATE': '',
            'GOSUMDB': 'sum.golang.org', 'CGO_ENABLED': '0'}


def build(package, module, sums, diagnostic=None):
    with tempfile.TemporaryDirectory(prefix='mp3-go-lock-') as directory:
        root = pathlib.Path(directory)
        (root / 'go.mod').write_text(module)
        (root / 'go.sum').write_text(sums)
        output = root / 'tool'
        result = subprocess.run(
            ['go', 'build', '-mod=readonly', '-trimpath', '-p=2', '-o', str(output), package],
            cwd=root, env=environment(), capture_output=True, text=True, timeout=180, check=False,
        )
        if (root / 'go.mod').read_text() != module or (root / 'go.sum').read_text() != sums:
            raise RuntimeError('Readonly build changed a committed lock input')
        if diagnostic is None:
            if result.returncode or not output.is_file():
                raise RuntimeError('Complete offline graph must build first:\n' + result.stderr)
        elif result.returncode == 0 or output.exists() or diagnostic not in result.stderr:
            raise RuntimeError('Expected native Go rejection:\n' + result.stdout + result.stderr)


def verify(name):
    package, direct, transitive = TOOLS[name]
    source = ROOT / '.github/tools' / name
    module = (source / 'go.mod').read_text()
    sums = (source / 'go.sum').read_text()
    parsed = subprocess.run(
        ['go', 'mod', 'edit', '-json'], cwd=source, env=environment(),
        capture_output=True, text=True, timeout=30, check=True,
    )
    versions = {item['Path']: item['Version'] for item in json.loads(parsed.stdout)['Require']}
    with tempfile.TemporaryDirectory(prefix='mp3-go-cache-program-') as directory:
        root = pathlib.Path(directory)
        marker = root / 'executed'
        command = root / 'cache-command'
        command.write_text('#!/bin/sh\n: > ' + shlex.quote(str(marker)) + '\nexit 17\n')
        command.chmod(0o700)
        inherited = os.environ.get('GOCACHEPROG')
        inherited_root = os.environ.get('GOROOT')
        try:
            os.environ['GOCACHEPROG'] = str(command)
            os.environ['GOROOT'] = str(root / 'unreviewed-compiler')
            effective = subprocess.run(
                ['go', 'env', 'GOCACHEPROG'], env=environment(),
                capture_output=True, text=True, timeout=30, check=True,
            )
            if effective.stdout.strip():
                raise RuntimeError('External cache program must be disabled')
            build(package, module, sums)
            if marker.exists():
                raise RuntimeError('Inherited cache program executed')
        finally:
            if inherited is None:
                os.environ.pop('GOCACHEPROG', None)
            else:
                os.environ['GOCACHEPROG'] = inherited
            if inherited_root is None:
                os.environ.pop('GOROOT', None)
            else:
                os.environ['GOROOT'] = inherited_root
    for dependency in (direct, transitive):
        for suffix in ('', '/go.mod'):
            prefix = f'{dependency} {versions[dependency]}{suffix} h1:'
            entry = next(line for line in sums.splitlines() if line.startswith(prefix))
            build(package, module, sums.replace(entry + '\n', ''), 'missing go.sum entry')
            substituted = sums.replace(entry, prefix + 'A' * 43 + '=')
            build(package, module, substituted, 'checksum mismatch')

    omitted = '\n'.join(line for line in module.splitlines()
                        if not line.strip().startswith(transitive + ' ')) + '\n'
    build(package, omitted, sums, 'updates to go.mod needed')
    newer_toolchain = re.sub(r'^go .+$', 'go 1.99.0', module, flags=re.MULTILINE)
    build(package, newer_toolchain, sums, 'GOTOOLCHAIN=local')
    print(f'{name}: complete offline graph and ten native readonly rejection controls passed')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in TOOLS:
        raise ValueError('Expected actionlint or betterleaks')
    verify(sys.argv[1])
