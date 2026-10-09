import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { SESSION_COOKIE } from '@bylinecrm/shared';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { VERSION } from '../version';

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
