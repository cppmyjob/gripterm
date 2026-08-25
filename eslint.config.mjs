import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import importX from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import regexp from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

/**
 * Lint rules for Gripterm.
 *
 * The ruleset is taken from `trudocker/artifacts/test-scripts`, by owner's
 * decision. Each rule that project switched on is either switched on here for
 * the reason it stated, or named below as a deviation -- because a difference
 * nobody wrote down is a difference nobody can review.
 *
 * The BASE is type-aware `strictTypeChecked`, as there. The argument carries
 * over unchanged: this extension is almost entirely asynchronous -- terminal
 * lifecycle events, process spawning, file watching -- and a dropped promise is
 * the defect class `tsc` cannot see, since it accepts a floating promise
 * anywhere a statement is allowed.
 *
 * Five deviations, each with its reason stated at the rule below:
 *   1. the parser gets an explicit `project`, not `projectService`;
 *   2. the Playwright block becomes a Jest block -- the analogue by meaning;
 *   3. `no-extraneous-class` stays ON: the source turns it off for a reason
 *      (classes that are namespaces of static selectors) that does not hold here;
 *   4. `no-require-imports` is off for CommonJS `.js` files, which have no
 *      `import` to prefer;
 *   5. four rules of this project's own survive alongside the imported set, and
 *      one of them -- `explicit-function-return-type` -- replaces the source's
 *      weaker `explicit-module-boundary-types`, which is therefore not carried.
 *
 * Every `off` names its reason. A disabled rule without one is a decision
 * nobody can review later, and this file is exactly where such decisions hide.
 */

/**
 * The three one-way boundaries, as `no-restricted-imports` patterns.
 *
 * Named here rather than written out where they are used, because they have to be
 * written out MORE THAN ONCE: a later config object replaces the options of a
 * rule instead of merging with them, so every object that touches this rule has
 * to restate every pattern that should still apply to the files it matches. A
 * shared constant makes a forgotten pattern a missing name in a list rather than
 * a boundary that silently stops existing. `tests/boundaries.test.ts` asks the
 * linter whether it worked.
 */
const NO_EDITOR_API = { group: ['vscode'], message: 'core must not depend on the editor API' };

const NO_NATIVE_PTY = {
  group: ['node-pty', 'node-pty/*'],
  message: 'node-pty belongs to packages/extension/src/adapters and nowhere else',
};

const NO_AGENT_CLI = {
  group: ['**/agents/**'],
  message: 'the neutral domain must not know which agent CLI it is observing',
};

/**
 * The page's boundary, and it is the only one here that is about a RUNTIME
 * rather than a layer: `packages/webview/src/page/**` is loaded by a webview,
 * which has a document, one message channel and nothing else. No editor API, no
 * Node builtins, no `require`.
 *
 * The type system states half of it already -- that project compiles with
 * `types: []`, so `@types/node` is not visible and a bare `import 'fs'` does not
 * type-check. This rule states the other half, the one an added dependency could
 * otherwise make true: `node:*` specifiers, which resolve by name.
 */
const PAGE_IS_A_BROWSER = {
  group: ['vscode', 'node:*'],
  message: 'the page runs inside a webview: no editor API and no Node builtins reach it',
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'packages/*/dist/**',
      'packages/*/out/**',
      // Jest coverage and the downloaded VS Code used by the integration run.
      '.test-output/**',
      '.vscode-test/**',
      // Throwaway measurement stands (14-m3-plan.md §2). They are outside
      // `tsconfig.eslint.json`, so a type-aware parser cannot read them at all:
      // any .ts here fails with `"parserOptions.project" ... file was not found`
      // and takes `pnpm lint` down with it. Widening that tsconfig instead would
      // have put spike code under the product's rules -- including the M3.3 ban
      // on importing `node-pty` outside adapters, which spikes exist to break.
      'spikes/**',
      // The copy of `node-pty` that `pnpm build:extension` puts beside the bundle
      // (M3.4). Somebody else's compiled JavaScript, recreated by every build:
      // linting it would report their style as our warnings and take
      // `--max-warnings 0` down with it.
      'packages/extension/assets/node-pty/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  comments.recommended,
  regexp.configs['flat/recommended'],

  {
    languageOptions: {
      // NOT `projectService: true`, which is what the source project uses. There
      // a single flat tsconfig covers every linted file. Here the build is three
      // projects (core, extension, the integration suite) behind a solution-style
      // root tsconfig whose `files` is empty, so the service would resolve
      // `tests/**` to a project that includes nothing and refuse to type them.
      // `tsconfig.eslint.json` is the one description of the union ESLint needs.
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A disable that stopped being needed is a lie nobody notices: the rule no
      // longer fires, and the comment still claims it does. This is the expiry
      // date on every workaround in the package, and it is enforced rather than
      // remembered.
      reportUnusedDisableDirectives: 'error',
    },
  },

  // --- the dependency graph ---------------------------------------------------
  //
  // The plugin's own TypeScript preset, not a hand-wired `plugins` entry:
  // `no-cycle` needs the preset's parser settings to read the IMPORTED files,
  // and without them it walks an empty graph and passes.
  importX.flatConfigs.typescript,
  {
    files: ['packages/**/src/**/*.ts', 'tests/**/*.ts'],
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: './tsconfig.eslint.json' }),
      ],
    },
    rules: {
      // The layers are a directed graph by design: extension depends on core,
      // never the reverse. A cycle means two modules are really one, and it also
      // decides module initialisation order at runtime, which nobody wants to
      // reason about.
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-self-import': 'error',

      // Only named exports, as in the planner conventions this project started
      // from. A default export renames itself at every import site, so the same
      // module arrives under three names and neither grep nor a rename refactor
      // finds all three. Config files are exempt below: their frameworks require
      // a default export.
      'import-x/no-default-export': 'error',

      // NOT `import-x/extensions: 'never'`, which would be the obvious way to
      // enforce decision №33 (no `.js` on a relative specifier). It was tried in
      // two spellings, both with a planted `'../errors/gripterm-error.js'` to
      // check it could fail, and it stayed silent in both -- the TypeScript
      // resolver hands the rule the resolved `.ts` file, and the written suffix
      // never reaches it. A rule that cannot fail is worse than no rule: it
      // claims an enforcement that does not exist. The convention is therefore
      // stated in §3.4 of the plan and held by review, and that limit is said
      // out loud rather than papered over.
    },
  },

  {
    // Every silenced rule states why, in the directive itself.
    rules: { '@eslint-community/eslint-comments/require-description': 'error' },
  },

  // --- everything TypeScript --------------------------------------------------
  {
    files: ['**/*.ts'],
    plugins: { '@stylistic': stylistic },
    rules: {
      // A class says who may touch each member, and members appear in one order.
      // Every member states its visibility, ACCESSORS INCLUDED.
      //
      // The constructor is the single exception, and `no-public` rather than
      // `off`: writing `public constructor` says nothing a bare `constructor`
      // does not, while `private` and `protected` there change what the class
      // permits and must still be written. `off` would merely stop looking.
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'explicit', overrides: { constructors: 'no-public' } },
      ],
      '@typescript-eslint/member-ordering': 'error',

      '@typescript-eslint/naming-convention': [
        'error',
        // An interface is a type, not a Hungarian-notation slot. The `I` prefix
        // encodes in the name what the declaration already says, and it is the
        // one thing that has to change when an interface becomes a type alias.
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'variable', modifiers: ['const'], format: ['UPPER_CASE', 'camelCase', 'PascalCase'] },
        // A private member carries a leading underscore. The accessibility
        // keyword states the same thing at the declaration; the underscore states
        // it at every USE, which is where a reader meets the member and where
        // nothing else would tell them.
        {
          selector: ['memberLike', 'variableLike'],
          modifiers: ['private'],
          format: ['UPPER_CASE', 'camelCase', 'PascalCase'],
          leadingUnderscore: 'require',
        },
      ],

      // Numbers in prose are the point: a pinned CLI version, a terminal count, a
      // millisecond budget all get formatted into log lines and notifications.
      // Left ON for objects and `any`, which stringify to `[object Object]` and
      // are always a mistake.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // `||` and `??` differ on the empty string, and the empty string is exactly
      // the case these fall through on: an environment variable set to nothing, a
      // terminal name the user cleared. `??` would keep it and the fallback would
      // never fire. Left ON for every other type, where `||` also swallows `0`
      // and `false`.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true } },
      ],

      // Asynchrony, beyond what the presets already switch on
      // (`no-floating-promises`, `no-misused-promises`, `await-thenable`):

      // A variable read before an `await` and written after it is the one race a
      // single-threaded language still has -- and this extension holds a mutable
      // registry of terminals across awaits by design.
      'require-atomic-updates': 'error',

      // `async f() { return p; }` drops `f` from the stack trace when `p`
      // rejects, and the `async` earns nothing. `always` rather than the preset's
      // error-handling-only setting: the log channel is the only window into a
      // failed activation, and that is exactly when the missing frame costs most.
      '@typescript-eslint/return-await': ['error', 'always'],

      // Every function that hands back a promise says so with `async`, so the two
      // ways of writing the same signature stop coexisting. It also removes the
      // one asymmetry a caller cannot see: a non-async function can throw BEFORE
      // returning its promise, so `f().catch(...)` misses that error while
      // `await f()` catches it.
      '@typescript-eslint/promise-function-async': 'error',

      // A leading underscore already means "deliberately private" here; on a
      // parameter it means "the signature requires it, the body does not".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `if (x) return;` on one line is intentional and dense; a body spanning
      // lines must be braced, which is where the dangling-statement bug lives.
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'smart'],
      'object-shorthand': 'error',
      'one-var': ['error', 'never'],
      'no-throw-literal': 'error',
      radix: 'error',

      '@typescript-eslint/require-array-sort-compare': 'error', // [3, 10, 2].sort() sorts as text
      '@typescript-eslint/prefer-readonly': 'error', // a private never reassigned says so
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      'no-param-reassign': 'error',
      'prefer-const': 'error',
      'no-else-return': 'error',
      'guard-for-in': 'error',

      // What disappears at build time is stated, not inferred -- the extension is
      // bundled by esbuild, which strips types per-file and cannot infer that an
      // import was only ever a type. The options differ from the source only in
      // the shape of the autofix: inline, so a module supplying both values and
      // types -- which every port here does -- keeps arriving in one statement
      // rather than two.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/method-signature-style': 'error',

      // Taken verbatim from the source project, by owner's decision, and its
      // reach is stated rather than assumed. On its defaults -- which is what a
      // bare `'error'` selects -- the rule allows `allowString` and `allowNumber`.
      // Measured on a probe file: `if (name)` and `if (count)` on a plain string
      // and a plain number produce NO diagnostic; `if (maybe)` on a
      // `string | undefined` produces one.
      //
      // So what this rule guards here is the nullable case: the value that is
      // absent versus the value that is empty. Distinguishing an empty string
      // from a filled one, or a zero from a count, remains a matter of review.
      '@typescript-eslint/strict-boolean-expressions': 'error',

      // Not `default-case`: that rule predates types and asks for an unreachable
      // branch on a switch the compiler already proved exhaustive. This one
      // catches what actually goes wrong -- a union member nobody handled, which
      // for a state machine driven by CLI hook events is the whole risk.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],

      // KEPT from this project's own conventions, absent from the source set:

      // A return type is the one part of a signature a reader needs and inference
      // hides. `explicit-module-boundary-types`, which the source project uses,
      // would check only exported functions; here every function says what it
      // returns. Expressions and callbacks stay exempt -- there the contextual
      // type IS the declaration.
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],

      // A bare number in a branch is a decision with no name. The exemptions are
      // the numbers that are their own name: an index, a count of none or one, a
      // pair, a percentage.
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

      // OFF, with reasons:

      // An `async` method with no `await` is how a port satisfies an asynchronous
      // interface it does not yet need to suspend on -- the storage and CLI ports
      // are both shaped that way. The autofix strips `async`, which changes a
      // signature to match its current body rather than its contract.
      '@typescript-eslint/require-await': 'off',

      // `as string` after an indexed read is the shape `noUncheckedIndexedAccess`
      // forces; the rule prefers `!`, which hides the same assumption behind less
      // text. Neither is safer, so the more visible one stays -- and `!` is banned
      // outright by `no-non-null-assertion` from the strict preset.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',

      // NOT taken from the source project: `no-extraneous-class` is `off` there
      // because its domain classes are deliberately namespaces of static
      // selectors. Nothing here is shaped that way, so the strict preset's
      // setting stands.

      '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always' }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/eol-last': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1 }],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/spaced-comment': ['error', 'always'],
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'semi', requireLast: true },
          singleline: { delimiter: 'comma', requireLast: false },
        },
      ],
      // No `max-len`: the long lines here are doc comments, where a wrap costs
      // more than it buys. Width is a formatter's job, and this package has no
      // formatter by choice.
    },
  },

  // --- the architectural boundary ---------------------------------------------
  {
    // The native boundary (M3.3, §4.2), and it is the widest of the three: ONE
    // directory in the whole repository may know that a native pty addon exists.
    // Everything else -- the core, the composition root, the webview host, the
    // suites -- reaches a terminal through `TerminalScreen`, so the domain stays
    // buildable and testable by plain `jest` with no native build anywhere.
    //
    // What it CANNOT catch, said here rather than discovered later: it reads
    // imports. The adapter loads the addon through a lazy `require` with a
    // computed path -- on purpose, because a static import would turn a missing
    // addon into the failure of the whole extension instead of a fallback to the
    // `editor` engine (O5) -- and a computed `require` anywhere else would pass
    // this rule in silence. Review is the only thing that sees that.
    files: ['**/*.ts'],
    ignores: ['packages/extension/src/adapters/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [NO_NATIVE_PTY] }],
    },
  },

  {
    files: ['packages/core/**/*.ts'],
    rules: {
      // The domain must not know the editor exists. This is the central
      // invariant of the design, and it is checked twice: here, and by the type
      // system separately, since `@types/vscode` is visible only to the extension
      // package. `@typescript-eslint/no-restricted-imports` rather than the base
      // rule, because it also catches `import type ... from 'vscode'` -- a type
      // import erases at build time but couples the domain to the editor's model
      // just as firmly.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // `NO_NATIVE_PTY` is repeated from the block above for the reason
          // stated at the constants: this object REPLACES the options of that
          // one for every file it matches, and leaving it out would exempt the
          // core -- the package the native boundary exists for -- from it.
          patterns: [NO_EDITOR_API, NO_NATIVE_PTY],
        },
      ],
    },
  },

  {
    // The second boundary, and it is younger than the first: everything under
    // `domain/agents/<name>/` knows ONE agent CLI -- its settings file, its
    // payload field names, its version pin. The rest of the domain must not,
    // because the states, the aggregate and the state machine are about an
    // agent running in a terminal and not about which agent it is. Composition
    // and infrastructure may of course name one; they are where concrete
    // choices belong.
    //
    // A directory, not an interface. A port shaped from a second agent we have
    // only READ about would be the kind of work that gets redone; the boundary
    // says where the seam runs without promising its form.
    //
    // What this CANNOT catch, said here rather than discovered later: it sees
    // imports, not shapes. `LaunchRecipe` imports nothing from `agents/` and so
    // passes silently, while its fields -- addDirs, mcpConfigPaths,
    // appendSystemPrompt, worktree, agent, permissionMode -- are one CLI's flag
    // list. An entity built in the shape of an agent is invisible to a rule
    // about dependencies, and review is the only thing that sees it.
    files: ['packages/core/src/domain/**/*.ts'],
    ignores: ['packages/core/src/domain/agents/**/*.ts'],
    rules: {
      // All three patterns are repeated here on purpose. A later config object
      // REPLACES the options of the same rule rather than merging with them, so
      // omitting the `vscode` or the `node-pty` entry would quietly switch that
      // boundary off for exactly the files it matters most for.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [NO_EDITOR_API, NO_NATIVE_PTY, NO_AGENT_CLI],
        },
      ],
    },
  },

  {
    // The page, and it is the one thing in this repository compiled for a
    // BROWSER (M3.6).
    //
    // It gets its own parser project because `tsconfig.eslint.json` describes
    // the union of the Node-side projects -- DOM-free, `@types/node` included --
    // and every page file linted through it would fail on `document` before a
    // single rule had a chance to run. The project named here is the one `tsc
    // --build` compiles the page with, so the linter and the compiler read the
    // same file the same way.
    files: ['packages/webview/src/page/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: './packages/webview/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `NO_NATIVE_PTY` is restated for the reason given at the constants: this
      // object REPLACES the options of the rule for every file it matches, and
      // leaving it out would exempt the page from the native boundary.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [PAGE_IS_A_BROWSER, NO_NATIVE_PTY] },
      ],
    },
  },

  // --- the specs --------------------------------------------------------------
  {
    files: ['tests/**/*.ts'],
    rules: {
      // A test is a table of literal inputs and expected outputs. Naming each of
      // them would turn the table into a glossary and hide what is being tested.
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  {
    // The analogue of the source project's Playwright block. Scoped to the Jest
    // suites alone: `tests/integration` and `tests/acceptance` run under Mocha
    // inside a real VS Code, where `suite` and `test` are Mocha's and these
    // rules would read them as Jest's.
    files: ['tests/**/*.ts'],
    ignores: ['tests/integration/**/*.ts', 'tests/acceptance/**/*.ts'],
    ...jest.configs['flat/recommended'],
    rules: {
      ...jest.configs['flat/recommended'].rules,
      // Raised from the preset's `warn`. `pnpm lint` runs with `--max-warnings
      // 0`, so a warning already fails the build; leaving these at `warn` would
      // describe a leniency that does not exist, and would quietly become real
      // the day someone drops the flag.
      //
      // All three name the same defect: a test that does not run, or runs and
      // cannot fail, while the suite still reports green.
      'jest/expect-expect': 'error',
      'jest/no-disabled-tests': 'error',
      'jest/no-commented-out-tests': 'error',
    },
  },

  // --- the config files themselves --------------------------------------------
  {
    // Not part of any TypeScript program -- they are the scripts that define the
    // programs -- so the type-aware rules have no program to ask and would report
    // a parse error instead of nothing.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // A `.js` file in a CommonJS package IS a CommonJS module, so `require`
      // there is the module system rather than a style choice. The rule aims at
      // TypeScript, where `import` exists and `require` throws the types away.
      '@typescript-eslint/no-require-imports': 'off',

      // Jest, esbuild and @vscode/test-cli each read a default export or a
      // `module.exports`; the named-exports rule above is scoped away from here
      // rather than disabled, so it keeps applying where it can.
      '@stylistic/quotes': ['error', 'single', { allowTemplateLiterals: 'always' }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/eol-last': 'error',
      '@stylistic/no-trailing-spaces': 'error',
    },
    plugins: { '@stylistic': stylistic },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // The Cursor strip is Mocha, run inside an editor, written as CommonJS
    // because nothing compiles it: `tests/cursor/*.js` is handed straight to the
    // extension host. The integration suites get these same names from
    // `"types": ["mocha"]` in their tsconfig, which is a thing a .js file has no
    // equivalent of -- so they are declared here rather than left to `no-undef`,
    // which would otherwise be switched off for the whole file and take every
    // real typo with it.
    files: ['tests/cursor/*.js'],
    languageOptions: {
      globals: {
        suite: 'readonly',
        suiteSetup: 'readonly',
        suiteTeardown: 'readonly',
        test: 'readonly',
        setup: 'readonly',
        teardown: 'readonly',
      },
    },
  }
);
