import { createApp } from './app';
import { ENV, type Env } from './config/env';

async function bootstrap(): Promise<void> {
    const app = await createApp();
    const env = app.get<Env>(ENV);
    // SIGTERM (a blue/green release draining this colour, P5-4c) closes the listener, lets in-flight
    // requests finish and runs every service's shutdown hook (workers finish their current job).
    app.enableShutdownHooks();
    await app.listen(env.PORT);
}

bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
