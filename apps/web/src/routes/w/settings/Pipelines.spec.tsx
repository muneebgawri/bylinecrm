import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const detail = () =>
    renderAt(
        [route('/w/:workspaceId/settings/pipelines/:pipelineId', <PipelineDetail />)],
        `/w/${WS}/settings/pipelines/${P}`,
        ['deal:read', 'pipeline:configure'],
    );

describe('FR-CRMS-9: pipeline settings', () => {
    afterEach(() => vi.unstubAllGlobals());

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
    });

    it('refused delete: says why in the server’s words and offers the deals in that pipeline', async () => {
        api([
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/stages/s-contacted')
                    ? apiError(409, 'conflict', '2 deal(s) are in this stage (including the trash); move them first')
                    : undefined,
        ]);
        detail();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Contacted' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Delete stage' }));
        expect(
            await screen.findByText('2 deal(s) are in this stage (including the trash); move them first'),
        ).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Open this pipeline’s deals' })).toHaveAttribute(
            'href',
            `/w/${WS}/deals?pipeline=${P}`,
        );
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
