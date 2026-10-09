import type { OpenAPIObject } from '@nestjs/swagger';
import { createApp } from '../app';
import { openApiDocument } from './document';
import { applyPlaceholderEnv } from './placeholder-env';

/**
 * The document as a created-but-never-initialised application produces it — built by the same
 * `createApp` the server runs, so the prefix and every route are the served ones. `openapi:write`
 * saves it to `apps/api/openapi.json`; `openapi.spec.ts` rebuilds it and fails when the file
 * differs — a change to the API is a deliberate regeneration, reviewed as a diff of the contract.
 * Returned as plain JSON so the file and the in-memory object compare the same way.
 */
export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
    applyPlaceholderEnv();
    const app = await createApp();
    try {
        return JSON.parse(JSON.stringify(openApiDocument(app))) as OpenAPIObject;
    } finally {
        // Nothing was initialised, so nothing is connected; this only releases the container.
        await app.close();
    }
}
