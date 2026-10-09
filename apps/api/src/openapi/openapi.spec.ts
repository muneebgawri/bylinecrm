import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '../app';
import { buildOpenApiDocument } from './build';
import { APP_COMPILE_TIMEOUT_MS } from './placeholder-env';
import { OPENAPI_PATH } from './write';

/**
 * The contract freeze (doc 49 §1): `apps/api/openapi.json` is what the UI builds against. If the
 * application's document differs from the file, somebody changed the API without regenerating
 * it — run `pnpm --filter api openapi:write` and commit the diff in the same PR.
 */
describe('the OpenAPI contract', () => {
    it(
        'matches apps/api/openapi.json exactly, and every path is the served one',
        async () => {
            const committed: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
            const current = await buildOpenApiDocument();
            expect(current).toEqual(committed);
            const offPrefix = Object.keys(current.paths).filter(
                (p) => p !== '/health' && !p.startsWith(`/${API_PREFIX}/`),
            );
            expect(offPrefix, 'paths written without the global prefix').toEqual([]);
        },
        APP_COMPILE_TIMEOUT_MS,
    );
});
