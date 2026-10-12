import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.mjs';

/** The base floor plus what a React package needs: the hooks rules and browser globals. */
export const react = tseslint.config(...base, reactHooks.configs.flat.recommended, {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
        // `incompatible-library` reports React Compiler compatibility: that the compiler would skip a
        // component using a library whose hooks return mutable instances (TanStack Table, Virtual).
        // This build does not run the React Compiler (no compiler plugin in any Vite config), so the
        // warning describes nothing that happens. Re-enable it in the same change that adopts the
        // compiler; components using those libraries then opt out with 'use no memo'. (P1-UI-4.)
        'react-hooks/incompatible-library': 'off',
        'no-restricted-syntax': [
            'error',
            {
                // A plain element's generic role prohibits a name (ARIA 1.2): screen readers skip it, and
                // the a11y gate fails it only when the element happens to render. Caught here instead (#95).
                selector:
                    "JSXOpeningElement[name.name=/^(div|span|p)$/]:has(JSXAttribute[name.name='aria-label']):not(:has(JSXAttribute[name.name='role']))",
                message:
                    'aria-label on an element with no role is ignored by assistive tech: give it a role, or use <LoadingRegion label> for a loading state.',
            },
        ],
    },
});

export default react;
