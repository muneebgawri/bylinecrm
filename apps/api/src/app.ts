import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { openApiDocument } from './openapi/document';

/** Every route lives under this; the web app's dev proxy forwards it. */
export const API_PREFIX = 'api';

/**
 * Builds the application the one way everything needs it: the server, the boot and flow tests,
 * and the OpenAPI writer. The prefix, cookie parsing and the docs route are decided here, so a
 * document written from a created application and the one the server serves cannot differ.
 */
export async function createApp(): Promise<NestExpressApplication> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
    // `/health` stays where the deployer and the web app already look for it.
    app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
    app.use(cookieParser());
    // The client IP for rate limiting comes from the proxy's header once one is in front of us.
    app.set('trust proxy', 1);
    app.enableShutdownHooks();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, openApiDocument(app));
    return app;
}
