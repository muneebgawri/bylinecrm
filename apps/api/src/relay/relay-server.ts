import { readFile, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from 'smtp-server';
import { ENV, type Env } from '../config/env';
import { GoogleNetblocks } from './google-netblocks';
import { MessageHeaders } from './headers';
import { RelayJudge, RELAY_STAMP_HEADER } from './relay-judge';
import { RELAY_SUBMITTER, type RelaySubmitter } from './relay-submit';

/** Recipients one message may name; Gmail's own limit is lower. */
export const RELAY_MAX_RECIPIENTS = 100;
/** How often the TLS files are checked for a renewal. */
export const TLS_RELOAD_MS = 10 * 60 * 1000;

type SmtpError = Error & { responseCode?: number };

function reply(code: number, text: string): SmtpError {
    const error: SmtpError = new Error(text);
    error.responseCode = code;
    return error;
}

/**
 * GUARD-4's listener: the SMTP server Google Workspace routes a Sales rep's outside mail to (Admin console →
 * Gmail → Routing, "Change route" on the compliance rule). One message is one transaction: the envelope names
 * the sender and every recipient, the headers say what it answers, the judge decides, and the answer is
 * final — `250` once Google's relay service has taken the stamped message, `550` with the bounce text (Gmail
 * shows the rep the text), or `451` when the CRM could not decide (the database away: Google tries again for
 * hours, so nothing is lost and nothing leaves unjudged). Only Google's addresses may connect; there is no
 * login. The body is never read: the headers are parsed, the bytes are forwarded as they came.
 */
@Injectable()
export class RelayServer implements OnModuleDestroy {
    private readonly logger = new Logger(RelayServer.name);
    private server: SMTPServer | null = null;
    private tlsTimer: NodeJS.Timeout | null = null;
    private tlsSeen = '';

    constructor(
        @Inject(ENV)
        private readonly env: Pick<
            Env,
            'RELAY_PORT' | 'RELAY_HOSTNAME' | 'RELAY_TLS_CERT' | 'RELAY_TLS_KEY' | 'RELAY_MAX_BYTES'
        >,
        private readonly judge: RelayJudge,
        @Inject(RELAY_SUBMITTER) private readonly submitter: RelaySubmitter,
        private readonly netblocks: GoogleNetblocks,
    ) {}

    /** Starts listening; returns the bound port (`0` asks for a free one, in tests). */
    async listen(port = this.env.RELAY_PORT, host = '0.0.0.0'): Promise<number> {
        const tls = await this.readTls();
        this.server = new SMTPServer({
            name: this.env.RELAY_HOSTNAME,
            banner: 'Byline CRM outbound relay',
            size: this.env.RELAY_MAX_BYTES,
            disabledCommands: ['AUTH'],
            authOptional: true,
            hideSTARTTLS: tls === null,
            ...(tls ?? {}),
            disableReverseLookup: true,
            onConnect: (session, callback) => this.onConnect(session, callback),
            onRcptTo: (address, session, callback) => {
                if (session.envelope.rcptTo.length >= RELAY_MAX_RECIPIENTS) {
                    callback(reply(452, '4.5.3 too many recipients'));
                    return;
                }
                callback();
            },
            onData: (stream, session, callback) => {
                void this.onData(stream, session)
                    .then((text) => callback(null, text))
                    .catch((error: unknown) => callback(error as Error));
            },
        });
        this.server.on('error', (error) => this.logger.warn(`smtp: ${error.message}`));
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, host, () => {
                this.server!.off('error', reject);
                resolve();
            });
        });
        if (tls) {
            this.tlsTimer = setInterval(() => void this.reloadTls(), TLS_RELOAD_MS);
            this.tlsTimer.unref();
        }
        const bound = (this.server.server.address() as AddressInfo).port;
        this.logger.log(
            `listening on ${host}:${bound}${tls ? ' (STARTTLS)' : ' (no TLS)'} as ${this.env.RELAY_HOSTNAME ?? 'localhost'}`,
        );
        return bound;
    }

    async close(): Promise<void> {
        if (this.tlsTimer) clearInterval(this.tlsTimer);
        this.tlsTimer = null;
        const server = this.server;
        this.server = null;
        if (!server) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    onModuleDestroy(): Promise<void> {
        return this.close();
    }

    private onConnect(session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        if (!this.netblocks.allows(session.remoteAddress)) {
            this.logger.warn(`refused connection from ${session.remoteAddress}`);
            callback(reply(554, '5.7.1 this relay serves Google Workspace only'));
            return;
        }
        callback();
    }

    private async onData(stream: SMTPServerDataStream, session: SMTPServerSession): Promise<string> {
        const started = Date.now();
        const from = session.envelope.mailFrom === false ? null : session.envelope.mailFrom.address.toLowerCase();
        const recipients = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        if (stream.sizeExceeded) throw reply(552, '5.3.4 message too large');
        if (!from) throw reply(550, '5.7.1 a sender is required');
        const raw = Buffer.concat(chunks);
        const headers = MessageHeaders.parse(raw);
        if (headers.has(RELAY_STAMP_HEADER)) throw reply(550, '5.7.1 already relayed (loop)');

        const verdict = await this.judge.judge({ from, recipients, headers }).catch((error: unknown) => {
            this.logger.error(`judge failed for ${from}: ${error instanceof Error ? error.message : String(error)}`);
            throw reply(451, '4.3.0 Byline CRM could not decide; try again later');
        });
        switch (verdict.kind) {
            case 'unknown_sender':
                this.logger.warn(`refused ${from}: not a workspace mailbox`);
                throw reply(550, '5.7.1 not a Byline CRM mailbox');
            case 'refuse':
                throw reply(550, `5.7.1 ${verdict.text}`);
            case 'relay': {
                const stamped = Buffer.concat([
                    Buffer.from(`${RELAY_STAMP_HEADER}: ${verdict.stamp}\r\n`, 'latin1'),
                    raw,
                ]);
                try {
                    await this.submitter.submit({ from, to: recipients, raw: stamped });
                } catch (error) {
                    this.logger.error(
                        `upstream refused ${from}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    throw reply(451, '4.4.1 upstream unavailable; try again later');
                }
                this.logger.log(`relayed ${from} to ${recipients.length} recipient(s) in ${Date.now() - started}ms`);
                return `250 2.0.0 relayed ${verdict.stamp}`;
            }
        }
    }

    private async readTls(): Promise<{ key: Buffer; cert: Buffer } | null> {
        const { RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: keyPath } = this.env;
        if (!certPath || !keyPath) return null;
        const [key, cert, keyStat, certStat] = await Promise.all([
            readFile(keyPath),
            readFile(certPath),
            stat(keyPath),
            stat(certPath),
        ]);
        this.tlsSeen = `${keyStat.mtimeMs}:${certStat.mtimeMs}`;
        return { key, cert };
    }

    /** A renewed certificate (certbot writes new files) is picked up without a restart. */
    private async reloadTls(): Promise<void> {
        const { RELAY_TLS_CERT: certPath, RELAY_TLS_KEY: keyPath } = this.env;
        if (!certPath || !keyPath || !this.server) return;
        try {
            const [keyStat, certStat] = await Promise.all([stat(keyPath), stat(certPath)]);
            if (`${keyStat.mtimeMs}:${certStat.mtimeMs}` === this.tlsSeen) return;
            const tls = await this.readTls();
            if (tls) this.server.updateSecureContext(tls);
            this.logger.log('tls certificate reloaded');
        } catch (error) {
            this.logger.warn(`tls not reloaded: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
