"""Native parser and profile controls; never download or execute a module."""

import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    'go_module_policy', pathlib.Path(__file__).with_name('verify-go-module.py'))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class GoModulePolicyTests(unittest.TestCase):
    def test_repository_bound_regular_lock_inputs(self):
        original_root = POLICY.ROOT
        try:
            with tempfile.TemporaryDirectory(prefix='mp3-go-profile-path-') as directory:
                POLICY.ROOT = pathlib.Path(directory)
                module = POLICY.ROOT / 'module'
                module.mkdir()
                (module / 'go.mod').write_text('module example.invalid/tool\ngo 1.27.3\nrequire example.invalid/dep v1.0.0\n')
                (module / 'go.sum').write_text('')
                POLICY.verify('module')
                (module / 'go.sum').unlink()
                with self.assertRaises(ValueError):
                    POLICY.verify('module')
                (POLICY.ROOT / 'other.sum').write_text('')
                (module / 'go.sum').symlink_to('../other.sum')
                with self.assertRaises(ValueError):
                    POLICY.verify('module')
                (POLICY.ROOT / 'linked').symlink_to('module', target_is_directory=True)
                with self.assertRaises(ValueError):
                    POLICY.verify('linked')
                with self.assertRaises(ValueError):
                    POLICY.verify('..')
        finally:
            POLICY.ROOT = original_root

    def test_native_parser_and_unsupported_acquisition(self):
        module = ('module example.invalid/policy\n\ngo 1.27.3\n\n'
                  'require example.invalid/dependency v1.2.3\n')
        cases = {
            '': True,
            'toolchain go1.27.3\n': True,
            'toolchain go1.99.0\n': False,
            'replace example.invalid/dependency => ../unhashed\n': False,
            'replace example.invalid/dependency => example.invalid/other v2.0.0\n': False,
            'exclude example.invalid/dependency v1.2.3\n': False,
        }
        with tempfile.TemporaryDirectory(prefix='mp3-go-profile-') as directory:
            file = pathlib.Path(directory) / 'go.mod'
            for addition, accepted in cases.items():
                with self.subTest(addition=addition):
                    source = module + addition
                    file.write_text(source)
                    parsed = POLICY.native_profile(directory)
                    self.assertEqual(file.read_text(), source, 'Read-only native parser changed go.mod')
                    if accepted:
                        POLICY.require_profile(parsed)
                    else:
                        with self.assertRaises(ValueError):
                            POLICY.require_profile(parsed)
                    self.assertFalse((pathlib.Path(directory) / 'go.sum').exists())
            file.write_text('module "unterminated\n')
            with self.assertRaises(subprocess.CalledProcessError):
                POLICY.native_profile(directory)

    def test_missing_or_unsupported_json_is_not_a_pass(self):
        valid = {'Module': {'Path': 'example.invalid/tool'}, 'Go': '1.27.3',
                 'Require': [{'Path': 'example.invalid/dependency', 'Version': 'v1.2.3'}]}
        POLICY.require_profile(valid)
        for field, value in [('Go', '1.99.0'), ('Require', []), ('Require', [{}]),
                             ('Module', {}), ('Unknown', True), ('Toolchain', 'default')]:
            with self.subTest(field=field):
                changed = copy.deepcopy(valid)
                changed[field] = value
                with self.assertRaises(ValueError):
                    POLICY.require_profile(changed)
        for invalid in (None, [], {}, json.loads('null')):
            with self.assertRaises(ValueError):
                POLICY.require_profile(invalid)


if __name__ == '__main__':
    unittest.main()
