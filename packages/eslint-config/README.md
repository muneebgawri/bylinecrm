# @bylinecrm/eslint-config

One ESLint floor for every package. A package imports an entry point; it never copies a config
(doc 49 §0: one definition of each thing). Formatting is Prettier's; nothing here is stylistic, and
every rule is `error` because each package lints with `--max-warnings 0`.

| Entry point                      | For                       | Adds on top of `base`                                                                                                                                                               |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bylinecrm/eslint-config/base`  | any TypeScript package    | `@eslint/js` recommended, `typescript-eslint` recommended, `no-explicit-any`, `no-unused-vars` with `_` opt-out, `no-empty` without empty catches; Node globals for `*.mjs` scripts |
| `@bylinecrm/eslint-config/react` | `apps/web`, `packages/ui` | React hooks rules, browser globals                                                                                                                                                  |
| `@bylinecrm/eslint-config/nest`  | `apps/api`                | Node globals; type-aware `no-floating-promises` and `await-thenable` via the package's own tsconfig (project service)                                                               |

A package's `eslint.config.mjs` is two lines:

```js
import nest from '@bylinecrm/eslint-config/nest';
export default nest;
```

The root `lint-staged` runs one `eslint --fix` over every staged `.ts/.tsx/.mts/.mjs` file; ESLint
finds each file's nearest `eslint.config.mjs` (`--flag v10_config_lookup_from_file`), so a
staged file is checked by exactly the config its package declares.

Adding a rule: add it here, run `pnpm lint` at the root, fix what it finds in the same PR. A rule
is never disabled per package or per file to make the scan quiet; a real exception gets a sentence
next to an inline disable, and a reviewer reads the sentence.
