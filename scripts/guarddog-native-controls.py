"""Synthetic native positive/negative controls, only on the supported CI sandbox."""

import base64
import hashlib
import io
import json
import tarfile


def fixture(source, preinstall=False, unsafe=False, root="package", name="guarddog-synthetic-control"):
    manifest = {"name": name, "version": "1.0.0"}
    if preinstall:
        manifest["scripts"] = {"preinstall": "node -e \"require('fs').writeFileSync('LIFECYCLE_EXECUTED','bad')\""}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path, content in {f"{root}/package.json": json.dumps(manifest), f"{root}/index.js": source}.items():
            data = content.encode()
            entry = tarfile.TarInfo(path)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        if unsafe:
            entry = tarfile.TarInfo("package/link")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
            archive.addfile(entry)
    raw = stream.getvalue()
    package = {"name": manifest["name"], "version": "1.0.0", "paths": ["node_modules/synthetic"],
               "integrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()}
    metadata = {"name": manifest["name"], "versions": {"1.0.0": manifest}, "dist-tags": {"latest": "1.0.0"},
                "time": {"created": "2020-01-01T00:00:00Z", "1.0.0": "2020-01-01T00:00:00Z"}, "maintainers": []}
    return package, metadata, raw


def verify(scan, profile, scanner_root):
    package, metadata, archive = fixture("module.exports = 42;")
    result = scan(package, profile, scanner_root, metadata, archive, "synthetic")
    assert result["complete"] and not result["findings"] and not result["metadataFindings"]
    package, metadata, archive = fixture("module.exports = (x) => eval(Buffer.from(x, 'base64').toString());", True)
    result = scan(package, profile, scanner_root, metadata, archive, "synthetic")
    rules = {item["rule"] for item in result["indicators"]}
    assert {"threat-npm-preinstall-script", "threat-runtime-obfuscation-base64exec"} <= rules
    assert result["findings"], "Synthetic native positive was not detected"
    normalized = []
    for root in ("synthetic", "synthetic v1.0"):
        package, metadata, archive = fixture("module.exports = (x) => eval(Buffer.from(x, 'base64').toString());",
                                             True, root=root, name="@types/synthetic")
        response = scan(package, profile, scanner_root, metadata, archive, "synthetic")
        findings = [{**item, "path": item["path"].replace(root + "/", "root/", 1),
                     "location": item["location"].replace(root + "/", "root/", 1)} for item in response["findings"]]
        normalized.append({"score": response["score"], "findings": findings, "metadataFindings": response["metadataFindings"]})
        if " v" in root:
            assert response["archiveRootAdaptation"] == {"original": root, "analyzedAs": "synthetic"}
    assert normalized[0] == normalized[1], "Versioned-root native analysis was not equivalent"
    for unsafe in (False, True):
        package, metadata, archive = fixture("module.exports = 42;", unsafe=unsafe)
        if not unsafe:
            archive += b"changed"
        try:
            scan(package, profile, scanner_root, metadata, archive, "synthetic")
        except ValueError:
            pass
        else:
            raise AssertionError("Native invalid archive was accepted")
