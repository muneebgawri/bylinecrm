import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env';
import { BACKGROUND_POOL_SIZE, POOL_TIMEOUT_S, REQUEST_POOL_SIZE } from './rls-pool.constants';
import { RlsPrismaService, withPoolDefaults } from './rls-prisma.service';
import { assertNoOpenTransaction, TransactionAcrossNetworkError } from './transaction-scope';
import { WorkspaceContext } from './workspace-context';

describe('withPoolDefaults', () => {
    it('applies the given pool size and the timeout when the URL sets neither', () => {
        const url = new URL(withPoolDefaults('postgresql://u:p@h:5432/db', REQUEST_POOL_SIZE));
        expect(url.searchParams.get('connection_limit')).toBe(String(REQUEST_POOL_SIZE));
        expect(url.searchParams.get('pool_timeout')).toBe(String(POOL_TIMEOUT_S));
        const background = new URL(withPoolDefaults('postgresql://u:p@h:5432/db', BACKGROUND_POOL_SIZE));
        expect(background.searchParams.get('connection_limit')).toBe(String(BACKGROUND_POOL_SIZE));
    });

    it("keeps an operator's explicit values", () => {
        const url = new URL(
            withPoolDefaults('postgresql://u:p@h:5432/db?connection_limit=3&pool_timeout=1', REQUEST_POOL_SIZE),
        );
        expect(url.searchParams.get('connection_limit')).toBe('3');
        expect(url.searchParams.get('pool_timeout')).toBe('1');
    });

    it('leaves the credentials and database untouched', () => {
        const url = new URL(
            withPoolDefaults('postgresql://user:pa%40ss@host:5441/byline?schema=public', REQUEST_POOL_SIZE),
        );
        expect(url.username).toBe('user');
        expect(url.password).toBe('pa%40ss');
        expect(url.pathname).toBe('/byline');
        expect(url.searchParams.get('schema')).toBe('public');
    });
});

describe('observeQueries (P1-4a)', () => {
    const env = (events: boolean) =>
        ({ RLS_DATABASE_URL: 'postgresql://bylinecrm_app:x@localhost:1/db', DB_QUERY_EVENTS: events }) as Env;

    it('throws when the client emits no query events, so a forgotten flag fails loudly', () => {
        const client = new RlsPrismaService(env(false), new WorkspaceContext());
        expect(() => client.observeQueries(() => undefined, { requestId: 'r' })).toThrow(/DB_QUERY_EVENTS=1/);
    });

    it('registers, and stops, when the flag is on', () => {
        const client = new RlsPrismaService(env(true), new WorkspaceContext());
        const stop = client.observeQueries(() => undefined, { requestId: 'r' });
        expect(typeof stop).toBe('function');
        stop();
    });
});

/** A transaction stand-in: runs the callback with a client whose `set_config` call does nothing. */
type TxFn = (tx: unknown) => Promise<unknown>;
const runCallback = (fn: TxFn) => fn({ $executeRaw: () => Promise.resolve(0) });

const txStartTimeout = () =>
    new Prisma.PrismaClientKnownRequestError(
        'Transaction API error: Unable to start a transaction in the given time.',
        {
            code: 'P2028',
            clientVersion: 'test',
        },
    );

describe('withWorkspace pools (#86, FR-CRMS-2)', () => {
    const env = { RLS_DATABASE_URL: 'postgresql://bylinecrm_app:x@localhost:1/db', DB_QUERY_EVENTS: false } as Env;
    const ws = '00000000-0000-4000-8000-000000000001';
    const setup = () => {
        const context = new WorkspaceContext();
        const client = new RlsPrismaService(env, context);
        const background = (client as unknown as { backgroundClient: { $transaction: (fn: TxFn) => Promise<unknown> } })
            .backgroundClient;
        const onRequest = vi.spyOn(client, '$transaction').mockImplementation(runCallback as never);
        const onBackground = vi.spyOn(background, '$transaction').mockImplementation(runCallback as never);
        return { context, client, onRequest, onBackground };
    };
    afterEach(() => vi.restoreAllMocks());

    it('serves a request on the request pool', async () => {
        const { context, client, onRequest, onBackground } = setup();
        await context.begin(() => client.withWorkspace(ws, () => Promise.resolve('done')), 'req-1');
        expect(onRequest).toHaveBeenCalledTimes(1);
        expect(onBackground).not.toHaveBeenCalled();
    });

    it('serves a job, and anything outside a request, on the background pool', async () => {
        const { context, client, onRequest, onBackground } = setup();
        await client.withWorkspace(ws, () => Promise.resolve('outside any scope'));
        await context.run({ workspaceId: ws, capabilities: new Set() }, () =>
            client.withWorkspace(() => Promise.resolve('in a job')),
        );
        expect(onBackground).toHaveBeenCalledTimes(2);
        expect(onRequest).not.toHaveBeenCalled();
    });

    it('retries a transaction that could not start (P2028) and then succeeds', async () => {
        const { client, onBackground } = setup();
        onBackground.mockRejectedValueOnce(txStartTimeout());
        await expect(client.withWorkspace(ws, () => Promise.resolve('second time'))).resolves.toBe('second time');
        expect(onBackground).toHaveBeenCalledTimes(2);
    });

    it('does not retry a P2028 once the callback has started: the work would run twice', async () => {
        const { client, onBackground } = setup();
        onBackground.mockImplementation((async (fn: TxFn) => {
            await runCallback(fn);
            throw txStartTimeout();
        }) as never);
        const work = vi.fn(() => Promise.resolve('ran'));
        await expect(client.withWorkspace(ws, work)).rejects.toMatchObject({ code: 'P2028' });
        expect(work).toHaveBeenCalledTimes(1);
    });

    it('lets a network call be refused inside a tenant transaction, and allowed outside one', async () => {
        const { client } = setup();
        expect(() => assertNoOpenTransaction('Gmail getMessage')).not.toThrow();
        await expect(
            client.withWorkspace(ws, () => {
                assertNoOpenTransaction('Gmail getMessage');
                return Promise.resolve();
            }),
        ).rejects.toBeInstanceOf(TransactionAcrossNetworkError);
        expect(() => assertNoOpenTransaction('Gmail getMessage')).not.toThrow();
    });
});
