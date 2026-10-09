import base from '@bylinecrm/eslint-config/base';

/**
 * The repo root: scripts and package-level .mjs files that live in no package with a config of
 * its own. A package's own eslint.config.mjs is found first for its files (per-file lookup), so
 * this never overrides one.
 */
export default base;
