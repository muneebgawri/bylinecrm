import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { AccountMail } from './account-mail';
import { MailOutbox } from './mail-outbox';
import { MailOutboxRelay } from './mail-outbox-relay';
import { MemoryTransport } from './memory.transport';
import { ResendTransport } from './resend.transport';
import { TRANSACTIONAL_MAIL_TRANSPORT, type TransactionalMailTransport } from './transport.port';

/**
 * Transactional mail (#93, D-246): sign-in verification, invitations, password reset — never
 * outreach, which goes through the workspace's own Gmail mailboxes. Recorded in the writing
 * transaction (`MailOutbox`), sent after the commit (`MailOutboxRelay`): Resend when `RESEND_API_KEY`
 * is set (boot requires it in production), the in-process memory transport otherwise.
 */
@Module({
    providers: [
        {
            provide: TRANSACTIONAL_MAIL_TRANSPORT,
            inject: [ENV],
            useFactory: (env: Env): TransactionalMailTransport =>
                env.RESEND_API_KEY
                    ? new ResendTransport(env.RESEND_API_KEY)
                    : new MemoryTransport(env.NODE_ENV !== 'production'),
        },
        MailOutbox,
        MailOutboxRelay,
        AccountMail,
    ],
    exports: [AccountMail, MailOutboxRelay],
})
export class TransactionalMailModule {}
