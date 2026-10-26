"""Offline fail-closed review controls; no scanner import or package execution."""

import copy
from datetime import date
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("guarddog-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        doc = self.root / ".github/security/evidence.md"
        doc.parent.mkdir(parents=True)
        doc.write_text('# Exact reviewed context\n<a id="context"></a>\n')
        self.package = {"name": "a", "version": "1.2.3", "integrity": "sha512-" + "A" * 86 + "==",
            "paths": ["node_modules/a"], "metadataFindings": [], "findings": [{"rule": "threat-a",
            "capabilityRule": "capability-a", "path": "package/test.js", "location": "package/test.js:1",
            "contextSha256": "a" * 64}]}
        self.review = {"id": "review-a", "decision": "false-positive", "owner": "repository-maintainer",
            "reviewedOn": "2026-10-26", "expiresOn": "2026-11-25",
            "explanation": "The exact fixture has been inspected and the literal is non-executable test data, not a credential access operation.",
            "evidence": {"path": ".github/security/evidence.md", "sha256": hashlib.sha256(doc.read_bytes()).hexdigest(), "section": "context"},
            "matches": [policy.exact_match(self.package, self.package["findings"][0])]}

    def run_policy(self, reviews=None, packages=None, unavailable=None):
        return policy.review_findings(packages or [self.package], reviews if reviews is not None else [self.review],
            self.root, unavailable or [], date(2026, 10, 26))

    def test_unreviewed_findings_block_and_exact_review_only_matches_one_identity(self):
        self.assertEqual(len(self.run_policy(reviews=[])["blockingFindings"]), 1)
        self.assertEqual(self.run_policy()["reviewedFindings"], 1)
        for key in ["name", "version", "integrity", "paths"]:
            changed = copy.deepcopy(self.package)
            changed[key] = ["node_modules/other"] if key == "paths" else changed[key] + "x"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.run_policy(packages=[changed])
        for key in ["rule", "capabilityRule", "path", "location", "contextSha256"]:
            changed = copy.deepcopy(self.package)
            changed["findings"][0][key] = "b" * 64 if key == "contextSha256" else "changed"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.run_policy(packages=[changed])

    def test_expired_future_overlong_missing_or_duplicate_reviews_fail(self):
        for change in [{"expiresOn": "2026-10-26"}, {"reviewedOn": "2026-10-27"},
                       {"expiresOn": "2027-10-26"}, {"owner": ""}, {"explanation": "trusted package"},
                       {"decision": "ignore"}, {"matches": []}, {"extra": True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_policy(reviews=[{**self.review, **change}])
        with self.assertRaises(ValueError):
            self.run_policy(reviews=[self.review, self.review])

    def test_changed_missing_evidence_and_broad_match_fail(self):
        for mutation in [lambda r: r["matches"][0].pop("contextSha256"),
                         lambda r: r["matches"][0].update(name="*"),
                         lambda r: r["evidence"].update(path="../../secret.md"),
                         lambda r: r["evidence"].update(section="absent"),
                         lambda r: r["evidence"].update(sha256="b" * 64)]:
            changed = copy.deepcopy(self.review)
            mutation(changed)
            with self.assertRaises(ValueError):
                self.run_policy(reviews=[changed])

    def test_unavailable_capability_and_unclassified_metadata_can_never_be_waived(self):
        with self.assertRaisesRegex(ValueError, "Unavailable capability"):
            self.run_policy(unavailable=["threat-a"])
        self.package["metadataFindings"] = ["missing-risk"]
        with self.assertRaisesRegex(ValueError, "Unclassified metadata"):
            self.run_policy()


if __name__ == "__main__":
    unittest.main()
