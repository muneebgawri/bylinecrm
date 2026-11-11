import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { EventsModule } from '../events/events.module';
import { InfraModule } from '../infra/infra.module';
import { GoogleNetblocks } from './google-netblocks';
import { RelayJudge } from './relay-judge';
import { RelayServer } from './relay-server';
import { GoogleRelaySubmitter, RELAY_SUBMITTER } from './relay-submit';

/**
 * GUARD-4 (#355): the outbound relay. The judge is the module the API could also host; the listener and the
 * submitter are the relay process's (`relay/main.ts`), which runs this module and nothing else of the API.
 */
@Module({
    providers: [RelayJudge, GoogleNetblocks, { provide: RELAY_SUBMITTER, useClass: GoogleRelaySubmitter }, RelayServer],
    exports: [RelayJudge, RelayServer, GoogleNetblocks, RELAY_SUBMITTER],
})
export class RelayModule {}

/**
 * The relay process's root: configuration, the database clients and the domain-event writer (its outbox relay
 * is off in this process — `OUTBOX_RELAY=0` in the service's environment — so the API's delivers what the
 * judge records), and the relay. No HTTP, no workers, no queues.
 */
@Module({
    imports: [ConfigModule, InfraModule, EventsModule, RelayModule],
})
export class RelayAppModule {}
