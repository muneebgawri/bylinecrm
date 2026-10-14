import {
    emptyObjectReport,
    TWENTY_IMPORT_OBJECTS,
    type TwentyImportOverview,
    type TwentyImportPreview,
    type TwentyImportRunView,
    type TwentyImportSyncView,
} from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importRunPollMs } from '../../../api/importTwenty';
import { ImportTwenty } from './ImportTwenty';
import { apiError, json, renderAt, route, stubApi } from './settingsTestKit';

const WS = 'ws-1';
const KEY = 'twenty-api-key-value-1a2b';

const sync = (overrides: Partial<TwentyImportSyncView> = {}): TwentyImportSyncView => ({
    interval: 'off',
    nextRunAt: null,
    failures: 0,
    lastError: null,
    cutoverAt: null,
    ...overrides,
});
const unconfigured: TwentyImportOverview = {
    settings: { configured: false, baseUrl: null, apiKeyLast4: null, configuredBy: null, updatedAt: null },
    latestRun: null,
    sync: sync(),
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
    scheduled: false,
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
        expect(within(table).getAllByText('Companies').length).toBeGreaterThan(0);
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

    it('#156 D-252: a reconcile run offers itself, and what is missing in Twenty is listed for review, never deleted', async () => {
        const reconciled = run('succeeded', {
            id: 'run-2',
            mode: 'reconcile',
            report: TWENTY_IMPORT_OBJECTS.map((object) => ({
                ...emptyObjectReport(object),
                missingInSource: object === 'companies' ? 1 : 0,
            })),
        });
        stubApi([
            (r) => (r.url.endsWith('/import/twenty') ? json({ ...configured, latestRun: reconciled }) : undefined),
            (r) =>
                r.method === 'GET' && r.url.includes('/import/twenty/missing')
                    ? json({
                          items: [
                              {
                                  object: 'companies',
                                  externalId: 'tw-c-2',
                                  localType: 'company',
                                  localId: 'c-2',
                                  name: 'Northwind Traders',
                                  missingSince: '2026-10-09T09:05:00.000Z',
                              },
                          ],
                          nextCursor: null,
                      })
                    : undefined,
            (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([reconciled]) : undefined),
        ]);
        page(['workspace:admin']);
        expect(await screen.findByRole('radio', { name: 'Reconcile with Twenty' })).toBeInTheDocument();
        const missing = await screen.findByRole('region', { name: 'Missing in Twenty' });
        expect(within(missing).getByRole('link', { name: 'Northwind Traders' })).toHaveAttribute(
            'href',
            `/w/${WS}/companies/c-2`,
        );
        expect(within(missing).getByText(/1 company/)).toBeInTheDocument();
        expect(within(missing).getByText(/nothing is deleted/i)).toBeInTheDocument();
    });

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

    it('#185 automatic sync: the interval is a workspace setting with the next run shown, failures in a row are shown with their error, and Stop syncing (cutover) turns it off and records the moment', async () => {
        let state = sync({
            interval: 'hourly',
            nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            failures: 3,
            lastError: 'Twenty refused the API key',
        });
        const seen = stubApi([
            (r) => {
                if (r.method === 'PUT' && r.url.endsWith('/import/twenty/sync')) {
                    state = sync({ ...state, interval: (r.body as TwentyImportSyncView).interval });
                    return json(state);
                }
                return undefined;
            },
            (r) => {
                if (r.method === 'POST' && r.url.endsWith('/import/twenty/sync/cutover')) {
                    state = sync({ cutoverAt: '2026-10-09T10:00:00.000Z' });
                    return json(state);
                }
                return undefined;
            },
            (r) => (r.url.endsWith('/import/twenty') ? json({ ...configured, sync: state }) : undefined),
            (r) =>
                r.url.endsWith('/import/twenty/runs') && r.method === 'GET'
                    ? json([
                          run('failed', {
                              id: 'run-9',
                              mode: 'changes',
                              scheduled: true,
                              startedBy: null,
                              error: 'Twenty refused the API key',
                          }),
                      ])
                    : undefined,
        ]);
        page(['workspace:admin']);
        const select = await screen.findByRole('combobox', { name: 'Automatic sync' });
        expect(select).toHaveTextContent('Hourly');
        expect(screen.getByText(/next sync/i)).toBeInTheDocument();
        const failing = screen.getByText(/3 automatic syncs in a row failed/);
        expect(failing).toHaveTextContent('Twenty refused the API key');
        expect(failing).toHaveTextContent(/admins have been emailed/i);
        // An automatic run is listed as one.
        expect(await screen.findByText(/Automatic · Changes/)).toBeInTheDocument();

        await userEvent.click(select);
        await userEvent.click(await screen.findByRole('option', { name: 'Daily' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT' && r.url.endsWith('/import/twenty/sync'))?.body).toEqual({
                interval: 'daily',
            }),
        );
        expect(await screen.findByRole('combobox', { name: 'Automatic sync' })).toHaveTextContent('Daily');

        await userEvent.click(screen.getByRole('button', { name: 'Stop syncing (cutover)' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Stop syncing' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/import/twenty/sync/cutover'))).toBe(true));
        expect(await screen.findByText(/syncing stopped/i)).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Automatic sync' })).toHaveTextContent('Off');
        expect(screen.queryByRole('button', { name: 'Stop syncing (cutover)' })).not.toBeInTheDocument();
    });

    it('#185 a run report counts the records whose edits here were kept over Twenty’s as conflicts, and names the fields', async () => {
        const kept = run('succeeded', {
            id: 'run-3',
            mode: 'changes',
            scheduled: true,
            report: TWENTY_IMPORT_OBJECTS.map((object) => ({
                ...emptyObjectReport(object),
                ...(object === 'people'
                    ? { read: 2, updated: 2, conflicts: 1, kept: [{ externalId: 'tw-p-1', fields: ['jobTitle'] }] }
                    : {}),
            })),
        });
        stubApi([
            (r) => (r.url.endsWith('/import/twenty') ? json({ ...configured, latestRun: kept }) : undefined),
            (r) => (r.url.endsWith('/import/twenty/runs') && r.method === 'GET' ? json([kept]) : undefined),
        ]);
        page(['workspace:admin']);
        const report = await screen.findByLabelText('Run report');
        expect(within(report).getByText('Conflicts')).toBeInTheDocument();
        const details = within(report).getByText(/1 record kept BylineCRM’s value/);
        await userEvent.click(details);
        expect(within(report).getByText(/tw-p-1/)).toHaveTextContent('jobTitle');
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
