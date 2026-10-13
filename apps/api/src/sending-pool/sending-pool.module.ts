import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailAccountsModule } from '../mail-accounts/mail-accounts.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { DNS_PORT } from './dns.port';
import { NodeDns } from './dns.node';
import { PostmasterHttp } from './postmaster.http';
import { POSTMASTER_PORT } from './postmaster.port';
import { PostmasterService } from './postmaster.service';
import { PoolMailboxesController, SendingDomainsController, SendingPoolController } from './sending-pool.controllers';
import { SendingDomainsService } from './sending-domains.service';
import { SendingPoolConsumer } from './sending-pool.consumer';
import { SendingPoolService } from './sending-pool.service';

/**
 * The sending pool (P3-2, FR-CRMS-6, -13): the gate every pool send passes (`SendingPoolService.claim`,
 * called by sending), rotation and spacing for sequences (`pick`, `nextSendAt`), bounce and complaint
 * handling and auto-pause (the outbox consumer), sending domains and their DNS checks. A pool mailbox
 * is enrolled when it connects (`enrolPoolMailbox`, inside mail accounts' transaction) and its bounce
 * reports are recorded by sync's writer (`recordBounces`) — both plain functions, so neither module
 * depends on this one. The domain re-check runs on sending's maintenance queue. The DNS port is the
 * application's one (verification reads MX records through it, P3-5), so it is exported. Postmaster
 * Tools (#129) sits behind `POSTMASTER_PORT` — the HTTP adapter here, a fake in tests; its account
 * connects through mail accounts' OAuth flow, so that module is imported.
 */
@Module({
    imports: [AuthModule, SuppressionModule, MailAccountsModule],
    controllers: [SendingPoolController, PoolMailboxesController, SendingDomainsController],
    providers: [
        SendingPoolService,
        SendingDomainsService,
        PostmasterService,
        SendingPoolConsumer,
        { provide: DNS_PORT, useClass: NodeDns },
        { provide: POSTMASTER_PORT, useClass: PostmasterHttp },
    ],
    exports: [SendingPoolService, SendingDomainsService, DNS_PORT],
})
export class SendingPoolModule {}
