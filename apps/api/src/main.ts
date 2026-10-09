import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SESSION_COOKIE } from '@bylinecrm/shared';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';
import { VERSION } from './version';

/** Every route lives under this prefix; the web app's dev proxy forwards it. */
export const API_PREFIX = 'api';

/** Builds the application the way `main` and the boot tests both need it. */
export async function createApp(): Promise<NestExpressApplication> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
    // `/health` stays where the deployer and the web app already look for it.
    app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
    app.use(cookieParser());
    // The client IP for rate limiting comes from the proxy's header once one is in front of us.
    app.set('trust proxy', 1);
    app.enableShutdownHooks();

    const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
            .setTitle('BylineCRM API')
            .setVersion(VERSION)
            .addCookieAuth(SESSION_COOKIE)
            .addBearerAuth()
            .build(),
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, cleanupOpenApiDoc(document));
    return app;
}

async function bootstrap(): Promise<void> {
    const app = await createApp();
    const env = app.get<Env>(ENV);
    await app.listen(env.PORT);
}

if (require.main === module) {
    bootstrap().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
