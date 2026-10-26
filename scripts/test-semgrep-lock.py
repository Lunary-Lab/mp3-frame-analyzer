"""Exercise native pip's complete, hash-required wheel acquisition offline."""

import hashlib
import io
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile


LOCK = pathlib.Path(__file__).resolve().parent.parent / '.github/security/semgrep-requirements.txt'


def download(wheels, requirements):
    with tempfile.TemporaryDirectory(prefix='mp3-semgrep-lock-') as directory:
        root = pathlib.Path(directory)
        lock = root / 'requirements.txt'
        lock.write_text(requirements)
        return subprocess.run(
            [sys.executable, '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check',
             'download', '--no-index', '--find-links', str(wheels), '--require-hashes',
             '--only-binary=:all:', '--no-cache-dir', '--dest', str(root / 'downloads'),
             '--requirement', str(lock)],
            env={**os.environ, 'PIP_CONFIG_FILE': os.devnull,
                 'PIP_INDEX_URL': 'https://unused.invalid/simple',
                 'PIP_EXTRA_INDEX_URL': 'https://unused.invalid/simple',
                 'PIP_NO_BINARY': ':all:', 'PIP_NO_REQUIRE_HASHES': 'true'},
            capture_output=True, text=True, timeout=120, check=False,
        )


def rejects(wheels, requirements, diagnostic):
    result = download(wheels, requirements)
    if result.returncode == 0 or not re.search(diagnostic, result.stderr, re.IGNORECASE):
        raise RuntimeError('Expected native pip rejection:\n' + result.stdout + result.stderr)


def wheel(directory, name, dependency=''):
    path = directory / f'{name}-1.0.0-py3-none-any.whl'
    info = f'{name}-1.0.0.dist-info'
    metadata = f'Metadata-Version: 2.1\nName: {name}\nVersion: 1.0.0\n'
    if dependency:
        metadata += f'Requires-Dist: {dependency}==1.0.0\n'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr(f'{info}/METADATA', metadata)
        archive.writestr(f'{info}/WHEEL', 'Wheel-Version: 1.0\nTag: py3-none-any\n')
        archive.writestr(f'{info}/RECORD', '')
    return f'{name}==1.0.0 --hash=sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}\n'


def verify(wheels, requirements):
    result = download(wheels, requirements)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    print('Semgrep lock: complete offline wheel graph passed')
    small = next(line for line in requirements.splitlines() if line.startswith('annotated-types=='))
    package = small.split(' --hash=')[0]
    rejects(wheels, package + ' --hash=sha256:' + '0' * 64, 'do not match the hashes')
    rejects(wheels, package, 'hashes are required')
    omitted = '\n'.join(line for line in requirements.splitlines()
                        if not line.startswith('typing-extensions=='))
    rejects(wheels, omitted, 'must have their versions pinned|hashes are required')
    print('Semgrep lock: wrong/missing hash and omitted transitive rejected')

    with tempfile.TemporaryDirectory(prefix='mp3-semgrep-negative-') as directory:
        root = pathlib.Path(directory)
        original = next(wheels.glob('annotated_types-*.whl'))
        (root / original.name).write_bytes(original.read_bytes() + b'\0')
        rejects(root, small, 'do not match the hashes')

        locked_root = wheel(root, 'locked_root', 'new_transitive')
        wheel(root, 'new_transitive')
        rejects(root, locked_root, 'hashes are required')
        print('Semgrep lock: tampered archive and newly introduced transitive rejected')

        source = root / 'source_only-1.0.0.tar.gz'
        marker = root / 'build-executed'
        files = {
            'pyproject.toml': '[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n',
            'backend.py': f'from pathlib import Path\nPath({str(marker)!r}).touch()\nraise RuntimeError("source build executed")\n',
        }
        with tarfile.open(source, 'w:gz') as archive:
            for name, contents in files.items():
                data = contents.encode()
                entry = tarfile.TarInfo(f'source_only-1.0.0/{name}')
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        source_lock = f'source-only==1.0.0 --hash=sha256:{hashlib.sha256(source.read_bytes()).hexdigest()}\n'
        rejects(root, source_lock, 'no matching distribution found')
        if marker.exists():
            raise RuntimeError('pip executed the source build backend')
        print('Semgrep lock: source-only distribution rejected without build execution')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise ValueError('Expected the verified offline wheel directory')
    verify(pathlib.Path(sys.argv[1]).resolve(strict=True), LOCK.read_text())
