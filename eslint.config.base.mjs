/**
 * Shared ESLint rules.
 *
 * Ported from the planner project, with its conventions kept verbatim: no
 * `any`, no `I` prefix on interfaces, no leading underscore on private members,
 * named exports only, explicit member visibility, explicit return types.
 *
 * The file is .mjs rather than .js because the workspace is CommonJS: a plain
 * .js here would be parsed as CJS and these `import` statements would fail.
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export const namingConventionRules = {
  '@typescript-eslint/naming-convention': [
    'error',
    { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
    { selector: 'typeAlias', format: ['PascalCase'] },
    { selector: 'class', format: ['PascalCase'] },
    { selector: 'classProperty', format: ['camelCase'], leadingUnderscore: 'forbid' },
    { selector: 'classMethod', format: ['camelCase'] },
    { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
    { selector: 'function', format: ['camelCase'] },
    { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
    { selector: 'enumMember', format: ['PascalCase', 'UPPER_CASE'] },
  ],
};

export const baseRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/explicit-member-accessibility': [
    'error',
    { accessibility: 'explicit', overrides: { constructors: 'no-public' } },
  ],
  ...namingConventionRules,
  'import/no-default-export': 'error',
  'import/prefer-default-export': 'off',
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/explicit-function-return-type': [
    'error',
    { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: true },
  ],
};

export const eslintRecommended = eslint.configs.recommended;
export { tseslint, importPlugin };
