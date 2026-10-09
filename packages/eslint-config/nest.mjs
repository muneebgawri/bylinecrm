import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.mjs';

/**
 * The base floor plus what a NestJS service needs: Node globals, and the two type-aware rules
 * that catch the mistakes `tsc` cannot — a promise nobody awaits or returns (a request handler
 * that "succeeds" before its work ran) and an `await` on something that is not thenable.
 * Type information comes from the package's own tsconfig via the project service, so a package
 * that imports this entry point needs no extra wiring. Decorators are handled by the parser
 * (`experimentalDecorators` is read from the tsconfig); no rule here touches them.
 */
export const nest = tseslint.config(...base, {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir: process.cwd() },
    },
    rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/await-thenable': 'error',
    },
});

export default nest;
