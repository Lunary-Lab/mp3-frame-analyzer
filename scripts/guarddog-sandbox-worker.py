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


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_archive(archive):
    seen = set()
    total = 0
    # Parsing and extraction both happen inside the kernel sandbox and hard limits.
    with tarfile.open(archive, "r:gz") as stream:
        for member in stream:
            require(len(seen) < 20000, "Archive entry count exceeded")
            require(member.name not in seen, "Duplicate archive entry")
            seen.add(member.name)
            parts = member.name.rstrip("/").split("/")
            require(parts[0] == "package" and all(p not in ("", ".", "..") for p in parts), "Unsafe archive path")
            require(not member.name.startswith("/") and "\\" not in member.name, "Unsafe member name")
            require(member.isfile() or member.isdir(), "Links or special archive members are forbidden")
            total += member.size
            require(total <= 512 * 1024**2, "Extracted byte budget exceeded")
    require(seen and total > 0, "Empty archive")
    require(total <= archive.stat().st_size * 100, "Compression ratio budget exceeded")


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
    findings = []
    for risk in risks:
        path = risk["file_path"] or "$metadata"
        require(path == "$metadata" or path in files, "Finding outside extracted inventory")
        findings.append({"rule": risk["threat_rule"], "capabilityRule": risk["capability_rule"],
                         "path": path, "severity": risk["severity"],
                         "fileSha256": files.get(path), "location": risk["threat_location"]})
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
            "indicators": indicators, "metadataFindings": sorted(k for k, v in result["results"].items() if v)}


def main():
    resource.setrlimit(resource.RLIMIT_AS, (3 * 1024**3, 3 * 1024**3))
    require(importlib.metadata.version("guarddog") == "3.2.0", "Wrong scanner version")
    request = json.loads(Path("request.json").read_text())
    archive = Path("package.tgz")
    digest = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    require(digest == request["package"]["integrity"], "Worker archive integrity mismatch")
    check_archive(archive)
    # Native safe_extract executes inside the same nono sandbox as native
    # extract_sandboxed, without nested-sandbox bypass or package execution.
    from guarddog.utils.archives import safe_extract
    directory = Path("extracted")
    directory.mkdir()
    safe_extract(str(archive), str(directory))
    files = verified_files(directory)
    require("package/package.json" in files, "Missing package manifest")
    manifest = json.loads((directory / "package/package.json").read_text())
    package = request["package"]
    require(manifest["name"] == package["name"] and manifest["version"] == package["version"], "Archive identity mismatch")
    result = analyze(request, directory, files)
    print(json.dumps({"complete": True, "scanner": "3.2.0", "sandbox": True, "files": len(files), **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"complete": False, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(2)
