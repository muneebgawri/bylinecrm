import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.mjs';

/** The base floor plus what a React package needs: the hooks rules and browser globals. */
export const react = tseslint.config(...base, reactHooks.configs.flat.recommended, {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
});

export default react;
