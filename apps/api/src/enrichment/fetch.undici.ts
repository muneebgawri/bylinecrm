import { Inject, Injectable } from '@nestjs/common';
import { request, type Dispatcher } from 'undici';
import { ENV, type Env } from '../config/env';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { createWebhookDispatcher } from '../webhooks/url-guard';
import { ENRICHMENT_FETCH_MAX_BYTES, ENRICHMENT_FETCH_REDIRECTS, ENRICHMENT_USER_AGENT } from './enrichment.constants';
import { FetchFailed, type EnrichmentFetch, type FetchedPage } from './fetch.port';

/**
 * The web through undici, on the one guarded dispatcher (the webhook URL guard's: public hosts only,
 * checked at connect time, with its timeouts). A page's body is read up to `ENRICHMENT_FETCH_MAX_BYTES`
 * and cut there — a home page's head and footer are what the sources read.
 */
@Injectable()
export class UndiciFetch implements EnrichmentFetch {
    private readonly dispatcher: Dispatcher;

    constructor(@Inject(ENV) env: Env) {
        this.dispatcher = createWebhookDispatcher({ allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS });
    }

    async get(url: string): Promise<FetchedPage> {
        assertNoOpenTransaction('UndiciFetch.get');
        try {
            let at = url;
            for (let hop = 0; ; hop += 1) {
                const res = await request(at, {
                    method: 'GET',
                    dispatcher: this.dispatcher,
                    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': ENRICHMENT_USER_AGENT },
                });
                const location = redirectTarget(res.statusCode, res.headers.location, at);
                if (location && hop < ENRICHMENT_FETCH_REDIRECTS) {
                    await res.body.dump();
                    at = location;
                    continue;
                }
                const contentType = String(res.headers['content-type'] ?? '');
                return {
                    status: res.statusCode,
                    contentType,
                    finalUrl: at,
                    text: await readUpTo(res.body, ENRICHMENT_FETCH_MAX_BYTES),
                };
            }
        } catch (error) {
            if (error instanceof FetchFailed) throw error;
            throw new FetchFailed(url, describe(error));
        }
    }

    async check(url: string): Promise<boolean> {
        assertNoOpenTransaction('UndiciFetch.check');
        try {
            let at = url;
            for (let hop = 0; ; hop += 1) {
                const res = await request(at, {
                    method: 'HEAD',
                    dispatcher: this.dispatcher,
                    headers: { 'user-agent': ENRICHMENT_USER_AGENT },
                });
                await res.body.dump();
                const location = redirectTarget(res.statusCode, res.headers.location, at);
                if (location && hop < ENRICHMENT_FETCH_REDIRECTS) {
                    at = location;
                    continue;
                }
                return res.statusCode >= 200 && res.statusCode < 300;
            }
        } catch (error) {
            throw new FetchFailed(url, describe(error));
        }
    }
}

/** Where a redirect points, absolute and on the web — or null when the answer is not a redirect. */
function redirectTarget(status: number, location: string | string[] | undefined, from: string): string | null {
    if (![301, 302, 303, 307, 308].includes(status)) return null;
    const raw = Array.isArray(location) ? location[0] : location;
    if (!raw) return null;
    try {
        const url = new URL(raw, from);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
        return null;
    }
}

async function readUpTo(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, max: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
        chunks.push(chunk);
        size += chunk.byteLength;
        if (size >= max) {
            body.destroy?.();
            break;
        }
    }
    return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

function describe(error: unknown): string {
    const code = (error as { code?: string }).code;
    return code ?? (error instanceof Error ? error.message : String(error));
}
