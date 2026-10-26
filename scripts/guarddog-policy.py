"""Exact, expiring finding reviews; never exceptions for unavailable capabilities."""

from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import re

MATCH_KEYS = {"name", "version", "integrity", "paths", "rule", "capabilityRule", "path", "location", "contextSha256"}
REVIEW_KEYS = {"id", "decision", "owner", "reviewedOn", "expiresOn", "explanation", "evidence", "matches"}
EVIDENCE_KEYS = {"path", "sha256", "section"}
HASH = re.compile(r"[a-f0-9]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact_match(package, finding):
    return {**{key: package[key] for key in ("name", "version", "integrity")},
            "paths": sorted(package["paths"]),
            **{key: finding[key] for key in ("rule", "capabilityRule", "path", "location", "contextSha256")}}


def identity(match):
    require(isinstance(match, dict) and set(match) == MATCH_KEYS, "Incomplete or broad finding review")
    require(all(isinstance(match[key], str) and match[key] and "*" not in match[key]
                for key in ("name", "version", "integrity", "rule", "path", "contextSha256")), "Invalid match field")
    require(isinstance(match["location"], str), "Invalid finding location")
    require(match["capabilityRule"] is None or isinstance(match["capabilityRule"], str), "Invalid capability identity")
    require(HASH.fullmatch(match["contextSha256"]), "Missing exact evidence hash")
    require(re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", match["integrity"]), "Missing archive integrity")
    require(isinstance(match["paths"], list) and match["paths"]
            and all(isinstance(p, str) and p.startswith("node_modules/") and "*" not in p for p in match["paths"])
            and match["paths"] == sorted(set(match["paths"])), "Invalid exact lock paths")
    return json.dumps(match, sort_keys=True, separators=(",", ":"))


def review_findings(packages, reviews, root, unavailable, today=None):
    today = today or datetime.now(timezone.utc).date()
    require(isinstance(reviews, list), "Malformed finding reviews")
    approved = {}
    ids = set()
    evidence_cache = {}
    for review in reviews:
        require(isinstance(review, dict) and set(review) == REVIEW_KEYS, "Malformed finding review")
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{2,79}", review["id"]) and review["id"] not in ids,
                "Duplicate or invalid review ID")
        ids.add(review["id"])
        require(review["decision"] in {"false-positive", "expected-behavior"}, "Unsupported review decision")
        require(isinstance(review["owner"], str) and len(review["owner"]) >= 3, "Missing accountable review owner")
        require(isinstance(review["explanation"], str) and len(review["explanation"]) >= 80,
                "Missing specific review explanation")
        reviewed = date.fromisoformat(review["reviewedOn"])
        expires = date.fromisoformat(review["expiresOn"])
        require(reviewed.isoformat() == review["reviewedOn"] and expires.isoformat() == review["expiresOn"], "Noncanonical review date")
        require(reviewed <= today < expires and 0 < (expires - reviewed).days <= 30, "Expired or excessive review period")
        evidence = review["evidence"]
        require(isinstance(evidence, dict) and set(evidence) == EVIDENCE_KEYS, "Missing review evidence")
        path = Path(evidence["path"])
        require(path.parts[:2] == (".github", "security") and path.suffix == ".md"
                and not any(part in {".", ".."} for part in path.parts), "Unapproved evidence path")
        require(HASH.fullmatch(evidence["sha256"]), "Missing evidence document digest")
        if str(path) not in evidence_cache:
            full = Path(root) / path
            require(full.is_file() and not full.is_symlink() and full.stat().st_size < 1024**2, "Invalid evidence file")
            evidence_cache[str(path)] = full.read_bytes()
        data = evidence_cache[str(path)]
        require(hashlib.sha256(data).hexdigest() == evidence["sha256"], "Evidence document changed")
        require(re.fullmatch(r"[a-z0-9-]+", evidence["section"])
                and f'<a id="{evidence["section"]}"></a>' in data.decode(), "Missing evidence section")
        require(isinstance(review["matches"], list) and review["matches"], "Empty review match list")
        for match in review["matches"]:
            key = identity(match)
            require(match["rule"] not in unavailable, "Unavailable capability is not a false positive")
            require(key not in approved, "Duplicate finding exception")
            approved[key] = review["id"]
    blockers = []
    used = set()
    for package in packages:
        # Every nonempty native metadata result must have a classified risk. Do
        # not silently drop a detector merely because an upstream score changes.
        require(set(package["metadataFindings"]) <= {f["rule"] for f in package["findings"]},
                "Unclassified metadata finding")
        for finding in package["findings"]:
            match = exact_match(package, finding)
            key = identity(match)
            if key in approved:
                used.add(key)
            else:
                blockers.append(match)
    require(used == set(approved), "Stale or unmatched finding exception; investigate changed evidence")
    return {"blockingFindings": blockers, "reviewedFindings": len(used), "reviewIds": sorted(set(approved.values()))}
