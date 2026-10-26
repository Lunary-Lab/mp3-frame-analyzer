"""Hosted exact-lock GuardDog controller. No package code is executed."""

import concurrent.futures
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# Python -I ignores cwd; load only this checked-in trusted helper explicitly.
spec = importlib.util.spec_from_file_location("guarddog_inputs", ROOT / "scripts/guarddog-inputs.py")
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


def scan_package(package, profile, scanner_root):
    return scan_bytes(package, profile, scanner_root, *inputs.package_inputs(package))


def scan_bytes(package, profile, scanner_root, metadata, archive, metadata_hash):
    import nono_py
    with tempfile.TemporaryDirectory(prefix="guarddog-package-") as temporary:
        work = Path(temporary)
        (work / "package.tgz").write_bytes(archive)
        (work / "metadata.json").write_text(json.dumps(metadata))
        (work / "request.json").write_text(json.dumps({"package": package, "profile": profile}))
        shutil.copyfile(ROOT / "scripts/guarddog-sandbox-worker.py", work / "worker.py")
        # Keep bundled caches unchanged. Unavailable popularity is not evaluated.
        # Any native initializer's refresh attempt is blocked by the kernel before
        # it can contact the internet; no fake freshness timestamps are written.
        shutil.copytree(scanner_root / "analyzer/metadata/resources", work / "popularity")
        caps = nono_py.CapabilitySet()
        for directory in {sys.prefix, sys.base_prefix, "/usr", "/lib", "/lib64", "/etc/ssl/certs"}:
            if Path(directory).exists():
                caps.allow_path(directory, nono_py.AccessMode.READ)
        caps.allow_path(str(work), nono_py.AccessMode.READ_WRITE)
        caps.block_network()
        environment = [
            ("HOME", str(work)), ("TMPDIR", str(work)), ("LANG", "C.UTF-8"),
            ("GUARDDOG_TOP_PACKAGES_CACHE_LOCATION", str(work / "popularity")),
            ("GUARDDOG_MAX_UNCOMPRESSED_SIZE", str(512 * 1024**2)),
            ("GUARDDOG_MAX_FILE_COUNT", "20000"), ("GUARDDOG_MAX_COMPRESSION_RATIO", "100"),
            ("GUARDDOG_PARALLELISM", "1"),
        ]
        result = nono_py.sandboxed_exec(
            caps, [sys.executable, "-I", "-B", str(work / "worker.py")], cwd=str(work),
            timeout_secs=180, env=environment, inherit_env=False,
            max_processes=16, max_cpu_seconds=120, max_file_size_bytes=512 * 1024**2, max_open_files=256,
        )
        inputs.require(len(result.stdout) + len(result.stderr) < 4 * 1024**2, "Worker output exceeded bound")
        inputs.require(result.exit_code == 0, "Native worker failed")
        inputs.require(not (work / "LIFECYCLE_EXECUTED").exists(), "Package lifecycle script executed")
        response = json.loads(result.stdout)
        inputs.require(response.get("complete") is True and response.get("sandbox") is True, "Incomplete worker result")
        inputs.require(response.get("scanner") == "3.2.0", "Worker version mismatch")
        return {"name": package["name"], "version": package["version"], "integrity": package["integrity"],
                "paths": package["paths"], "metadataSha256": metadata_hash, **response}


def main():
    inputs.require(importlib.metadata.version("guarddog") == "3.2.0", "Wrong GuardDog version")
    inputs.require(importlib.metadata.version("nono-py") == "0.16.0", "Wrong sandbox version")
    import nono_py
    inputs.require(nono_py.is_supported(), "Kernel sandbox unavailable; no download attempted")
    inputs.require("guarddog" not in sys.modules, "Unsafe import ordering")
    scanner_root = Path(importlib.metadata.distribution("guarddog").locate_file("guarddog"))
    lock_bytes = (ROOT / "package-lock.json").read_bytes()
    packages = inputs.locked_packages(json.loads(lock_bytes))
    profile = json.loads((ROOT / ".github/security/guarddog.json").read_text())
    inputs.require(profile["scannerVersion"] == "3.2.0" and profile["schemaVersion"] == 1, "Wrong profile version")
    inputs.require(profile["exceptions"] == [], "No finding exemptions have been reviewed yet")
    controls_spec = importlib.util.spec_from_file_location("guarddog_controls", ROOT / "scripts/guarddog-native-controls.py")
    controls = importlib.util.module_from_spec(controls_spec)
    controls_spec.loader.exec_module(controls)
    controls.verify(scan_bytes, profile, scanner_root)
    print(json.dumps({"nativeControls": True}), flush=True)
    results = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        pending = {executor.submit(scan_package, package, profile, scanner_root): package for package in packages}
        for future in concurrent.futures.as_completed(pending):
            package = pending[future]
            try:
                result = future.result()
                results.append(result)
                if result["findings"] or result["metadataFindings"]:
                    # No snippets, emails, registry payloads or worker stderr in public logs.
                    summary = {k: v for k, v in result.items() if k != "indicators"}
                    summary["sourceIndicators"] = len(result["indicators"])
                    print(json.dumps({"packageFinding": summary}), flush=True)
            except Exception as error:
                failure = {"name": package["name"], "version": package["version"], "errorType": type(error).__name__}
                failures.append(failure)
                print(json.dumps({"packageFailure": failure}), flush=True)
            if (len(results) + len(failures)) % 25 == 0:
                print(json.dumps({"processed": len(results) + len(failures), "expected": len(packages),
                                  "successful": len(results), "failed": len(failures)}), flush=True)
    identities = sorted(result["name"] + "@" + result["version"] for result in results)
    expected = sorted(package["name"] + "@" + package["version"] for package in packages)
    findings = sum(len(result["findings"]) for result in results)
    evidence = {"scanner": "GuardDog 3.2.0", "lockSha256": hashlib.sha256(lock_bytes).hexdigest(),
                "expectedPackages": len(packages), "completePackages": len(results), "failures": failures,
                "complete": identities == expected and not failures, "findings": findings,
                "unresolvedCapabilities": profile["unavailable"], "profileStatus": profile["status"],
                "accepted": False}
    print(json.dumps(evidence), flush=True)
    output = ROOT / "reports/security"
    output.mkdir(parents=True, exist_ok=True)
    (output / "guarddog-summary.json").write_text(json.dumps({**evidence, "packages": results}, indent=2))
    inputs.require(evidence["complete"], "Missing or failed package scans")
    inputs.require(not profile["unavailable"] and profile["status"] == "accepted", "Coverage profile unresolved")
    inputs.require(findings == 0, "Unreviewed GuardDog findings")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"accepted": False, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(2)
