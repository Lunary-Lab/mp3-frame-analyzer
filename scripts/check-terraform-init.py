"""Exercise native lock enforcement with a harmless filesystem-only fake package.

Only init is invoked: never validate/test/plan/apply or a real provider. This is
untraced; marker absence is not a proof of zero network or syscall activity.
"""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


SOURCE = '''terraform {
  required_providers {
    fake = {
      source = "example.invalid/fixture/fake"
      version = "1.0.0"
    }
  }
}
'''
LOCK = '''provider "example.invalid/fixture/fake" {
  version = "1.0.0"
  constraints = "1.0.0"
'''


def run_case(root, name, binary, gate, lock=None):
    directory = root / name
    for child in ("source", "home", "data"):
        (directory / child).mkdir(parents=True)
    (directory / "source/main.tf").write_text(SOURCE)
    lock_path = directory / "source/.terraform.lock.hcl"
    if lock is not None:
        lock_path.write_bytes(lock)
    env = {
        "PATH": "/usr/bin:/bin", "HOME": str(directory / "home"),
        "TF_DATA_DIR": str(directory / "data"),
        "TF_CLI_CONFIG_FILE": str(root / "terraform.rc"),
        "CHECKPOINT_DISABLE": "1", "TF_WORKSPACE": "default",
        "MARKER_FILE": str(root / "executed"),
    }
    args = [str(binary), f"-chdir={directory / 'source'}", "init",
            "-backend=false", "-input=false", "-get=false", "-json"]
    if lock is not None:
        args.append("-lockfile=readonly")
    result = subprocess.run(args, env=env, capture_output=True, timeout=10)
    assert not (root / "executed").exists(), "The harmless marker was unexpectedly executed"
    expected = 1 if name == "wrong" else 0
    assert result.returncode == expected, (name, result.returncode, result.stdout, result.stderr)
    if lock is None:
        assert b'"h1:' in lock_path.read_bytes(), "Native init did not generate a checksum"
        return lock_path.read_bytes()

    assert lock_path.read_bytes() == lock, f"{name}: readonly init changed its lock"
    diagnostics = [item["diagnostic"] for item in map(json.loads, result.stdout.splitlines())
                   if item.get("type") == "diagnostic"]
    if name == "hashless":
        assert [(d["severity"], d["summary"]) for d in diagnostics] == [
            ("warning", "Provider lock file not updated")], diagnostics
    elif name == "wrong":
        assert len(diagnostics) == 1 and diagnostics[0]["severity"] == "error", diagnostics
        assert diagnostics[0]["summary"] == "Failed to install provider", diagnostics
        assert "doesn't match any of the checksums" in diagnostics[0]["detail"], diagnostics
    else:
        assert not diagnostics, diagnostics
    checked = subprocess.run(
        ["/usr/bin/jq", "-e", "-s", "-f", str(gate)], input=result.stdout,
        env={"TERRAFORM_VERSION": os.environ["TERRAFORM_VERSION"]},
        capture_output=True, timeout=3,
    )
    assert checked.returncode == (0 if name == "valid" else 1), (name, checked.stderr)
    print(json.dumps({"case": name, "nativeExit": result.returncode,
                      "gateExit": checked.returncode, "lockUnchanged": True,
                      "markerAbsent": True, "traced": False}))
    return lock


def main():
    binary, gate = (Path(argument).resolve(strict=True) for argument in sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix="terraform-init-integrity-") as temporary:
        root = Path(temporary)
        mirror = root / "mirror"
        archive = mirror / "example.invalid/fixture/fake/terraform-provider-fake_1.0.0_linux_amd64.zip"
        archive.parent.mkdir(parents=True)
        entry = zipfile.ZipInfo("terraform-provider-fake_v1.0.0")
        entry.create_system, entry.external_attr = 3, 0o100755 << 16
        with zipfile.ZipFile(archive, "w") as packed:
            packed.writestr(entry, '#!/bin/sh\nprintf executed >> "$MARKER_FILE"\nexit 99\n')
        (root / "terraform.rc").write_text(
            'provider_installation {\n  filesystem_mirror {\n'
            f'    path = {json.dumps(str(mirror))}\n'
            '    include = ["example.invalid/fixture/fake"]\n  }\n}\n'
        )  # Explicit filesystem-only installation; no registry fallback.
        valid = run_case(root, "seed", binary, gate)
        run_case(root, "valid", binary, gate, valid)
        wrong = LOCK + '  hashes = ["h1:' + base64.b64encode(bytes(32)).decode() + '"]\n}\n'
        run_case(root, "wrong", binary, gate, wrong.encode())
        run_case(root, "hashless", binary, gate, (LOCK + "}\n").encode())


if __name__ == "__main__":
    main()
