import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleNetblocks } from './google-netblocks';
import { RELAY_STAMP_HEADER, type RelayInput, type RelayJudge, type RelayVerdict } from './relay-judge';
import { RelayServer } from './relay-server';
import type { RelaySubmitter } from './relay-submit';

/**
 * The listener's contract with Google: what each verdict answers on the wire, the stamp on what leaves, the
 * loop guard, and `451` when the CRM cannot decide — with a judge and an upstream of the test's choosing.
 */
describe('RelayServer', () => {
    let server: RelayServer;
    let port: number;
    let allow = true;
    const inputs: RelayInput[] = [];
    const submitted: { from: string; to: readonly string[]; raw: Buffer }[] = [];
    let verdict: () => Promise<RelayVerdict> = () =>
        Promise.resolve({ kind: 'relay', workspaceId: 'w', stamp: 'stamp-1' });
    let upstream: () => Promise<void> = () => Promise.resolve();

    const judge = {
        judge: (input: RelayInput) => {
            inputs.push(input);
            return verdict();
        },
    } as unknown as RelayJudge;
    const submitter: RelaySubmitter = {
        submit: async (message) => {
            await upstream();
            submitted.push(message);
        },
    };
    const netblocks = { allows: () => allow } as unknown as GoogleNetblocks;

    const send = (to: string[] = ['bo@bo.test'], headers: Record<string, string> = {}) =>
        createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }).sendMail({
            envelope: { from: 'Ana@pinion.test', to },
            raw: `From: ana@pinion.test\r\nTo: ${to.join(', ')}\r\nSubject: Hi\r\nMessage-ID: <m1@pinion.test>\r\n${Object.entries(
                headers,
            )
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join('')}\r\nhello\r\n`,
        });

    beforeAll(async () => {
        server = new RelayServer(
            {
                RELAY_PORT: 0,
                RELAY_HOSTNAME: 'relay.test',
                RELAY_TLS_CERT: undefined,
                RELAY_TLS_KEY: undefined,
                RELAY_MAX_BYTES: 2000,
            },
            judge,
            submitter,
            netblocks,
        );
        port = await server.listen(0, '127.0.0.1');
    });
    afterAll(() => server.close());

    it('relays what the judge allows, stamped, with the lower-cased envelope', async () => {
        const info = await send(['Bo@bo.test', 'cc@cc.test']);
        expect(info.response).toContain('250 2.0.0 relayed stamp-1');
        expect(inputs.at(-1)).toMatchObject({ from: 'ana@pinion.test', recipients: ['bo@bo.test', 'cc@cc.test'] });
        expect(inputs.at(-1)!.headers.get('subject')).toBe('Hi');
        const last = submitted.at(-1)!;
        expect(last.from).toBe('ana@pinion.test');
        expect(last.to).toEqual(['bo@bo.test', 'cc@cc.test']);
        expect(last.raw.toString().startsWith(`${RELAY_STAMP_HEADER}: stamp-1\r\nFrom: ana@pinion.test`)).toBe(true);
        expect(last.raw.toString()).toContain('\r\n\r\nhello');
    });

    it('bounces a refusal with its text, and an unknown sender', async () => {
        verdict = () => Promise.resolve({ kind: 'refuse', text: "bo@bo.test: Ben's lead — ask them.\nOpen the CRM." });
        await expect(send()).rejects.toMatchObject({
            responseCode: 550,
            response: expect.stringContaining("Ben's lead"),
        });
        verdict = () => Promise.resolve({ kind: 'unknown_sender' });
        await expect(send()).rejects.toMatchObject({
            responseCode: 550,
            response: expect.stringContaining('not a Byline CRM mailbox'),
        });
    });

    it('answers 451 when the judge or the upstream fails, so Google tries again', async () => {
        verdict = () => Promise.reject(new Error('database away'));
        await expect(send()).rejects.toMatchObject({ responseCode: 451 });
        verdict = () => Promise.resolve({ kind: 'relay', workspaceId: 'w', stamp: 'stamp-2' });
        upstream = () => Promise.reject(new Error('upstream down'));
        await expect(send()).rejects.toMatchObject({ responseCode: 451 });
        upstream = () => Promise.resolve();
    });

    it('refuses a message that already carries the stamp (a loop)', async () => {
        await expect(send(['bo@bo.test'], { [RELAY_STAMP_HEADER]: 'x' })).rejects.toMatchObject({
            responseCode: 550,
            response: expect.stringContaining('loop'),
        });
    });

    it('refuses a message over the size limit', async () => {
        const big = createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }).sendMail({
            envelope: { from: 'ana@pinion.test', to: ['bo@bo.test'] },
            raw: `Subject: big\r\n\r\n${'x'.repeat(3000)}\r\n`,
        });
        await expect(big).rejects.toMatchObject({ responseCode: expect.any(Number) });
        expect(submitted.filter((m) => m.raw.toString().includes('big'))).toEqual([]);
    });

    it('refuses a connection from outside Google', async () => {
        allow = false;
        await expect(send()).rejects.toMatchObject({ responseCode: 554 });
        allow = true;
    });
});
