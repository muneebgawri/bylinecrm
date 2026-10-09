import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { bodyParsers, parserErrors } from './infra/errors/body-parsing';
import { requestId } from './infra/errors/request-id';
import { openApiDocument } from './openapi/document';

/** Every route lives under this; the web app's dev proxy forwards it. */
export const API_PREFIX = 'api';

/** How every application is created: Nest's own body parser off (see `configureApp`). */
export const APP_OPTIONS = { bufferLogs: true, bodyParser: false } as const;

/**
 * Builds the application the one way everything needs it: the server, the boot and flow tests,
 * and the OpenAPI writer. The prefix, cookie parsing and the docs route are decided in
 * `configureApp`, so a document written from a created application and the one the server serves
 * cannot differ.
 */
export async function createApp(): Promise<NestExpressApplication> {
    return configureApp(await NestFactory.create<NestExpressApplication>(AppModule, APP_OPTIONS));
}

/**
 * Everything applied to an application after it is created. A test that must replace a provider
 * (the Google port, P2-1) creates the application from a testing module with `APP_OPTIONS` and
 * passes it here, so it runs the same middleware, prefix and documentation as the server.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
    // First, so every response — a parser rejection included — carries its request id (P1-1d).
    app.use(requestId);
    // The body parsers are installed here rather than by Nest, so a parser rejection reaches the
    // exception filter as a typed error (P1-1d, `body-parsing.ts`).
    app.use(...bodyParsers(), parserErrors);
    // `/health` stays where the deployer and the web app already look for it.
    app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
    app.use(cookieParser());
    // The client IP for rate limiting comes from the proxy's header once one is in front of us.
    app.set('trust proxy', 1);
    app.enableShutdownHooks();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, openApiDocument(app));
    return app;
}
