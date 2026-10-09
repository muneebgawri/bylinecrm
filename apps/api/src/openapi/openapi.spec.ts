import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from './document';
import { OPENAPI_PATH } from './write';

/**
 * The contract freeze (doc 49 §1): `apps/api/openapi.json` is what the UI builds against. If the
 * application's document differs from the file, somebody changed the API without regenerating
 * it — run `pnpm --filter api openapi:write` and commit the diff in the same PR.
 */
describe('the OpenAPI contract', () => {
    it('matches apps/api/openapi.json exactly', async () => {
        const committed: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
        const current = await buildOpenApiDocument();
        expect(current).toEqual(committed);
    }, 30_000);
});
