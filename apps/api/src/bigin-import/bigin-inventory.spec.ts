import { describe, expect, it, vi } from 'vitest';
import type { RlsPrismaService } from '../infra/rls-prisma.service';
import type { SecretBox } from '../infra/secret-box';
import { BiginApiError } from './bigin.http';
import type { BiginApi } from './bigin.port';
import { BiginInventoryService } from './bigin-inventory';

/** BIGIN-1, before the cutover: every module Bigin serves, counted against what BylineCRM imported. */
describe('FR-CRMS-25 BIGIN-1 Bigin inventory', () => {
    it('counts every served module, marks the imported ones with their links, and lists what is not carried over', async () => {
        const tx = {
            biginImportSettings: {
                findFirst: vi.fn().mockResolvedValue({
                    accountsUrl: 'https://accounts.zoho.example',
                    apiUrl: 'https://www.zohoapis.example',
                    clientId: 'client',
                    clientSecretCiphertext: 'sealed-secret',
                    refreshTokenCiphertext: 'sealed-refresh',
                }),
            },
            biginImportLink: {
                count: vi.fn(({ where }: { where: { object: string } }) =>
                    Promise.resolve({ Accounts: 10, Contacts: 20, Deals: 30, Notes: 5, Tasks: 7 }[where.object] ?? 0),
                ),
            },
        };
        const rls = {
            withWorkspace: (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx),
        } as unknown as RlsPrismaService;
        const secrets = { open: (v: string) => v.replace('sealed-', '') } as unknown as SecretBox;
        const bigin = {
            modules: vi.fn().mockResolvedValue([
                { apiName: 'Contacts', label: 'Contacts', apiSupported: true },
                { apiName: 'Tasks', label: 'Tasks', apiSupported: true },
                { apiName: 'Calls', label: 'Calls', apiSupported: true },
                { apiName: 'Products', label: 'Products', apiSupported: true },
                { apiName: 'Home', label: 'Home', apiSupported: false },
            ]),
            count: vi.fn((_c: unknown, module: string) => {
                if (module === 'Calls')
                    return Promise.reject(new BiginApiError(400, 'Bigin could not read "Calls"', true));
                return Promise.resolve({ Contacts: 21, Tasks: 400, Products: 10 }[module] ?? null);
            }),
            fieldDefinitions: vi.fn((_c: unknown, module: string) =>
                Promise.resolve(
                    module === 'Contacts'
                        ? [
                              { apiName: 'PR_LINK', label: 'PR link', type: 'website', custom: true, values: [] },
                              { apiName: 'Budget', label: 'Budget', type: 'currency', custom: true, values: [] },
                          ]
                        : module === 'Deals'
                          ? [
                                {
                                    apiName: 'Pipeline',
                                    label: 'Pipeline',
                                    type: 'picklist',
                                    custom: false,
                                    values: ['Sales', 'Renewals'],
                                },
                                {
                                    apiName: 'Stage',
                                    label: 'Stage',
                                    type: 'picklist',
                                    custom: false,
                                    values: ['New', 'Won'],
                                },
                            ]
                          : [],
                ),
            ),
        } as unknown as BiginApi;

        const inventory = await new BiginInventoryService(rls, secrets, bigin).take('ws');

        expect(inventory.modules).toEqual([
            { apiName: 'Contacts', label: 'Contacts', remote: 21, imported: true, linked: 20, error: null },
            { apiName: 'Tasks', label: 'Tasks', remote: 400, imported: true, linked: 7, error: null },
            {
                apiName: 'Calls',
                label: 'Calls',
                remote: null,
                imported: true,
                linked: 0,
                error: 'Bigin could not read "Calls"',
            },
            // BylineCRM has no products: counted, never imported.
            { apiName: 'Products', label: 'Products', remote: 10, imported: false, linked: null, error: null },
        ]);
        // The client secret and refresh token are opened for the read only.
        expect((bigin.count as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
            clientSecret: 'secret',
            refreshToken: 'refresh',
        });
        expect(inventory.customFields).toEqual([
            { module: 'Contacts', label: 'PR link', apiName: 'PR_LINK', type: 'website', carried: true },
            { module: 'Contacts', label: 'Budget', apiName: 'Budget', type: 'currency', carried: false },
        ]);
        expect(inventory.pipelines).toEqual(['Sales', 'Renewals']);
        expect(inventory.stages).toEqual(['New', 'Won']);
    });

    it('stops at refused credentials rather than reporting a module as unreadable', async () => {
        const tx = {
            biginImportSettings: {
                findFirst: vi.fn().mockResolvedValue({
                    accountsUrl: 'a',
                    apiUrl: 'b',
                    clientId: 'c',
                    clientSecretCiphertext: 'x',
                    refreshTokenCiphertext: 'y',
                }),
            },
            biginImportLink: { count: vi.fn().mockResolvedValue(0) },
        };
        const rls = {
            withWorkspace: (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx),
        } as unknown as RlsPrismaService;
        const bigin = {
            modules: vi.fn().mockResolvedValue([{ apiName: 'Tasks', label: 'Tasks', apiSupported: true }]),
            count: vi.fn().mockRejectedValue(new BiginApiError(401, 'refused', true)),
        } as unknown as BiginApi;
        await expect(
            new BiginInventoryService(rls, { open: (v: string) => v } as unknown as SecretBox, bigin).take('ws'),
        ).rejects.toThrow('refused');
    });
});
