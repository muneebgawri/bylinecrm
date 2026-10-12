import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrolmentBatchView, SequenceEnrolmentView, SequenceView } from '../../../api/types';
import { json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { EnrolDialog } from './EnrolDialog';
import { PersonEnrolments } from './PersonEnrolments';
import { SequencePage } from './SequencePage';
import { SequencesPage } from './SequencesPage';

const WS = 'ws-1';
const actor = { kind: 'member' as const, id: 'm-1' };

const sequence = (over: Partial<SequenceView> = {}): SequenceView => ({
    id: 'sq-1',
    name: 'Q4 agency outreach',
    status: 'draft',
    pipelineId: null,
    stopOnPipelineExit: true,
    timeZone: 'Asia/Karachi',
    window: { startMinute: 540, endMinute: 1020, days: 31 },
    steps: [
        {
            id: 'st-1',
            position: 0,
            kind: 'email',
            templateId: 'tp-1',
            replyInThread: false,
            waitDays: null,
            businessDays: false,
            taskTitle: null,
        },
    ],
    counts: { enrolled: 12, active: 5, held: 1, finished: 4, stopped: 2 },
    createdBy: actor,
    createdAt: '2026-10-11T10:00:00Z',
    updatedAt: '2026-10-11T10:00:00Z',
    ...over,
});

const enrolment = (over: Partial<SequenceEnrolmentView> = {}): SequenceEnrolmentView => ({
    id: 'en-1',
    sequenceId: 'sq-1',
    personId: 'p-1',
    dealId: null,
    status: 'active',
    stepIndex: 0,
    nextRunAt: '2026-10-13T04:00:00Z',
    waitingOutboundId: null,
    heldReason: null,
    stopReason: null,
    stopDetail: null,
    enrolledBy: actor,
    enrolledByMemberId: 'm-1',
    countryUnknownAtEnrol: false,
    enrolledAt: '2026-10-11T10:00:00Z',
    finishedAt: null,
    stoppedAt: null,
    ...over,
});

const templatesList: FakeRoute = (r) =>
    r.method === 'GET' && r.url.includes('/templates?')
        ? json({
              items: [
                  {
                      id: 'tp-1',
                      name: 'Agency intro v3',
                      kind: 'outreach',
                      subject: 'Intro',
                      updatedAt: '2026-10-10T00:00:00Z',
                  },
                  {
                      id: 'tp-2',
                      name: 'Agency follow-up',
                      kind: 'outreach',
                      subject: 'Re',
                      updatedAt: '2026-10-10T00:00:00Z',
                  },
              ],
              nextCursor: null,
          })
        : undefined;
const one =
    (s: SequenceView): FakeRoute =>
    (r) =>
        r.method === 'GET' && r.url.endsWith(`/sequences/${s.id}`) ? json(s) : undefined;
const noEnrolments: FakeRoute = (r) => (r.method === 'GET' && r.url.endsWith('/enrolments') ? json([]) : undefined);

describe('FR-CRMS-5 sequences UI (P3-UI-1)', { timeout: 30_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists sequences with their status and counts, and creates one into its builder', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/sequences') ? json([sequence()]) : undefined),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/sequences')
                    ? json(sequence({ id: 'sq-2', name: 'New one', steps: [] }), 201)
                    : undefined,
        ]);
        renderAt(
            [
                route('/w/:workspaceId/sequences', <SequencesPage />),
                route('/w/:workspaceId/sequences/:sequenceId', <p>builder for sq-2</p>),
            ],
            `/w/${WS}/sequences`,
            ['sequence:write', 'sequence:enrol'],
        );
        const row = (await screen.findByRole('link', { name: 'Q4 agency outreach' })).closest('tr') as HTMLElement;
        expect(within(row).getByText('Draft')).toBeInTheDocument();
        expect(within(row).getByText('12')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'New sequence' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.type(within(dialog).getByLabelText(/^Name/), 'New one');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
        expect(await screen.findByText('builder for sq-2')).toBeInTheDocument();
        expect(seen.find((r) => r.method === 'POST')?.body).toMatchObject({ name: 'New one' });
    });

    it('builds steps — an email from an outreach template and a wait — and saves them in order', async () => {
        const seen = stubApi([
            one(sequence()),
            templatesList,
            noEnrolments,
            (r) => (r.method === 'PUT' && r.url.endsWith('/steps') ? json(sequence()) : undefined),
        ]);
        renderAt([route('/w/:workspaceId/sequences/:sequenceId', <SequencePage />)], `/w/${WS}/sequences/sq-1`, [
            'sequence:write',
            'sequence:enrol',
        ]);
        expect(await screen.findByText('Agency intro v3')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Add wait' }));
        await userEvent.click(screen.getByRole('button', { name: 'Add email' }));
        const steps = screen.getByRole('list', { name: 'Steps' });
        const items = within(steps).getAllByRole('listitem');
        expect(items).toHaveLength(3);
        await userEvent.click(within(items[2]!).getByRole('combobox', { name: 'Template for step 3' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Agency follow-up' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save steps' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
            steps: [
                { id: 'st-1', kind: 'email', templateId: 'tp-1', replyInThread: false },
                { kind: 'wait', waitDays: 3, businessDays: true },
                { kind: 'email', templateId: 'tp-2', replyInThread: false },
            ],
        });
    });

    it('#136 adds a task step with a title, which saves as a task', async () => {
        const seen = stubApi([
            one(sequence()),
            templatesList,
            noEnrolments,
            (r) => (r.method === 'PUT' && r.url.endsWith('/steps') ? json(sequence()) : undefined),
        ]);
        renderAt([route('/w/:workspaceId/sequences/:sequenceId', <SequencePage />)], `/w/${WS}/sequences/sq-1`, [
            'sequence:write',
            'sequence:enrol',
        ]);
        await userEvent.click(await screen.findByRole('button', { name: 'Add task' }));
        // An untitled task cannot be saved.
        expect(screen.getByRole('button', { name: 'Save steps' })).toBeDisabled();
        await userEvent.type(screen.getByRole('textbox', { name: 'Task title, step 2' }), 'Call if no reply');
        await userEvent.click(screen.getByRole('button', { name: 'Save steps' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
            steps: [
                { id: 'st-1', kind: 'email', templateId: 'tp-1', replyInThread: false },
                { kind: 'task', taskTitle: 'Call if no reply' },
            ],
        });
    });

    it('shows the mandatory stop conditions as always on, and the builder read-only without sequence:write', async () => {
        stubApi([one(sequence({ status: 'active' })), templatesList, noEnrolments]);
        renderAt([route('/w/:workspaceId/sequences/:sequenceId', <SequencePage />)], `/w/${WS}/sequences/sq-1`, [
            'sequence:enrol',
        ]);
        expect(await screen.findByText('Agency intro v3')).toBeInTheDocument();
        for (const name of ['Reply received', 'Hard bounce', 'Unsubscribe', 'Spam complaint', 'Suppression hit']) {
            const box = screen.getByRole('checkbox', { name });
            expect(box).toBeChecked();
            expect(box).toBeDisabled();
        }
        expect(screen.queryByRole('button', { name: 'Save steps' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Enrol people' })).toBeInTheDocument();
    });

    it('previews enrolment with the server reasons, then enrols the people it can', async () => {
        const preview: EnrolmentBatchView = {
            enrolled: ['p-1'],
            skipped: ['p-3'],
            refused: [{ personId: 'p-2', code: 'region.blocked', message: 'Region blocked: EU (policy)' }],
            warnings: [],
        };
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/sequences') ? json([sequence({ status: 'active' })]) : undefined,
            (r) => (r.method === 'POST' && r.url.endsWith('/enrolments/preview') ? json(preview) : undefined),
            (r) => (r.method === 'POST' && r.url.endsWith('/enrolments') ? json(preview) : undefined),
        ]);
        const done = vi.fn();
        renderAt(
            [
                route(
                    '/w/:workspaceId/people',
                    <EnrolDialog
                        workspaceId={WS}
                        people={[
                            { id: 'p-1', name: 'Ana Ruiz', email: 'ana@ruiz.example' },
                            { id: 'p-2', name: 'Lena Vogt', email: 'lena@kraft.example' },
                            { id: 'p-3', name: 'Tom Hale', email: 'tom@hale.example' },
                        ]}
                        onOpenChange={() => {}}
                        onDone={done}
                    />,
                ),
            ],
            `/w/${WS}/people`,
            ['sequence:enrol'],
        );
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(within(dialog).getByRole('combobox', { name: 'Sequence' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Q4 agency outreach' }));
        expect(await within(dialog).findByText('Region blocked: EU (policy)')).toBeInTheDocument();
        expect(within(dialog).getByText('Lena Vogt')).toBeInTheDocument();
        expect(within(dialog).getByText(/1 already in this sequence/)).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Enrol 1 person' }));
        await waitFor(() => expect(done).toHaveBeenCalled());
        expect(seen.find((r) => r.method === 'POST' && r.url.endsWith('/enrolments'))?.body).toEqual({
            personIds: ['p-1', 'p-2', 'p-3'],
        });
    });

    it("lists a person's enrolments and stops one; a stopped one can be re-enrolled", async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/sequences') ? json([sequence({ status: 'active' })]) : undefined,
            (r) =>
                r.method === 'GET' && r.url.endsWith('/people/p-1/enrolments')
                    ? json([
                          enrolment(),
                          enrolment({
                              id: 'en-2',
                              status: 'stopped',
                              stopReason: 'reply',
                              stoppedAt: '2026-10-11T12:00:00Z',
                          }),
                      ])
                    : undefined,
            (r) =>
                r.method === 'POST' && r.url.endsWith('/stop') ? json(enrolment({ status: 'stopped' })) : undefined,
            (r) => (r.method === 'POST' && r.url.endsWith('/reenrol') ? json(enrolment({ id: 'en-3' })) : undefined),
        ]);
        renderAt(
            [route('/w/:workspaceId/people/:personId', <PersonEnrolments workspaceId={WS} personId="p-1" />)],
            `/w/${WS}/people/p-1`,
            ['sequence:enrol', 'record:read'],
        );
        expect(await screen.findByText('Stopped: reply received')).toBeInTheDocument();
        await userEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!);
        const confirm = await screen.findByRole('dialog');
        await userEvent.click(within(confirm).getByRole('button', { name: 'Stop enrolment' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/enrolments/en-1/stop'))).toBe(true));
        await userEvent.click(screen.getByRole('button', { name: 'Re-enrol' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/enrolments/en-2/reenrol'))).toBe(true));
    });
});
