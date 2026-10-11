import type { INestApplication } from '@nestjs/common';
import {
    DocumentBuilder,
    type OpenAPIObject,
    type OperationObject,
    type ResponsesObject,
    type SchemaObject,
    SwaggerModule,
} from '@nestjs/swagger';
import { REQUEST_ID_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { z } from 'zod';
import { VERSION } from '../version';
import { RETURNS_EXTENSION, apiError, componentName, responseSchemas, type ReturnsSpec } from './responses';

const SCHEMA_REF = '#/components/schemas/';

/** The header component's name in the document; the header's wire name is the shared `REQUEST_ID_HEADER`. */
const REQUEST_ID_COMPONENT = 'RequestId';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

/**
 * A stable operation id: `<module>_<handler>`, the controller's name without `Controller` and with a
 * lower-case first letter — `people_list`, `apiKeys_create`. Generated clients name their functions
 * after it, so it must not change when a file moves.
 */
export function operationId(controllerKey: string, methodKey: string): string {
    const module = controllerKey.replace(/Controller$/, '');
    return `${module.charAt(0).toLowerCase()}${module.slice(1)}_${methodKey}`;
}

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
        { operationIdFactory: operationId },
    );
    return applyResponses(cleanupOpenApiDoc(document));
}

/**
 * Adds the response components (from the zod registry) and attaches each route's declared
 * response to the 2xx status Nest generated for it; every operation also gets the one error
 * envelope for `4XX` and `5XX`.
 */
function applyResponses(document: OpenAPIObject): OpenAPIObject {
    const components = (document.components ??= {});
    const schemas = (components.schemas ??= {});
    const generated = z.toJSONSchema(responseSchemas, {
        target: 'openapi-3.0',
        io: 'input',
        uri: (id) => `${SCHEMA_REF}${id}`,
    }).schemas;
    for (const [name, schema] of Object.entries(generated)) {
        if (name in schemas)
            throw new Error(`response schema "${name}" collides with a request schema of the same name`);
        const { $id: _id, ...rest } = schema as Record<string, unknown>;
        schemas[name] = rest as SchemaObject;
    }
    const errorRef = { $ref: `${SCHEMA_REF}${componentName(apiError)}` };
    // Every response carries the request id (P1-1d); one header component, referenced everywhere.
    (components.headers ??= {})[REQUEST_ID_COMPONENT] = {
        description: 'The id of this request; quote it when reporting a problem. An inbound well-formed id is echoed.',
        schema: { type: 'string' },
    };
    const requestIdHeader = { [REQUEST_ID_HEADER]: { $ref: `#/components/headers/${REQUEST_ID_COMPONENT}` } };

    for (const item of Object.values(document.paths)) {
        for (const method of HTTP_METHODS) {
            const operation = item[method] as (OperationObject & Record<string, unknown>) | undefined;
            if (!operation) continue;
            const spec = operation[RETURNS_EXTENSION] as ReturnsSpec | undefined;
            delete operation[RETURNS_EXTENSION];
            operation.responses = withBody(operation.responses, spec, errorRef);
            for (const range of ['4XX', '5XX'] as const) {
                operation.responses[range] ??= {
                    description: 'The error envelope',
                    content: { 'application/json': { schema: errorRef } },
                };
            }
            for (const response of Object.values(operation.responses)) {
                if (!response || '$ref' in response) continue;
                response.headers = { ...response.headers, ...requestIdHeader };
            }
        }
    }
    return document;
}

function withBody(
    responses: ResponsesObject,
    spec: ReturnsSpec | undefined,
    errorRef: { $ref: string },
): ResponsesObject {
    if (!spec) return responses;
    const success = Object.keys(responses).find((code) => /^2\d\d$/.test(code));
    if (spec.kind === 'redirect') {
        const { [success ?? '']: _dropped, ...rest } = responses;
        return { ...rest, [String(spec.status)]: { description: 'A redirect; the `Location` header says where.' } };
    }
    if (spec.kind === 'not-implemented') {
        const { [success ?? '']: _dropped, ...rest } = responses;
        return {
            ...rest,
            '501': {
                description: 'Not implemented yet; the body is the error envelope.',
                content: { 'application/json': { schema: errorRef } },
            },
        };
    }
    if (!success) throw new Error('a route that declares a body has no 2xx response to put it on');
    const content =
        spec.kind === 'file'
            ? { [spec.contentType]: { schema: { type: 'string', format: 'binary' } as SchemaObject } }
            : {
                  'application/json': {
                      schema: spec.array
                          ? ({ type: 'array', items: { $ref: `${SCHEMA_REF}${spec.schema}` } } as SchemaObject)
                          : { $ref: `${SCHEMA_REF}${spec.schema}` },
                  },
              };
    const generatedResponse = responses[success];
    const description =
        generatedResponse && 'description' in generatedResponse && generatedResponse.description
            ? generatedResponse.description
            : 'OK';
    return { ...responses, [success]: { description, content } };
}
