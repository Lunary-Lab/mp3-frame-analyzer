"""Trusted worker launched by nono's native sandbox; never executed unsandboxed.

Input archives have already passed SHA512. We recheck it before any extraction.
All source/metadata analysis is network-blocked; package code never executes.
"""

import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import stat
import sys
import tarfile

DIAGNOSTIC = {"stage": "startup"}


class PolicyError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PolicyError(message)


def check_archive(archive, package):
    seen = set()
    roots = set()
    total = 0
    allowed_roots = {"package", package["name"].rsplit("/", 1)[-1]}
    if package["name"].startswith("@types/"):
        # Older DefinitelyTyped npm tar prefixes include their major.minor line.
        allowed_roots.add(package["name"].split("/", 1)[1] + " v" + ".".join(package["version"].split(".")[:2]))
    # Parsing and extraction both happen inside the kernel sandbox and hard limits.
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            require(len(seen) < 20000, "Archive entry count exceeded")
            require(member.name not in seen, "Duplicate archive entry")
            seen.add(member.name)
            parts = member.name.rstrip("/").split("/")
            DIAGNOSTIC["archiveRoot"] = parts[0][:100]
            require(parts[0] in allowed_roots
                    and all(p not in ("", ".", "..") for p in parts), "Unsafe archive path")
            roots.add(parts[0])
            require(len(roots) == 1, "Mixed package archive roots")
            require(not member.name.startswith("/") and "\\" not in member.name, "Unsafe member name")
            require(member.isfile() or member.isdir(), "Links or special archive members are forbidden")
            total += member.size
            require(total <= 512 * 1024**2, "Extracted byte budget exceeded")
    require(seen and total > 0, "Empty archive")
    require(total <= archive.stat().st_size * 100, "Compression ratio budget exceeded")
    return next(iter(roots))


def verified_files(directory):
    files = {}
    def failure(error):
        raise error
    for root, directories, names in os.walk(directory, followlinks=False, onerror=failure):
        for name in directories + names:
            path = Path(root, name)
            require(not path.is_symlink(), "Extracted symlink")
        for name in names:
            path = Path(root, name)
            require(stat.S_ISREG(path.lstat().st_mode), "Nonregular extracted file")
            files[str(path.relative_to(directory))] = hashlib.sha256(path.read_bytes()).hexdigest()
    require(files, "Empty extracted tree")
    return files


def metadata_evidence(analyzer, result, metadata, package, directory, files):
    evidence = {}
    if result["results"].get("bundled_binary"):
        detector = analyzer.metadata_detectors["bundled_binary"]
        evidence["bundled_binary"] = [
            {"path": path, "kind": kind, "sha256": digest}
            for path, digest in sorted(files.items())
            if (kind := detector.is_binary(str(directory / path)))
        ]
    if result["results"].get("metadata_mismatch"):
        from guarddog.analyzer.metadata.npm.metadata_mismatch import _load_package_manifest, difference_at_key, MANIFEST_FIELDS_CHECKLIST
        manifest = _load_package_manifest(str(directory), package["name"])
        details = metadata["versions"][package["version"]]
        # Hash exact differing values, but expose only affected field/key identities.
        evidence["metadata_mismatch"] = sorted([
            {"field": field, "key": key,
             "registrySha256": hashlib.sha256(json.dumps(left, sort_keys=True).encode()).hexdigest(),
             "archiveSha256": hashlib.sha256(json.dumps(right, sort_keys=True).encode()).hexdigest()}
            for field, typ in MANIFEST_FIELDS_CHECKLIST.items()
            for key, left, right in difference_at_key(details, manifest, field, typ)
        ], key=lambda item: (item["field"], item["key"]))
    if result["results"].get("provenance_regression"):
        detector = analyzer.metadata_detectors["provenance_regression"]
        prior = detector._most_recent_attested_before(metadata, package["version"])
        evidence["provenance_regression"] = {"priorAttestedVersion": prior,
            "priorAttestation": metadata["versions"][prior]["dist"]["attestations"],
            "currentVersion": package["version"], "currentAttestationPresent": False}
    return evidence


def analyze(request, directory, files):
    from guarddog.analyzer.analyzer import Analyzer
    from guarddog.analyzer.sourcecode import get_sourcecode_rules
    from guarddog.analyzer.metadata import get_metadata_detectors
    from guarddog.ecosystems import ECOSYSTEM

    profile = request["profile"]
    actual_source = sorted(rule.id for rule in get_sourcecode_rules(ECOSYSTEM.NPM))
    actual_metadata = sorted(get_metadata_detectors(ECOSYSTEM.NPM))
    require(actual_source == profile["sourceRules"], "Native source-rule inventory changed")
    require(actual_metadata == sorted(profile["metadataRules"] + [x["rule"] for x in profile["unavailable"]]),
            "Native metadata-rule inventory changed")
    analyzer = Analyzer(ECOSYSTEM.NPM)
    package = request["package"]
    metadata = json.loads(Path("metadata.json").read_text())
    source = analyzer.analyze_sourcecode(str(directory), set(profile["sourceRules"]))
    result = analyzer.analyze_metadata(str(directory), metadata, set(profile["metadataRules"]), package["name"], package["version"])
    for output, rules in [(source, profile["sourceRules"]), (result, profile["metadataRules"])]:
        require(output["errors"] == {}, "Native detector error")
        require(sorted(output["results"]) == rules, "Incomplete native detector results")
    score = analyzer.calculate_package_risk_score(source, result)
    risks = analyzer.format_risks(score.pop("_risks", []), source)
    details = metadata_evidence(analyzer, result, metadata, package, directory, files)
    findings = []
    for risk in risks:
        path = risk["file_path"] or "$metadata"
        require(path == "$metadata" or path in files, "Finding outside extracted inventory")
        findings.append({"rule": risk["threat_rule"], "capabilityRule": risk["capability_rule"],
                         "path": path, "severity": risk["severity"],
                         "fileSha256": files.get(path), "location": risk["threat_location"],
                         "contextSha256": files.get(path) or hashlib.sha256(
                             json.dumps(details.get(risk["threat_rule"], result["results"].get(risk["threat_rule"])),
                                        sort_keys=True).encode()).hexdigest()})
    indicators = []
    for rule, hits in source["results"].items():
        require(isinstance(hits, (list, dict)), "Malformed source result")
        if isinstance(hits, dict):
            require(hits == {}, "Malformed empty source result")
        for hit in hits:
            location = hit["location"]
            path = location.rsplit(":", 1)[0]
            require(path in files, "Indicator outside extraction")
            indicators.append({"rule": rule, "location": location, "fileSha256": files[path]})
    return {"score": score["score"], "label": score["label"], "findings": findings,
            "indicators": indicators, "metadataFindings": sorted(k for k, v in result["results"].items() if v), "metadataEvidence": details}


def main():
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    require(importlib.metadata.version("guarddog") == "3.2.0", "Wrong scanner version")
    request = json.loads(Path("request.json").read_text())
    archive = Path("package.tgz")
    DIAGNOSTIC["stage"] = "integrity"
    digest = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    require(digest == request["package"]["integrity"], "Worker archive integrity mismatch")
    package = request["package"]
    DIAGNOSTIC["stage"] = "archive-preflight"
    archive_root = check_archive(archive, package)
    # Native safe_extract executes inside the same nono sandbox as native
    # extract_sandboxed, without nested-sandbox bypass or package execution.
    from guarddog.utils.archives import safe_extract
    directory = Path("extracted")
    directory.mkdir()
    DIAGNOSTIC["stage"] = "native-extraction"
    safe_extract(str(archive), str(directory))
    DIAGNOSTIC["stage"] = "file-inventory"
    files = verified_files(directory)
    DIAGNOSTIC["stage"] = "manifest-identity"
    require(f"{archive_root}/package.json" in files, "Missing package manifest")
    manifest = json.loads((directory / archive_root / "package.json").read_text())
    require(manifest["name"] == package["name"] and manifest["version"] == package["version"], "Archive identity mismatch")
    original_root = archive_root
    if " v" in archive_root:
        # Native npm metadata lookup only understands package/ or unscoped-name/.
        # Rename this single verified root, never a file or its bytes. Return every
        # finding with its original archive path and retain the normalization fact.
        archive_root = package["name"].rsplit("/", 1)[-1]
        (directory / original_root).rename(directory / archive_root)
        files = {archive_root + path[len(original_root):]: digest for path, digest in files.items()}
    DIAGNOSTIC["stage"] = "native-analysis"
    result = analyze(request, directory, files)
    if original_root != archive_root:
        for finding in result["findings"]:
            if finding["path"] != "$metadata":
                finding["path"] = original_root + finding["path"][len(archive_root):]
                finding["location"] = original_root + finding["location"][len(archive_root):]
        for indicator in result["indicators"]:
            indicator["location"] = original_root + indicator["location"][len(archive_root):]
        result["archiveRootAdaptation"] = {"original": original_root, "analyzedAs": archive_root}
    print(json.dumps({"complete": True, "scanner": "3.2.0", "sandbox": True, "files": len(files), **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"complete": False, "errorType": type(error).__name__,
                          "diagnostic": DIAGNOSTIC,
                          "policyError": str(error) if isinstance(error, PolicyError) else None}), file=sys.stderr)
        sys.exit(2)
