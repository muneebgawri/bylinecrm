import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the receiver saw: headers and the raw body, exactly as sent. */
export interface Received {
    path: string;
    headers: IncomingMessage['headers'];
    body: string;
}

/**
 * An in-process webhook endpoint for the cross-tenant suite (#110). It answers 200 and records every
 * request, so a spec that subscribes an endpoint to count delivery rows gives the webhook worker a
 * receiver that succeeds — an unreachable address makes the worker's failures pile up until it
 * disables the endpoint, and later counts then depend on how long the run took. A path can be told
 * to fail with 500 a number of times first (`failNext`; `Infinity` never recovers), for the specs of
 * retries and of the automatic disable.
 */
export class WebhookReceiver {
    readonly received: Received[] = [];
    private readonly failuresLeft = new Map<string, number>();
    private server: Server | null = null;
    private base = '';

    /** Starts listening on a free port of 127.0.0.1. */
    async start(): Promise<this> {
        const server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const path = req.url ?? '/';
                this.received.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
                const left = this.failuresLeft.get(path) ?? 0;
                if (left > 0) {
                    this.failuresLeft.set(path, left - 1);
                    res.writeHead(500).end('still broken');
                    return;
                }
                res.writeHead(200).end('ok');
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        this.server = server;
        this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return this;
    }

    /** The endpoint URL for `path` (which starts with `/`). */
    url(path: string): string {
        if (!this.server) throw new Error('WebhookReceiver.url called before start');
        return `${this.base}${path}`;
    }

    /** Makes the next `times` requests to `path` fail with 500; `Infinity` keeps failing. */
    failNext(path: string, times: number): void {
        this.failuresLeft.set(path, times);
    }

    /** Lets `path` answer 200 again. */
    recover(path: string): void {
        this.failuresLeft.delete(path);
    }

    /** The requests `path` received. */
    to(path: string): Received[] {
        return this.received.filter((r) => r.path === path);
    }

    async close(): Promise<void> {
        const server = this.server;
        if (!server) return;
        this.server = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
