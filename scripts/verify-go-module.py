"""Check the supported acquisition profile using Go's own read-only JSON parser."""

import json
import os
import pathlib
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
VERSION = '1.27.3'


def require_profile(module):
    if not isinstance(module, dict):
        raise ValueError('Missing native Go module object')
    supported = {'Module', 'Go', 'Toolchain', 'Godebug', 'Require',
                 'Exclude', 'Replace', 'Retract', 'Tool', 'Ignore'}
    if set(module) - supported:
        raise ValueError('Unsupported native Go module schema; review before acquisition')
    if module.get('Go') != VERSION:
        raise ValueError('Module must declare the reviewed Go version')
    if module.get('Toolchain') not in (None, '', 'go' + VERSION):
        raise ValueError('Unsupported toolchain selector; automatic toolchain acquisition is forbidden')
    if module.get('Replace') or module.get('Exclude'):
        raise ValueError('Replace/Exclude require a separate source-integrity policy')
    identity = module.get('Module')
    if not isinstance(identity, dict) or not isinstance(identity.get('Path'), str) or not identity['Path']:
        raise ValueError('Missing module identity')
    requirements = module.get('Require')
    if not isinstance(requirements, list) or not requirements:
        raise ValueError('Missing native requirement inventory')
    for requirement in requirements:
        if not isinstance(requirement, dict) or any(
                not isinstance(requirement.get(field), str) or not requirement[field]
                for field in ('Path', 'Version')):
            raise ValueError('Malformed native requirement inventory')


def native_profile(directory):
    environment = {**os.environ, 'GOTOOLCHAIN': 'local', 'GOENV': 'off',
                   'GOWORK': 'off', 'GOFLAGS': '', 'GOPROXY': 'off', 'GOCACHEPROG': '',
                   'GOAUTH': 'off'}
    result = subprocess.run(['go', 'mod', 'edit', '-json'], cwd=directory,
                            env=environment, capture_output=True, text=True,
                            timeout=30, check=True)
    return json.loads(result.stdout)


def verify(directory):
    path = (ROOT / directory).absolute()
    resolved = path.resolve(strict=True)
    if resolved != path or not resolved.is_relative_to(ROOT):
        raise ValueError('Go tool modules must use regular repository source paths')
    for name in ('go.mod', 'go.sum'):
        file = path / name
        if file.is_symlink() or not file.is_file():
            raise ValueError('Missing or symlinked Go lock input: ' + name)
    require_profile(native_profile(path))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise ValueError('Expected one repository-relative Go module directory')
    verify(sys.argv[1])
    print('Native Go module acquisition profile accepted')
