"""Offline adapter controls; no GuardDog import, package code or network execution."""

import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


def load(filename):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inputs = load("guarddog-inputs.py")
worker = load("guarddog-sandbox-worker.py")


class ExactLockTests(unittest.TestCase):
    def setUp(self):
        self.entry = {"version": "1.2.3", "resolved": "https://registry.npmjs.org/a/-/a-1.2.3.tgz",
                      "integrity": "sha512-" + base64.b64encode(hashlib.sha512(b"synthetic").digest()).decode()}
        self.lock = {"lockfileVersion": 3, "packages": {"": {}, "node_modules/a": self.entry}}

    def test_exact_full_inventory_keeps_alias_dev_optional_and_all_paths(self):
        self.lock["packages"]["node_modules/alias"] = {**self.entry, "name": "a", "dev": True, "optional": True}
        result = inputs.locked_packages(self.lock)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["paths"], ["node_modules/a", "node_modules/alias"])

    def test_bad_registry_credentials_redirect_destinations_sri_range_link_bundle_fail(self):
        changes = [
            {"resolved": "http://registry.npmjs.org/a.tgz"},
            {"resolved": "https://registry.npmjs.org.evil.test/a.tgz"},
            {"resolved": "https://user@registry.npmjs.org/a.tgz"},
            {"resolved": "https://registry.npmjs.org/a.tgz?token=x"},
            {"version": "^1.2.3"}, {"version": "01.2.3"}, {"version": "1.2.3-01"},
            {"version": "1.2.3-.."}, {"version": "1.2.3+.."}, {"link": True}, {"inBundle": True}, {"integrity": ""},
        ]
        for change in changes:
            lock = copy.deepcopy(self.lock)
            lock["packages"]["node_modules/a"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                inputs.locked_packages(lock)

    def test_valid_semver_prerelease_and_build_remain_exact(self):
        self.lock["packages"]["node_modules/a"]["version"] = "1.2.3-beta.1+build.7"
        self.assertEqual(inputs.locked_packages(self.lock)[0]["version"], "1.2.3-beta.1+build.7")

    def test_current_lock_is_complete(self):
        lock = json.loads(Path(__file__).parents[1].joinpath("package-lock.json").read_text())
        result = inputs.locked_packages(lock)
        self.assertEqual(sum(len(item["paths"]) for item in result), len(lock["packages"]) - 1)


class ArchiveTests(unittest.TestCase):
    def archive(self, members):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as tar:
            for name, kind in members:
                entry = tarfile.TarInfo(name)
                if kind == "file":
                    entry.size = 2
                    tar.addfile(entry, io.BytesIO(b"{}"))
                else:
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "/etc/passwd"
                    tar.addfile(entry)
        return stream.getvalue()

    def test_native_supported_named_and_package_roots_but_no_traversal_links_or_duplicates(self):
        for members, valid in [
            ([("package/package.json", "file")], True),
            ([("node/package.json", "file")], True),
            ([("node v24.19/package.json", "file")], True),
            ([("node v24.18/package.json", "file")], False),
            ([("../escape", "file")], False),
            ([("package/a", "link")], False),
            ([("package/a", "file"), ("package/a", "file")], False),
            ([("package/a", "file"), ("node/b", "file")], False),
            ([], False),
        ]:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary, "package.tgz")
                path.write_bytes(self.archive(members))
                if valid:
                    self.assertIn(worker.check_archive(path, {"name": "@types/node", "version": "24.19.2"}), ["package", "node", "node v24.19"])
                else:
                    with self.assertRaises(ValueError):
                        worker.check_archive(path, {"name": "@types/node", "version": "24.19.2"})


if __name__ == "__main__":
    unittest.main()
