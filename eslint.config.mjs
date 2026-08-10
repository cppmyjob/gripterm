/**
 * ESLint configuration.
 *
 * Base rules come from the planner conventions; the type-checked block below is
 * the same set. One rule is ours and is the reason this file matters more than
 * style: `packages/core` may not import the editor API. That boundary is the
 * central architectural invariant, and it is checked by a machine here and by
 * the type system separately (@types/vscode is only visible to the extension
 * package).
 */
import { baseRules, eslintRecommended, tseslint, importPlugin } from './eslint.config.base.mjs';

export default tseslint.config(
  eslintRecommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: { import: importPlugin },
    rules: {
      ...baseRules,
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/dot-notation': 'error',
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2, 100],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
        },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
        },
      ],
    },
  },
  {
    // The architectural boundary: the domain must not know the editor exists.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['vscode'], message: 'core must not depend on the editor API' }],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },
  {
    ignores: [
      'dist/',
      'out/',
      'node_modules/',
      'packages/*/dist/',
      'packages/*/out/',
      '.test-output/',
      '**/*.js',
      '**/*.mjs',
      '!eslint.config.mjs',
      '!eslint.config.base.mjs',
    ],
  }
);
