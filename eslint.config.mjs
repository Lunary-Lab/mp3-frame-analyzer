import eslint from '@eslint/js';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.git/**',
      '.cache/**',
      'release/**',
      'reports/**',
      '.stryker-tmp/**',
      '.stryker-pure-tmp/**',
      '.fuzz-corpus/**',
      'fuzz/crashes/**',
      'fuzz/tmp/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    rules: {
      // Maintained runtime, build, release, mutation and fuzz tooling share this gate.
      complexity: ['error', { max: 10 }],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      'max-len': [
        'error',
        {
          code: 120,
          // Only standalone literals or URL-only comments, not surrounding code.
          ignorePattern:
            '^\\s*(?:(?:\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)[,;]?|//\\s*https?://\\S+)$',
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Async generators and iterator mocks intentionally don't await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.{js,mjs,cjs}'],
    rules: {
      // Preserve the existing advisory test limit; review test policy separately.
      // Declarative case tables should not be split merely to satisfy a metric.
      complexity: ['warn', { max: 16 }],
    },
  },
  {
    files: ['**/*.test.{ts,js,mjs,cjs}'],
    rules: {
      // A test suite/case table is not one production responsibility. Keep every
      // assertion together; helper modules retain the production size limits.
      'max-lines': 'off',
      'max-lines-per-function': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['bench/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', open: 'readonly' } },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { security },
    rules: {
      ...Object.fromEntries(
        Object.keys(security.configs.recommended.rules).map((rule) => [rule, 'error']),
      ),
      // Binary decoding deliberately indexes validated byte arrays and fixed tables.
      // This heuristic cannot distinguish those accesses from object injection.
      'security/detect-object-injection': 'off',
    },
  },
);
