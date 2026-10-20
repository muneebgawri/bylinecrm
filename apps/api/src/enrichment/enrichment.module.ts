import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { BylineApiModule } from '../byline/byline-api.module';
import { BylineEnricher } from '../byline/byline.enricher';
import { SendingPoolModule } from '../sending-pool/sending-pool.module';
import { DnsEnricher } from './dns';
import { EmailDomainEnricher } from './email-domain';
import { ENRICHERS } from './enricher.port';
import { EnrichmentConsumer } from './enrichment.consumer';
import {
    ENRICHMENT_JOB_ATTEMPTS,
    ENRICHMENT_JOB_BACKOFF_MS,
    ENRICHMENT_MAINTENANCE_QUEUE,
    ENRICHMENT_QUEUE,
} from './enrichment.constants';
import { EnrichmentController } from './enrichment.controllers';
import { EnrichmentQueue } from './enrichment-queue';
import { EnrichmentRunner } from './enrichment-runner';
import { EnrichmentService } from './enrichment.service';
import { EnrichmentSettingsService } from './enrichment-settings.service';
import { EnrichmentSweep } from './enrichment-sweep';
import { EnrichmentWorkers } from './enrichment.workers';
import { ENRICHMENT_FETCH } from './fetch.port';
import { UndiciFetch } from './fetch.undici';
import { GravatarEnricher } from './gravatar';
import { WebsiteEnricher } from './website';

/**
 * Enrichment (P4-2, FR-CRMS-15): the `Enricher` port with the four free sources behind it — the
 * company website, DNS (through the sending pool's port), Gravatar, the addresses themselves — a
 * record's answers kept with source and time, the "better than what is there" rule applied through
 * the records' own update path, _Enrich now_, the outbox consumer that enriches a new or changed
 * record, and the hourly sweep that asks again after the workspace's age. Jobs run on the
 * background pool in a worker process (`ENRICHMENT_WORKER`).
 */
@Module({
    imports: [
        AuthModule,
        RecordsModule,
        SendingPoolModule,
        BylineApiModule,
        BullModule.registerQueue({
            name: ENRICHMENT_QUEUE,
            defaultJobOptions: {
                attempts: ENRICHMENT_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: ENRICHMENT_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
        BullModule.registerQueue({
            name: ENRICHMENT_MAINTENANCE_QUEUE,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
    ],
    controllers: [EnrichmentController],
    providers: [
        { provide: ENRICHMENT_FETCH, useClass: UndiciFetch },
        WebsiteEnricher,
        DnsEnricher,
        GravatarEnricher,
        EmailDomainEnricher,
        BylineEnricher,
        {
            provide: ENRICHERS,
            useFactory: (...sources: unknown[]) => sources,
            inject: [WebsiteEnricher, DnsEnricher, GravatarEnricher, EmailDomainEnricher, BylineEnricher],
        },
        EnrichmentSettingsService,
        EnrichmentQueue,
        EnrichmentRunner,
        EnrichmentWorkers,
        EnrichmentSweep,
        EnrichmentService,
        EnrichmentConsumer,
    ],
})
export class EnrichmentModule {}
