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
  'scripts/mutation-workflow-inputs.mjs':
    '19313a5a20011332f837148283071b0782fb0efe1c580068c3254dc9700a3d44',
  'scripts/mutation-resource-inputs.mjs':
    'be23f4edfcbf748f02cc8b6ece65c3a1950b2ca1e210cbb60cba641706c8cdca',
  'scripts/mutation-cache-inputs.mjs':
    '2859b7fd18a7bf1604ceb76b48ca49e06e05145b4077c129d5f5ab6ea130c9b2',
  'scripts/mutation-cache.mjs': 'f3bf889267ebfcef6bac817264033ee45cbee5125f397a36aa294c4809217185',
  'scripts/mutation-compatibility.mjs':
    '95a61b2734ee03e0153f0aa4db564a25721b0f0d83847f26dfc3b53b9d6ded82',
  'scripts/mutation-execution-guard.mjs':
    '9eda4229e3d3839f62de030d2ff70ae5ad7cf8ec126e9246442c093f78c2657e',
  'scripts/mutation-impact.mjs': 'f62c672ae4488e29f22c35c4d76e0a02ae95b3a7f61463d372323fc56e50fc77',
  'scripts/mutation-import-capabilities.mjs':
    'f1776f1783b6d02f912c9a036324619722224e4af9b1713b0c653b7bfc2c6d87',
  'scripts/mutation-loader-inputs.mjs':
    'c8d25d7ef9d404936117d60de29ad946611a469d834772ad413856458e4935fb',
  'scripts/mutation-module-capabilities.mjs':
    '2affa79e6bc634461697a209a7a193707c38eeb15bbd9f99abfc7c334fb27aff',
  'scripts/mutation-policy.mjs': '6fa5c5fccb37e6857d41e77002be6e89e792e696c81b64cc1dfeb3cd5c3c5ed8',
  'scripts/mutation-reviewed-data-access.mjs':
    '9affbe356bdf1a3b957bd57e6b1055cbaafed38f8ff0dd450d76b2e5c33505d2',
  'scripts/run-mutations.mjs': 'b6104bede4eb97d7c3893df5c6b4cb212f6b1944e002483d9e069edf63615206',
};

export function assertReviewedRuntime(files) {
  for (const path of runtimeDependencyPaths(files)) {
    if (trustRoots.has(path)) continue;
    const hash = createHash('sha256').update(files.get(path)).digest('hex');
    if (reviewed[path] !== hash) throw new Error(`Unreviewed mutation runtime source: ${path}`);
  }
}
