import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env';

/** What the relay hands a message it lets through to: Google's SMTP relay service, which delivers it as Google. */
export interface RelaySubmitter {
    submit(message: { from: string; to: readonly string[]; raw: Buffer }): Promise<void>;
}

export const RELAY_SUBMITTER = Symbol('RELAY_SUBMITTER');

/**
 * Submission to RELAY_UPSTREAM_HOST (smtp-relay.gmail.com) over STARTTLS, no password: the Workspace's SMTP
 * relay service allows this server's address (Admin console → Gmail → Routing → SMTP relay service). The
 * message goes exactly as it arrived, the stamp header in front; Google then signs and delivers it as it does
 * every other message of that user, so SPF, DKIM and DMARC are Google's and unchanged.
 */
@Injectable()
export class GoogleRelaySubmitter implements RelaySubmitter {
    private readonly transport: Transporter;

    constructor(@Inject(ENV) env: Pick<Env, 'RELAY_UPSTREAM_HOST' | 'RELAY_UPSTREAM_PORT' | 'RELAY_HOSTNAME'>) {
        this.transport = createTransport({
            host: env.RELAY_UPSTREAM_HOST,
            port: env.RELAY_UPSTREAM_PORT,
            secure: false,
            requireTLS: true,
            name: env.RELAY_HOSTNAME,
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 60_000,
        });
    }

    async submit(message: { from: string; to: readonly string[]; raw: Buffer }): Promise<void> {
        await this.transport.sendMail({ envelope: { from: message.from, to: [...message.to] }, raw: message.raw });
    }
}
