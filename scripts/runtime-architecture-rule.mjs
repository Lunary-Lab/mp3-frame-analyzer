import { getStaticValue, ReferenceTracker } from '@eslint-community/eslint-utils';

const { CALL } = ReferenceTracker;
const processLoader = { getBuiltinModule: { [CALL]: 'load' } };
const moduleFactory = { createRequire: { [CALL]: 'factory' } };
const importedLoaders = {
  process: processLoader,
  'node:process': processLoader,
  module: moduleFactory,
  'node:module': moduleFactory,
};

// Maintained ESLint utilities resolve bindings and constant values without
// executing input code. This rule complements native import and eval rules.
export const noProcessLoading = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { blocked: 'Runtime source must not load child_process capabilities.' },
  },
  create(context) {
    const source = context.sourceCode;
    const reported = new WeakSet();
    function check(node, argument) {
      if (!argument) return;
      const constant = getStaticValue(argument, source.getScope(argument));
      if (!['child_process', 'node:child_process'].includes(constant?.value)) return;
      if (!reported.has(node)) {
        reported.add(node);
        context.report({ node, messageId: 'blocked' });
      }
    }
    return {
      ImportExpression(node) {
        check(node, node.source);
      },
      'Program:exit'(program) {
        const tracker = new ReferenceTracker(source.getScope(program), { mode: 'legacy' });
        const references = [
          ...tracker.iterateGlobalReferences({
            require: { [CALL]: 'load' },
            module: { require: { [CALL]: 'load' } },
            process: processLoader,
          }),
          ...tracker.iterateEsmReferences(importedLoaders),
          ...tracker.iterateCjsReferences(importedLoaders),
        ];
        for (const { node, info } of references) {
          if (info === 'factory') {
            for (const reference of tracker.iteratePropertyReferences(node, { [CALL]: 'load' })) {
              check(reference.node, reference.node.arguments?.[0]);
            }
          } else {
            check(node, node.arguments?.[0]);
          }
        }
      },
    };
  },
};
