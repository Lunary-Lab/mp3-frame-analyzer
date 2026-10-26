"""Exact npm-lock inputs; data downloads only, never package installation."""

import base64
import hashlib
import json
from functools import lru_cache
import threading
import time
from datetime import datetime
import re
import urllib.request
from urllib.parse import quote, urlsplit

MAX_METADATA = 64 * 1024**2
MAX_ARCHIVE = 128 * 1024**2
METADATA_LOCK = threading.Lock()
NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def registry_url(value):
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.netloc == "registry.npmjs.org", "Unapproved registry")
    require(not parsed.query and not parsed.fragment and not parsed.username, "Unexpected URL components")
    require(parsed.path.startswith("/") and ".." not in parsed.path.split("/"), "Invalid registry path")
    return value


def locked_packages(lock):
    require(lock.get("lockfileVersion") == 3, "Expected lock-v3")
    packages = lock.get("packages")
    require(isinstance(packages, dict) and "" in packages, "Missing package inventory")
    inventory = {}
    for path, entry in packages.items():
        if path == "":
            continue
        require(path.startswith("node_modules/"), "Invalid dependency path")
        require(all(NAME.fullmatch(part) for part in path[13:].split("/node_modules/")), "Invalid nested path")
        require(isinstance(entry, dict) and not entry.get("link") and not entry.get("inBundle"),
                "Linked/bundled dependencies are not supported")
        name = entry.get("name", path.split("node_modules/")[-1])
        version = entry.get("version", "")
        require(NAME.fullmatch(name) and VERSION.fullmatch(version), "Non-exact package identity")
        url = registry_url(entry.get("resolved", ""))
        integrity = entry.get("integrity", "")
        require(re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", integrity), "Missing exact SHA512 SRI")
        digest = base64.b64decode(integrity[7:], validate=True)
        require(base64.b64encode(digest).decode() == integrity[7:], "Noncanonical SHA512 SRI")
        item = {"name": name, "version": version, "resolved": url, "integrity": integrity}
        key = name + "@" + version
        if key in inventory:
            require({k: inventory[key][k] for k in item} == item, "Conflicting locked archive")
            inventory[key]["paths"].append(path)
        else:
            inventory[key] = {**item, "paths": [path]}
    require(inventory, "Refusing empty dependency scan")
    return [inventory[key] for key in sorted(inventory)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Registry redirects are forbidden")


def download(url, maximum):
    opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
    request = urllib.request.Request(registry_url(url), headers={"Accept": "application/json", "User-Agent": "mp3-lock-audit/1"})
    with opener.open(request, timeout=30) as response:
        require(response.status == 200, "Registry did not return a complete response")
        require(response.headers.get("Content-Encoding", "identity") == "identity", "Unexpected compressed HTTP body")
        chunks = []
        size = 0
        deadline = time.monotonic() + 90
        while True:
            chunk = response.read1(min(65536, maximum + 1 - size))
            require(time.monotonic() < deadline, "Registry response exceeded time budget")
            if not chunk:
                break
            size += len(chunk)
            require(size <= maximum, "Registry response exceeded byte budget")
            chunks.append(chunk)
        require(size > 0, "Empty registry response")
        return b"".join(chunks)


@lru_cache(maxsize=8)
def metadata_input(name):
    return download("https://registry.npmjs.org/" + quote(name, safe="@"), MAX_METADATA)


def package_inputs(package):
    with METADATA_LOCK:
        raw = metadata_input(package["name"])
    metadata = json.loads(raw)
    require(metadata.get("name") == package["name"], "Metadata package mismatch")
    details = metadata["versions"][package["version"]]
    require(details.get("name") == package["name"] and details.get("version") == package["version"], "Version mismatch")
    require(details["dist"]["tarball"] == package["resolved"], "Registry archive changed")
    require(details["dist"].get("integrity", package["integrity"]) == package["integrity"], "Registry SRI changed")
    require(isinstance(metadata.get("time"), dict) and package["version"] in metadata["time"], "Missing publish history")
    require(metadata["dist-tags"]["latest"] in metadata["versions"], "Incomplete version history")
    for version, entry in metadata["versions"].items():
        require(isinstance(entry, dict) and isinstance(entry.get("dist"), dict), "Incomplete distribution history")
        published = datetime.fromisoformat(metadata["time"][version])
        require(published.tzinfo is not None, "Missing timestamp timezone")
    archive = download(package["resolved"], MAX_ARCHIVE)
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    require(actual == package["integrity"], "Downloaded bytes do not match locked SRI")
    return metadata, archive, hashlib.sha256(raw).hexdigest()
