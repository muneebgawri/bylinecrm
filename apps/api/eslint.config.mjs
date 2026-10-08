import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the API. Formatting is Prettier's job and no stylistic rule is enabled here, so
 * the two can never disagree about a line. Type-aware rules are not enabled: correctness belongs
 * to `pnpm typecheck`, which covers specs too. Warnings are errors by policy (`--max-warnings 0`
 * in the script), so every rule here is `error` — a warning in a repo with none is a rule nobody
 * reads.
 */
export default tseslint.config(
    { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/eslint.config.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: { ...globals.node },
            parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        rules: {
            // A library that ships no types takes an inline disable with a sentence saying why.
            '@typescript-eslint/no-explicit-any': 'error',
            // An unused parameter is usually an interface being honoured; underscore opts out.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            // An empty catch must say why it swallows.
            'no-empty': ['error', { allowEmptyCatch: false }],
            'no-async-promise-executor': 'error',
        },
    },
);
