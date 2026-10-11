import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
    WEBHOOK_DELIVERY_HEADER,
    WEBHOOK_EVENT_HEADER,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER,
    type WebhookEnvelope,
} from '@bylinecrm/shared';
import { type Dispatcher, request } from 'undici';
import { ENV, type Env } from '../config/env';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { signatureHeader } from './signature';
import { createWebhookDispatcher } from './url-guard';
import { WEBHOOK_ERROR_MAX_CHARS, WEBHOOK_MAX_RESPONSE_BYTES, WEBHOOK_USER_AGENT } from './webhooks.constants';

export interface SendInput {
    url: string;
    /** The current secret first; the previous one too while a rotation's grace window is open. */
    secrets: readonly string[];
    envelope: WebhookEnvelope;
}

/** What one HTTP attempt came to. `ok` is a 2xx; anything else, including no response, is not. */
export interface SendOutcome {
    ok: boolean;
    statusCode: number | null;
    /** For the delivery log: the status line or the transport error, cut to a readable length. */
    error: string | null;
}

/**
 * The one HTTP sender: builds the body once, signs it with every secret that is valid, and POSTs
 * it with the headers a receiver verifies. A real delivery and a test send both come through
 * here, so there is one definition of what a request looks like on the wire.
 */
@Injectable()
export class WebhookSender implements OnModuleDestroy {
    private readonly dispatcher: Dispatcher;

    constructor(@Inject(ENV) env: Env) {
        this.dispatcher = createWebhookDispatcher({ allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS });
    }

    async onModuleDestroy(): Promise<void> {
        await this.dispatcher.close();
    }

    async send(input: SendInput): Promise<SendOutcome> {
        // Never inside a tenant transaction (#86): a slow receiver would hold a pooled connection.
        assertNoOpenTransaction('webhook delivery');
        const body = JSON.stringify(input.envelope);
        const timestamp = Math.floor(Date.now() / 1000);
        try {
            const res = await request(input.url, {
                method: 'POST',
                dispatcher: this.dispatcher,
                headers: {
                    'content-type': 'application/json',
                    'user-agent': WEBHOOK_USER_AGENT,
                    [WEBHOOK_SIGNATURE_HEADER]: signatureHeader(input.secrets, timestamp, body),
                    [WEBHOOK_EVENT_HEADER]: input.envelope.event,
                    [WEBHOOK_DELIVERY_HEADER]: input.envelope.id,
                    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
                },
                body,
            });
            const text = await readUpTo(res.body, WEBHOOK_MAX_RESPONSE_BYTES);
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            return {
                ok,
                statusCode: res.statusCode,
                error: ok ? null : clip(`HTTP ${res.statusCode}${text ? `: ${text}` : ''}`),
            };
        } catch (error) {
            return { ok: false, statusCode: null, error: clip(error instanceof Error ? error.message : String(error)) };
        }
    }
}

/** Reads the response body up to a limit and discards the rest, so a hostile receiver cannot fill memory. */
async function readUpTo(body: Dispatcher.ResponseData['body'], limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (size < limit) {
            chunks.push(buffer.subarray(0, limit - size));
            size += buffer.length;
        }
    }
    return Buffer.concat(chunks).toString('utf8').trim();
}

function clip(message: string): string {
    return message.length > WEBHOOK_ERROR_MAX_CHARS ? `${message.slice(0, WEBHOOK_ERROR_MAX_CHARS - 1)}…` : message;
}
