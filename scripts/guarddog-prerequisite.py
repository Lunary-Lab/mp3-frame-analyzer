"""Prove the real pinned sandbox on the hosted runner, before importing GuardDog.

This is a prerequisite probe, NOT a dependency scan or a clean-security result.
Only synthetic files and a local loopback listener are used. No npm downloads.
"""

import importlib.metadata
import json
from pathlib import Path
import resource
import socket
import sys
import tempfile


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    require(importlib.metadata.version("guarddog") == "3.2.0", "Wrong GuardDog version")
    require(importlib.metadata.version("nono-py") == "0.16.0", "Wrong sandbox version")
    import nono_py

    supported = nono_py.is_supported()
    print(json.dumps({"guarddog": "3.2.0", "nono-py": "0.16.0", "sandboxSupported": supported}), flush=True)
    require(supported, "Required kernel sandbox is unavailable; no dependency scan attempted")
    require("guarddog" not in sys.modules, "GuardDog initialized before prerequisite")
    # The parent workflow sets a clean environment. Limit this probe as defense in depth.
    resource.setrlimit(resource.RLIMIT_AS, (3 * 1024**3, 3 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024**2, 16 * 1024**2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    # Keep cleanup outside the irreversible sandbox. A child applies actual native
    # capabilities, with separate allowed/forbidden directories and no inherited token.
    with tempfile.TemporaryDirectory(prefix="guarddog-prerequisite-") as temporary:
        allowed = Path(temporary, "allowed")
        forbidden = Path(temporary, "forbidden")
        allowed.mkdir()
        forbidden.mkdir()
        (allowed / "read.txt").write_text("synthetic allowed")
        (forbidden / "read.txt").write_text("synthetic forbidden")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(4)
            port = listener.getsockname()[1]
            # Prove the target really is reachable before asking for a denial.
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                pass
            caps = nono_py.CapabilitySet()
            for path in {sys.prefix, sys.base_prefix, "/usr", "/lib", "/lib64"}:
                if Path(path).exists():
                    caps.allow_path(path, nono_py.AccessMode.READ)
            caps.allow_path(str(allowed), nono_py.AccessMode.READ_WRITE)
            caps.block_network()
            code = '''
import errno, json, socket
from pathlib import Path
allowed, forbidden, port = __import__('sys').argv[1:]
assert (Path(allowed) / 'read.txt').read_text() == 'synthetic allowed'
(Path(allowed) / 'write.txt').write_text('synthetic write')
def denied(operation):
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM), error.errno
    else:
        raise AssertionError('Missing kernel permission denial')
denied(lambda: (Path(forbidden) / 'read.txt').read_text())
denied(lambda: (Path(forbidden) / 'write.txt').write_text('not allowed'))
denied(lambda: socket.create_connection(('127.0.0.1', int(port)), timeout=2))
print(json.dumps({'filesystemDenied': True, 'networkDenied': True, 'allowedIO': True}))
'''
            result = nono_py.sandboxed_exec(
                caps, [sys.executable, "-I", "-B", "-c", code, str(allowed), str(forbidden), str(port)],
                cwd=str(allowed), timeout_secs=30, inherit_env=False,
                env=[("HOME", str(allowed)), ("LANG", "C.UTF-8")],
                max_processes=8, max_cpu_seconds=30, max_file_size_bytes=1024**2, max_open_files=64,
            )
            require(result.exit_code == 0, "Native sandbox probe failed (no dependency scan attempted)")
            result = json.loads(result.stdout)
            require(result == {"filesystemDenied": True, "networkDenied": True, "allowedIO": True},
                    "Malformed sandbox evidence")
            print(json.dumps({"prerequisiteComplete": True, "dependencyScanAttempted": False, **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"prerequisiteComplete": False, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(2)
