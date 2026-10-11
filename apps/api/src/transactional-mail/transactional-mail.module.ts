import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { MemoryTransport } from './memory.transport';
import { ResendTransport } from './resend.transport';
import {
    TRANSACTIONAL_MAIL_FAILED_RETENTION_S,
    TRANSACTIONAL_MAIL_JOB_ATTEMPTS,
    TRANSACTIONAL_MAIL_JOB_BACKOFF_MS,
    TRANSACTIONAL_MAIL_QUEUE,
} from './transactional-mail.constants';
import { AccountMail } from './account-mail';
import { TransactionalMailer } from './transactional-mailer';
import { TransactionalMailWorkers } from './transactional-mail.workers';
import { TRANSACTIONAL_MAIL_TRANSPORT, type TransactionalMailTransport } from './transport.port';

/**
 * Transactional mail (#93, D-246): sign-in verification, invitations, password reset — never
 * outreach, which goes through the workspace's own Gmail mailboxes. Resend when `RESEND_API_KEY` is
 * set (boot requires it in production); the in-process memory transport otherwise.
 */
@Module({
    imports: [
        BullModule.registerQueue({
            name: TRANSACTIONAL_MAIL_QUEUE,
            defaultJobOptions: {
                attempts: TRANSACTIONAL_MAIL_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: TRANSACTIONAL_MAIL_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: { age: TRANSACTIONAL_MAIL_FAILED_RETENTION_S },
            },
        }),
    ],
    providers: [
        {
            provide: TRANSACTIONAL_MAIL_TRANSPORT,
            inject: [ENV],
            useFactory: (env: Env): TransactionalMailTransport =>
                env.RESEND_API_KEY
                    ? new ResendTransport(env.RESEND_API_KEY)
                    : new MemoryTransport(env.NODE_ENV !== 'production'),
        },
        TransactionalMailer,
        TransactionalMailWorkers,
        AccountMail,
    ],
    exports: [TransactionalMailer, AccountMail],
})
export class TransactionalMailModule {}
