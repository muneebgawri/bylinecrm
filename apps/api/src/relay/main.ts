import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { GoogleNetblocks } from './google-netblocks';
import { RelayServer } from './relay-server';
import { RelayAppModule } from './relay.module';

/**
 * GUARD-4's process (`node dist/relay/main.js`): the same image as the API, a different entrypoint. Google's
 * address list is read before the listener opens, so the first connection is judged by a real list.
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.createApplicationContext(RelayAppModule);
    app.enableShutdownHooks();
    await app.get(GoogleNetblocks).start();
    await app.get(RelayServer).listen();
}

bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
