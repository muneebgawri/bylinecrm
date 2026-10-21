import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toasts } from '@bylinecrm/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineView, RuleView, StageView } from '../../../api/types';
import { PipelineDetail } from './PipelineDetail';
import { Pipelines } from './Pipelines';
import { apiError, json, renderAt, route, stubApi, type FakeRequest } from './settingsTestKit';

const WS = 'ws-1';
const P = 'p-1';
const stage = (id: string, name: string, position: number, kind: StageView['kind'] = 'open'): StageView => ({
    id,
    pipelineId: P,
    name,
    position,
    probability: 20,
    kind,
    daysThreshold: null,
    colour: kind === 'won' ? 'ok' : 'accent',
});
const STAGES = [
    stage('s-new', 'New', 1),
    stage('s-contacted', 'Contacted', 2),
    stage('s-replied', 'Replied', 3),
    stage('s-won', 'Won', 4, 'won'),
];
const pipeline: PipelineView = {
    id: P,
    name: 'Sales pipeline',
    isDefault: true,
    position: 1,
    stages: STAGES,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
};
const rule: RuleView = {
    id: 'r-1',
    pipelineId: P,
    event: 'email.replied',
    toStageId: 's-replied',
    allowBackward: false,
    enabled: true,
};

function api(extra: ((r: FakeRequest) => Response | undefined)[] = []) {
    return stubApi([
        ...extra,
        (r) => (r.method === 'GET' && r.url.endsWith('/pipelines') ? json([pipeline]) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith(`/pipelines/${P}`) ? json(pipeline) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith(`/pipelines/${P}/rules`) ? json([rule]) : undefined),
    ]);
}

/** The server's refusal to delete a stage that still holds deals (P1-2b), counts in `details`. */
const stageRefusal = (details: { liveDeals: number; trashedDeals: number }) =>
    json(
        {
            statusCode: 409,
            code: 'conflict',
            message: `${details.liveDeals + details.trashedDeals} deal(s) are in this stage (including the trash); move them first`,
            details,
            requestId: 'req-test',
        },
        409,
    );

const detail = () =>
    renderAt(
        [route('/w/:workspaceId/settings/pipelines/:pipelineId', <PipelineDetail />)],
        `/w/${WS}/settings/pipelines/${P}`,
        ['deal:read', 'pipeline:configure'],
    );

describe('FR-CRMS-9: pipeline settings', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('lists the workspace pipelines, marking the default, each linking to its stages', async () => {
        api();
        renderAt([route('/w/:workspaceId/settings/pipelines', <Pipelines />)], `/w/${WS}/settings/pipelines`, [
            'deal:read',
            'pipeline:configure',
        ]);
        const link = await screen.findByRole('link', { name: 'Sales pipeline' });
        expect(link).toHaveAttribute('href', `/w/${WS}/settings/pipelines/${P}`);
        expect(screen.getByText('Default')).toBeInTheDocument();
    });

    it('shows the stages in order and the rules as sentences', async () => {
        api();
        detail();
        const stages = await screen.findByRole('list', { name: 'Stages' });
        expect(
            within(stages)
                .getAllByRole('listitem')
                .map((li) => within(li).getByTestId('stage-name').textContent),
        ).toEqual(['New', 'Contacted', 'Replied', 'Won']);
        expect(await screen.findByText('When a reply arrives, move the deal to Replied')).toBeInTheDocument();
    });

    it('moves a stage down from its menu and sends the whole new order', async () => {
        const seen = api([
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/stages/order')
                    ? json({ ...pipeline, stages: [STAGES[1], STAGES[0], STAGES[2], STAGES[3]] })
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for New' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
            stageIds: ['s-contacted', 's-new', 's-replied', 's-won'],
        });
        // FR-CRMS-UI-8: the menu path is announced like a drag, by name and position.
        expect(await screen.findByText('New moved to position 2 of 4.')).toBeInTheDocument();
    });

    it('FR-CRMS-9: a stage holding deals is deleted by moving them first — counts from the server, one request', async () => {
        const seen = api([
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-contacted')
                    ? stageRefusal({ liveDeals: 2, trashedDeals: 1 })
                    : undefined,
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-contacted?moveDealsTo=s-replied')
                    ? json(null, 204)
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Contacted' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Delete stage' }));

        // The refusal turns the same dialog into the move step, with the server's counts.
        expect(await screen.findByText('Move 3 deals (1 in the trash) to another stage first.')).toBeInTheDocument();
        const target = screen.getByRole('combobox', { name: 'Move deals to' });
        // Only open stages other than the one going: a delete never closes deals.
        await userEvent.click(target);
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual(['New', 'Replied']);
        await userEvent.click(screen.getByRole('option', { name: 'Replied' }));
        await userEvent.click(screen.getByRole('button', { name: 'Move deals and delete' }));

        await waitFor(() =>
            expect(seen.filter((r) => r.method === 'DELETE').map((r) => r.url.replace(/^.*\/pipelines\//, ''))).toEqual(
                [`${P}/stages/s-contacted`, `${P}/stages/s-contacted?moveDealsTo=s-replied`],
            ),
        );
        await waitFor(() =>
            expect(toasts.all().map((t) => t.title)).toContain('Moved 3 deals to Replied and deleted Contacted'),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('FR-CRMS-9: a won stage offers the other won stages first, picked by default, so its deals stay won', async () => {
        const withClosedWon = { ...pipeline, stages: [...STAGES, stage('s-closed-won', 'Closed Won', 5, 'won')] };
        const seen = api([
            (r) => (r.method === 'GET' && r.url.endsWith(`/pipelines/${P}`) ? json(withClosedWon) : undefined),
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-won')
                    ? stageRefusal({ liveDeals: 176, trashedDeals: 0 })
                    : undefined,
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-won?moveDealsTo=s-closed-won')
                    ? json(null, 204)
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Won' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Delete stage' }));
        await screen.findByText('Move 176 deals to another stage first.');

        // The same-kind stage is chosen already, and no reopen warning shows for it.
        const target = screen.getByRole('combobox', { name: 'Move deals to' });
        expect(target).toHaveTextContent('Closed Won (stays won)');
        expect(screen.queryByText(/they reopen/)).not.toBeInTheDocument();
        await userEvent.click(target);
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual(['Closed Won (stays won)', 'New', 'Contacted', 'Replied']);
        // Picking an open stage brings the reopen hint back.
        await userEvent.click(screen.getByRole('option', { name: 'New' }));
        expect(await screen.findByText('These deals were won; they reopen in an open stage.')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('combobox', { name: 'Move deals to' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Closed Won (stays won)' }));
        await userEvent.click(screen.getByRole('button', { name: 'Move deals and delete' }));

        await waitFor(() =>
            expect(seen.some((r) => r.method === 'DELETE' && r.url.endsWith('?moveDealsTo=s-closed-won'))).toBe(true),
        );
    });

    it('FR-CRMS-9: over the move limit, the server’s 413 message is shown and the step stays open', async () => {
        api([
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-contacted')
                    ? stageRefusal({ liveDeals: 6000, trashedDeals: 0 })
                    : undefined,
            (r) =>
                r.method === 'DELETE' && r.url.includes('moveDealsTo=')
                    ? apiError(
                          413,
                          'payload_too_large',
                          'This stage holds 6000 deals; at most 5000 can be moved at once',
                      )
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Contacted' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Delete stage' }));
        await screen.findByText('Move 6,000 deals to another stage first.');
        await userEvent.click(screen.getByRole('combobox', { name: 'Move deals to' }));
        await userEvent.click(await screen.findByRole('option', { name: 'New' }));
        await userEvent.click(screen.getByRole('button', { name: 'Move deals and delete' }));
        expect(
            await screen.findByText('This stage holds 6000 deals; at most 5000 can be moved at once'),
        ).toBeInTheDocument();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('FR-CRMS-9: a refusal for another reason (a rule points at the stage) shows the server’s words, no move step', async () => {
        api([
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-replied')
                    ? apiError(409, 'conflict', 'A stage rule moves deals into this stage; change the rule first')
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Replied' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Delete stage' }));
        expect(
            await screen.findByText('A stage rule moves deals into this stage; change the rule first'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'Move deals to' })).not.toBeInTheDocument();
    });

    it('adds a rule from the editor, with its sentence shown before saving', async () => {
        const seen = api([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/rules')
                    ? json({ ...rule, id: 'r-2', event: 'meeting.booked' }, 201)
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(within(dialog).getByRole('combobox', { name: 'When' }));
        await userEvent.click(await screen.findByRole('option', { name: 'A meeting is booked' }));
        await userEvent.click(within(dialog).getByRole('combobox', { name: 'Move the deal to' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Contacted' }));
        expect(within(dialog).getByText('When a meeting is booked, move the deal to Contacted')).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST')).toBe(true));
        expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
            event: 'meeting.booked',
            toStageId: 's-contacted',
            allowBackward: false,
            enabled: true,
        });
    });

    it('without pipeline:configure the page is read-only (FR-CRMS-UI-6)', async () => {
        api();
        renderAt(
            [route('/w/:workspaceId/settings/pipelines/:pipelineId', <PipelineDetail />)],
            `/w/${WS}/settings/pipelines/${P}`,
            ['deal:read'],
        );
        await screen.findByRole('list', { name: 'Stages' });
        expect(screen.queryByRole('button', { name: 'Actions for New' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add stage' })).not.toBeInTheDocument();
    });
});
