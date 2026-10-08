import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Same floor as the API's config, plus the hooks rules React needs. Formatting is Prettier's. */
export default tseslint.config(
    { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/eslint.config.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            globals: { ...globals.browser },
            parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
            'no-empty': ['error', { allowEmptyCatch: false }],
        },
    },
);
