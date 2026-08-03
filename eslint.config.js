import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for the whole workspace.
 *
 * Type-aware linting is enabled for the TypeScript sources, which is what makes rules
 * like `no-floating-promises` and `no-misused-promises` worth having — both are easy ways
 * to silently lose an error inside an async game loop.
 *
 * Build/tooling files (this config, the Vitest config, the `.mjs` scripts) are linted
 * without type information: they are not part of any package's TypeScript program.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },

  js.configs.recommended,

  // ---------------------------------------------------------------------------
  // Type-aware rules for application and library sources.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'tests/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      // `void promise` is used deliberately to mark intentional fire-and-forget calls.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Test code asserts on deliberately loose payloads and indexes known-good fixtures.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Tooling files: syntax-only linting.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.mjs', '**/*.js', 'eslint.config.js', 'vitest.config.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
      },
    },
  },

  prettier,
);
