import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GoogleOAuthHttp } from './google-oauth.http';
import { GOOGLE_OAUTH_PORT } from './google-oauth.port';
import { MailOAuthCallbackController, MailboxesController, OAuthClientController } from './mail-accounts.controllers';
import { MailboxTokens } from './mailbox-tokens.service';
import { MailboxesService } from './mailboxes.service';
import { OAuthClientsService } from './oauth-clients.service';

/**
 * Mail accounts (P2-1): the workspace's own Google OAuth client and the mailboxes connected
 * through it. Google sits behind `GOOGLE_OAUTH_PORT` — the HTTP adapter here, a fake in tests.
 * `MailboxTokens` is exported for the workers that use a mailbox (sync P2-2, send P2-3), and
 * `MailboxesService` for routes about a mailbox that live in those packages (its visibility rules)
 * and for the Postmaster Tools connect (P3-2b, #129), which runs through the same flow;
 * `OAuthClientsService` for the pool to refresh that grant through the workspace's client.
 */
@Module({
    imports: [AuthModule],
    controllers: [OAuthClientController, MailboxesController, MailOAuthCallbackController],
    providers: [
        { provide: GOOGLE_OAUTH_PORT, useClass: GoogleOAuthHttp },
        OAuthClientsService,
        MailboxesService,
        MailboxTokens,
    ],
    exports: [MailboxTokens, MailboxesService, OAuthClientsService, GOOGLE_OAUTH_PORT],
})
export class MailAccountsModule {}
