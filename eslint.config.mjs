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
      'release/**',
      'reports/**',
      '.stryker-tmp/**',
      '.fuzz-corpus/**',
      'fuzz/crashes/**',
      'fuzz/tmp/**',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      complexity: ['warn', { max: 16 }],
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
    files: ['**/*.{js,mjs}'],
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
