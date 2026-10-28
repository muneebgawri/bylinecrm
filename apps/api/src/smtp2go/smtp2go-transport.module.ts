import { Module } from '@nestjs/common';
import { Smtp2GoHttp } from './smtp2go.http';
import { SMTP2GO_PORT } from './smtp2go.port';

/**
 * The port the send job sends through (TRANS-1) — the HTTP adapter here, a fake in tests. Its own module so the send
 * job (`MailSendModule`) can use it while the webhook (`Smtp2GoModule`) uses the send job's one failure write.
 */
@Module({
    providers: [{ provide: SMTP2GO_PORT, useFactory: () => new Smtp2GoHttp() }],
    exports: [SMTP2GO_PORT],
})
export class Smtp2GoTransportModule {}
