import {
    emptyObjectReport,
    TWENTY_IMPORT_OBJECTS,
    type TwentyImportOverview,
    type TwentyImportPreview,
    type TwentyImportRunView,
} from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importRunPollMs } from '../../../api/importTwenty';
import { ImportTwenty } from './ImportTwenty';
import { apiError, json, renderAt, route, stubApi } from './settingsTestKit';

const WS = 'ws-1';
const KEY = 'twenty-api-key-value-1a2b';

const unconfigured: TwentyImportOverview = {
    settings: { configured: false, baseUrl: null, apiKeyLast4: null, configuredBy: null, updatedAt: null },
    latestRun: null,
    linked: TWENTY_IMPORT_OBJECTS.map((object) => ({ object, count: 0 })),
};
const configured: TwentyImportOverview = {
    ...unconfigured,
    settings: {
        configured: true,
        baseUrl: 'https://crm.example.com',
        apiKeyLast4: '1a2b',
        configuredBy: 'm-1',
        updatedAt: '2026-10-09T09:00:00.000Z',
    },
};
const preview: TwentyImportPreview = {
    checkedAt: '2026-10-09T09:10:00.000Z',
    objects: TWENTY_IMPORT_OBJECTS.map((object) => ({
        object,
        remote: object === 'people' ? 158869 : object === 'companies' ? 93167 : 0,
        linked: object === 'people' ? 12 : 0,
        error: null,
    })),
};
const run = (
    status: TwentyImportRunView['status'],
    overrides: Partial<TwentyImportRunView> = {},
): TwentyImportRunView => ({
    id: 'run-1',
    status,
    mode: 'full',
    since: null,
    phase: status === 'running' ? 'people' : null,
    report: TWENTY_IMPORT_OBJECTS.map((object) => ({
        ...emptyObjectReport(object),
        remote: object === 'people' ? 3 : 0,
        read: object === 'people' ? 3 : 0,
        created: object === 'people' ? 2 : 0,
        merged: object === 'people' ? 1 : 0,
        after: object === 'people' ? 3 : 0,
    })),
    error: null,
    cancelRequested: false,
    startedBy: 'm-1',
    queuedAt: '2026-10-09T09:00:00.000Z',
    startedAt: status === 'queued' ? null : '2026-10-09T09:00:01.000Z',
    finishedAt:
        status === 'succeeded' || status === 'failed' || status === 'cancelled' ? '2026-10-09T09:05:00.000Z' : null,
    ...overrides,
});

const page = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [route('/w/:workspaceId/settings/import-twenty', <ImportTwenty />)],
        `/w/${WS}/settings/import-twenty`,
        capabilities,
    );

describe('P4-UI-2 (doc 48 §11): the importer screen', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is an admin’s: a member who is not one is told so and the connection is never read', async () => {
        const seen = stubApi([]);
        page(['record:read']);
        expect(await screen.findByText(/an admin connects/i)).toBeInTheDocument();
        expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
        expect(seen.some((r) => r.url.includes('/import/twenty'))).toBe(false);
    });

    it('saves the connection and never shows the key again — only its last four characters', async () => {
        let saved = false;
        const seen = stubApi([
            (r) => {
                if (r.method === 'PUT' && r.url.endsWith('/import/twenty/settings')) {
                    saved = true;
                    return json(configured.settings);
                }
                return undefined;
            },
            (r) => (r.url.endsWith('/import/twenty') ? json(saved ? configured : unconfigured) : undefined),
            (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([]) : undefined),
        ]);
        page(['workspace:admin']);
        await userEvent.type(await screen.findByLabelText(/Twenty URL/), 'https://crm.example.com');
        await userEvent.type(screen.getByLabelText(/API key/), KEY);
        await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ baseUrl: 'https://crm.example.com', apiKey: KEY });
        expect(await screen.findByText('•••• 1a2b')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain(KEY);
    });

    it('checks the connection: Twenty’s count per object beside what is mapped here, and a refused key at the key', async () => {
        let refuse = true;
        stubApi([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/import/twenty/preview')
                    ? refuse
                        ? new Response(
                              JSON.stringify({
                                  statusCode: 422,
                                  code: 'unprocessable',
                                  message: 'Twenty refused the API key',
                                  fieldErrors: [{ path: 'apiKey', message: 'Twenty refused the API key' }],
                                  requestId: 'r',
                              }),
                              { status: 422, headers: { 'Content-Type': 'application/json' } },
                          )
                        : json(preview)
                    : undefined,
            (r) => (r.url.endsWith('/import/twenty') ? json(configured) : undefined),
            (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([]) : undefined),
        ]);
        page(['workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Check connection' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/refused the API key/);
        refuse = false;
        await userEvent.click(screen.getByRole('button', { name: 'Check connection' }));
        const table = await screen.findByLabelText('Counts per object');
        expect(within(table).getByText('158,869')).toBeInTheDocument();
        expect(within(table).getByText('93,167')).toBeInTheDocument();
        expect(within(table).getAllByText('Journalists').length).toBeGreaterThan(0);
    });

    it(
        'starts a run and follows it: counts per object as they come in, then the outcome',
        { timeout: 15_000 },
        async () => {
            // The start answers `queued`; the first read finds it running, the next finds it over.
            const views = [run('queued'), run('running'), run('succeeded')];
            let reads = 1;
            const seen = stubApi([
                (r) => (r.method === 'POST' && r.url.endsWith('/import/twenty/runs') ? json(views[0], 202) : undefined),
                (r) => {
                    if (r.method === 'GET' && r.url.endsWith('/import/twenty/runs/run-1')) {
                        const view = views[Math.min(reads, views.length - 1)]!;
                        reads += 1;
                        return json(view);
                    }
                    return undefined;
                },
                (r) => (r.url.endsWith('/import/twenty') ? json(configured) : undefined),
                (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([]) : undefined),
            ]);
            page(['workspace:admin']);
            const start = await screen.findByRole('button', { name: 'Start import' });
            expect(start).toHaveAttribute('data-primary-action');
            await userEvent.click(start);
            await waitFor(() =>
                expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/import/twenty/runs'))).toBe(true),
            );
            expect(seen.find((r) => r.method === 'POST' && r.url.endsWith('/import/twenty/runs'))?.body).toEqual({
                mode: 'full',
            });
            expect(await screen.findByText('Succeeded', {}, { timeout: 6_000 })).toBeInTheDocument();
            const report = screen.getByLabelText('Run report');
            const peopleRow = within(report).getByText('People').closest('[data-row], tr, li')!;
            expect(peopleRow.textContent).toContain('2');
            expect(within(report).getAllByText(/merged/i).length).toBeGreaterThan(0);
        },
    );

    it('a running import can be cancelled, and a failed one says why', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/runs/run-1/cancel')
                    ? json(run('running', { cancelRequested: true }))
                    : undefined,
            (r) =>
                r.method === 'GET' && r.url.endsWith('/import/twenty/runs/run-1') ? json(run('running')) : undefined,
            (r) => (r.url.endsWith('/import/twenty') ? json({ ...configured, latestRun: run('running') }) : undefined),
            (r) =>
                r.url.endsWith('/import/twenty/runs') && r.method === 'GET'
                    ? json([run('failed', { id: 'run-0', error: 'Twenty refused the API key' })])
                    : undefined,
        ]);
        page(['workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Cancel import' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/cancel'))).toBe(true));
        expect(await screen.findByText(/stopping/i)).toBeInTheDocument();
        expect(screen.getByText('Twenty refused the API key')).toBeInTheDocument();
    });

    it('a server refusal to save is shown at the field it names', async () => {
        stubApi([
            (r) => (r.method === 'PUT' ? apiError(400, 'validation.failed', 'baseUrl must use https') : undefined),
            (r) => (r.url.endsWith('/import/twenty') ? json(unconfigured) : undefined),
            (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([]) : undefined),
        ]);
        page(['workspace:admin']);
        await userEvent.type(await screen.findByLabelText(/Twenty URL/), 'http://crm.example.com');
        await userEvent.type(screen.getByLabelText(/API key/), KEY);
        await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/must use https/);
    });
});

describe('P4-UI-2: how often a run is read', () => {
    it('queued and running runs are read with backoff up to a cap; finished ones never again', () => {
        expect(importRunPollMs(run('queued'), 1)).toBe(1_000);
        expect(importRunPollMs(run('running'), 2)).toBe(2_000);
        expect(importRunPollMs(run('running'), 10)).toBe(5_000);
        expect(importRunPollMs(undefined, 1)).toBe(1_000);
        expect(importRunPollMs(run('succeeded'), 3)).toBe(false);
        expect(importRunPollMs(run('failed'), 3)).toBe(false);
        expect(importRunPollMs(run('cancelled'), 3)).toBe(false);
    });
});
