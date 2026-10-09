import { createApp } from './app';
import { ENV, type Env } from './config/env';

async function bootstrap(): Promise<void> {
    const app = await createApp();
    const env = app.get<Env>(ENV);
    await app.listen(env.PORT);
}

bootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
