import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { SESSION_COOKIE } from '@bylinecrm/shared';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from '../app.module';
import { VERSION } from '../version';
import { applyPlaceholderEnv } from './placeholder-env';

/** The OpenAPI document of a created application — the one `/api/docs` serves and the one on disk. */
export function openApiDocument(app: INestApplication): OpenAPIObject {
    const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
            .setTitle('BylineCRM API')
            .setVersion(VERSION)
            .addCookieAuth(SESSION_COOKIE)
            .addBearerAuth()
            .build(),
    );
    return cleanupOpenApiDoc(document);
}

/**
 * The document as a compiled-but-never-connected application produces it. `openapi:write` saves
 * it to `apps/api/openapi.json`; `openapi.spec.ts` rebuilds it and fails when the file differs —
 * so a change to the API is a deliberate regeneration, reviewed as a diff of the contract.
 * Returned as plain JSON so the file and the in-memory object compare the same way.
 */
export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
    applyPlaceholderEnv();
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
        return JSON.parse(JSON.stringify(openApiDocument(app))) as OpenAPIObject;
    } finally {
        // Nothing was initialised, so nothing is connected; this only releases the container.
        await app.close();
    }
}
