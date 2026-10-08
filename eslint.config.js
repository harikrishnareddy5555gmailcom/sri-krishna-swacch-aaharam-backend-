// Root ESLint configuration (ESLint v9 flat config)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Explicit return types on exported functions
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Disallow the use of 'any' type
      '@typescript-eslint/no-explicit-any': 'warn',
      // Require consistent use of type imports
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // No unused variables (allow _ prefix for intentional)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // No floating promises
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Ignore generated and build files
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/api/src/generated/**',
    ],
  },
);
