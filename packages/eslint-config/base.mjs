import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The floor every TypeScript package stands on. Formatting is Prettier's; these are correctness
 * rules only. `--max-warnings 0` is set by each package's script, so a warning here is a failure.
 */
export const base = tseslint.config(
    {
        ignores: [
            '**/dist/**',
            '**/coverage/**',
            '**/node_modules/**',
            '**/storybook-static/**',
            '**/eslint.config.mjs',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: { parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-empty': ['error', { allowEmptyCatch: false }],
        },
    },
    // A package's own scripts (`*.mjs`) run under Node, not a browser.
    { files: ['**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
);

export default base;
