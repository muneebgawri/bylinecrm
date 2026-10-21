import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { createWebhookDispatcher, isPublicAddress, parseWebhookUrl } from './url-guard';

describe('webhook url guard', () => {
    it('knows which addresses no public host can own', () => {
        for (const bad of [
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.1',
            '169.254.169.254',
            '0.0.0.0',
            '100.64.0.1',
            '224.0.0.1',
            '::1',
            '::',
            'fc00::1',
            'fd12::1',
            'fe80::1',
            '::ffff:10.0.0.1',
            '::ffff:127.0.0.1',
            'not-an-ip',
        ]) {
            expect(isPublicAddress(bad), bad).toBe(false);
        }
        for (const good of [
            '8.8.8.8',
            '172.32.0.1',
            '192.167.1.1',
            '93.184.216.34',
            '2606:4700::1111',
            '::ffff:93.184.216.34',
        ]) {
            expect(isPublicAddress(good), good).toBe(true);
        }
    });

    it('refuses the shapes an endpoint may not have', () => {
        const strict = { allowPrivate: false };
        expect(() => parseWebhookUrl('http://example.com/hook', strict)).toThrow(/https/);
        expect(() => parseWebhookUrl('https://user:pw@example.com/hook', strict)).toThrow(/credentials/);
        expect(() => parseWebhookUrl('https://127.0.0.1/hook', strict)).toThrow(/public/);
        expect(() => parseWebhookUrl('https://[::1]/hook', strict)).toThrow(/public/);
        expect(() => parseWebhookUrl('https://10.0.0.5:8443/admin', strict)).toThrow(/public/);
        expect(() => parseWebhookUrl('not a url', strict)).toThrow(/valid/);
        expect(parseWebhookUrl('https://hooks.example.com/in?x=1', strict).hostname).toBe('hooks.example.com');
        expect(parseWebhookUrl('https://93.184.216.34/hook', strict).hostname).toBe('93.184.216.34');
    });

    it('the development exception admits http and private targets, and nothing else changes', () => {
        const dev = { allowPrivate: true };
        expect(parseWebhookUrl('http://127.0.0.1:4567/hook', dev).port).toBe('4567');
        expect(() => parseWebhookUrl('ftp://127.0.0.1/hook', dev)).toThrow(/https/);
        expect(() => parseWebhookUrl('http://u:p@127.0.0.1/hook', dev)).toThrow(/credentials/);
    });
});

describe('the guarded dispatcher connects (production 2026-10-14)', () => {
    it('answers a lookup that asks for every address, so a hostname connects instead of ERR_INVALID_IP_ADDRESS', async () => {
        const server = createServer((_req, res) => res.end('ok')).listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const { port } = server.address() as AddressInfo;
        const dispatcher = createWebhookDispatcher({ allowPrivate: true });
        try {
            const res = await request(`http://localhost:${port}/`, { dispatcher });
            expect(res.statusCode).toBe(200);
            expect(await res.body.text()).toBe('ok');
        } finally {
            await dispatcher.close();
            server.close();
        }
    });
});

describe('public hosts the enrichment sources reach', () => {
    it('admits Gravatar’s addresses (Automattic 192.0.64.0/18, and IPv6): the guard never refused them', () => {
        for (const address of ['192.0.80.239', '192.0.80.242', '2a04:fa87:fffe::c000:4902']) {
            expect(isPublicAddress(address), address).toBe(true);
        }
    });
});
