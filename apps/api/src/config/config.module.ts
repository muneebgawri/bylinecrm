import { Global, Module } from '@nestjs/common';
import { ENV, parseEnv } from './env';

/** Provides the typed `Env` everywhere. Parsing happens once, when the module is instantiated. */
@Global()
@Module({
    providers: [{ provide: ENV, useFactory: () => parseEnv(process.env) }],
    exports: [ENV],
})
export class ConfigModule {}
