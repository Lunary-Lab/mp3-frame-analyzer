import { createHash } from 'node:crypto';
import { runtimeDependencyPaths } from './mutation-runtime-inputs.mjs';

// These two reviewed validator/witness modules form the explicit trust root.
// Their bytes remain global; the witness cannot authenticate its own source.
const trustRoots = new Set([
  'scripts/mutation-runtime-inputs.mjs',
  'scripts/mutation-runtime-witness.mjs',
]);
// Source-bound reviewed execution shapes, not automatic capture-time approval.
// A runtime edit requires independent review before this committed map changes.
const reviewed = {
  'scripts/mutation-cache-inputs.mjs':
    'eb5547c212871cbe3a4b3032947f23e8b3d6c0f74d33979e781d4d65c683f8bf',
  'scripts/mutation-cache.mjs': 'd26eb4023fc1b42b4ebdc19959f3b41ae477c5e9cb8d727dc13182516fd2cdd2',
  'scripts/mutation-compatibility.mjs':
    '4283cee186f7805b47939604314f5e8ec7f9a4e51856e09f58a7220733a76082',
  'scripts/mutation-execution-guard.mjs':
    '9eda4229e3d3839f62de030d2ff70ae5ad7cf8ec126e9246442c093f78c2657e',
  'scripts/mutation-impact.mjs': 'd1094c0261a0cd3910e457493aa1590abc49a6905dba0029ed95bbbad54fb15f',
  'scripts/mutation-import-capabilities.mjs':
    'f1776f1783b6d02f912c9a036324619722224e4af9b1713b0c653b7bfc2c6d87',
  'scripts/mutation-loader-inputs.mjs':
    'c8d25d7ef9d404936117d60de29ad946611a469d834772ad413856458e4935fb',
  'scripts/mutation-module-capabilities.mjs':
    '2affa79e6bc634461697a209a7a193707c38eeb15bbd9f99abfc7c334fb27aff',
  'scripts/mutation-policy.mjs': '6fa5c5fccb37e6857d41e77002be6e89e792e696c81b64cc1dfeb3cd5c3c5ed8',
  'scripts/mutation-reviewed-data-access.mjs':
    'a5fe471d45f0dd123573a6ac7252bd3ed7bc521251b794254cce9f4ff788f258',
  'scripts/run-mutations.mjs': 'e9cde4ef508118c5e086bd7b2f40048144514979c1d4b95ff31f34d59d916f8e',
};

export function assertReviewedRuntime(files) {
  for (const path of runtimeDependencyPaths(files)) {
    if (trustRoots.has(path)) continue;
    const hash = createHash('sha256').update(files.get(path)).digest('hex');
    if (reviewed[path] !== hash) throw new Error(`Unreviewed mutation runtime source: ${path}`);
  }
}
