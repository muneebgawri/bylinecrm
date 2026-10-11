import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '../app';
import { buildOpenApiDocument } from './build';
import { APP_COMPILE_TIMEOUT_MS } from './placeholder-env';
import { OPENAPI_PATH } from './write';

type Operation = {
    operationId?: string;
    parameters?: { name: string; in: string }[];
    responses: Record<string, { content?: Record<string, unknown> }>;
};
type Document = {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown> };
};

const committed = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Document;

function operations(document: Document): { label: string; path: string; operation: Operation }[] {
    return Object.entries(document.paths).flatMap(([path, item]) =>
        Object.entries(item).map(([method, operation]) => ({
            label: `${method.toUpperCase()} ${path}`,
            path,
            operation,
        })),
    );
}

/** A success the route documents: a body, a redirect, an empty `204`, or a declared `501`. */
function documentsItsSuccess(operation: Operation): boolean {
    return Object.entries(operation.responses).some(
        ([code, response]) =>
            (/^2\d\d$/.test(code) && (code === '204' || response.content !== undefined)) ||
            code === '302' ||
            code === '303' ||
            code === '501',
    );
}

/**
 * The contract freeze (doc 49 §1): `apps/api/openapi.json` is what the UI builds against. If the
 * application's document differs from the file, somebody changed the API without regenerating
 * it — run `pnpm --filter api openapi:write` and commit the diff in the same PR. The rest of the
 * suite holds the file to what a client generator needs (P1-1c).
 */
describe('the OpenAPI contract', () => {
    it(
        'matches apps/api/openapi.json exactly, and every path is the served one',
        async () => {
            const current = await buildOpenApiDocument();
            expect(current).toEqual(committed);
            const offPrefix = Object.keys(current.paths).filter(
                (p) => p !== '/health' && !p.startsWith(`/${API_PREFIX}/`),
            );
            expect(offPrefix, 'paths written without the global prefix').toEqual([]);
        },
        APP_COMPILE_TIMEOUT_MS,
    );

    it('documents a success response for every operation', () => {
        const missing = operations(committed)
            .filter(({ operation }) => !documentsItsSuccess(operation))
            .map(({ label }) => label);
        expect(missing, 'add @Returns / @ReturnsFile / @Redirects to these routes').toEqual([]);
    });

    it('documents the error envelope for every operation', () => {
        const missing = operations(committed)
            .filter(({ operation }) => !operation.responses['4XX'] || !operation.responses['5XX'])
            .map(({ label }) => label);
        expect(missing).toEqual([]);
    });

    it('declares every templated path segment as a path parameter', () => {
        const undeclared = operations(committed).flatMap(({ label, path, operation }) => {
            const declared = new Set((operation.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name));
            return [...path.matchAll(/\{(\w+)\}/g)]
                .map((match) => match[1] as string)
                .filter((name) => !declared.has(name))
                .map((name) => `${label}: {${name}}`);
        });
        expect(undeclared).toEqual([]);
    });

    it('gives every operation a unique, stable `<module>_<handler>` id', () => {
        const ids = operations(committed).map(({ operation }) => operation.operationId);
        const malformed = ids.filter((id) => id === undefined || !/^[a-z][A-Za-z]*_[a-z][A-Za-z]*$/.test(id));
        expect(malformed).toEqual([]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('resolves every schema reference', () => {
        const refs = [...JSON.stringify(committed).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
            (match) => match[1] as string,
        );
        const dangling = [...new Set(refs)].filter((name) => !(name in committed.components.schemas));
        expect(dangling).toEqual([]);
    });
});
