import react from '@bylinecrm/eslint-config/react';

export default [
    ...react,
    {
        files: ['src/**/*.tsx'],
        ignores: ['src/**/*.spec.tsx'],
        rules: {
            'no-restricted-syntax': [
                'error',
                // Kept from the shared React config: a rule set here replaces it, never merges.
                ...react.at(-1).rules['no-restricted-syntax'].slice(1),
                {
                    // Every loading state is one component (P1-UI-12, #95): role, live region, name, skeleton.
                    selector: "JSXAttribute[name.name='aria-busy']",
                    message:
                        'Use <LoadingRegion label> from @bylinecrm/ui for a loading state instead of aria-busy by hand.',
                },
            ],
        },
    },
];
