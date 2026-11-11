import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodayDealView, TodayPersonView, TodayView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { TodayPage } from './TodayPage';

const WS = 'ws-1';

const person = (id: string, name: string): TodayPersonView => ({
    id,
    name,
    email: `${id}@example.com`,
    phones: { primary: { number: '5125550198', countryCode: 'US' }, additional: [] },
    source: 'manual',
    company: { id: 'c-1', name: 'Acme' },
});
const deal = (id: string, name: string): TodayDealView => ({
    id,
    name,
    amount: { amountMinor: 120_000, currency: 'USD' },
    currency: 'USD',
    pipelineId: 'pl-1',
    stage: { id: 's-1', name: 'Contacted' },
    dueAt: '2026-11-01T09:00:00Z',
    nextFollowUpDate: null,
    cadenceOverdue: true,
    lastActivityAt: '2026-10-01T09:00:00Z',
    company: { id: 'c-1', name: 'Acme' },
    contact: person('p-2', 'Dana Reyes'),
});
const empty = { count: 0, countIsExact: true, nextCursor: null, items: [] };

const DAY: TodayView = {
    member: { memberId: 'm-1', name: 'Kate Morgan', leftAt: null },
    date: '2026-11-11',
    windows: { replyDays: 30, newLeadDays: 14, stalledDays: 21 },
    replies: {
        count: 1,
        countIsExact: true,
        nextCursor: null,
        items: [
            {
                messageId: 'msg-1',
                threadId: 'th-1',
                subject: 'Re: pricing',
                snippet: 'Can you send three instead of five?',
                receivedAt: '2026-11-10T09:00:00Z',
                person: person('p-1', 'Pat Prospect'),
            },
        ],
    },
    followUps: { count: 12_000, countIsExact: false, nextCursor: 'next-follow-ups', items: [deal('d-1', 'Q4 bundle')] },
    newLeads: empty,
    tasks: {
        count: 1,
        countIsExact: true,
        nextCursor: null,
        items: [{ id: 't-1', title: 'Send the deck', status: 'todo', dueAt: '2026-11-09T09:00:00Z', targets: [] }],
    },
    stalled: empty,
};

const today = (capabilities: Capability[]) =>
    renderAt([route('/w/:workspaceId/today', <TodayPage />)], `/w/${WS}/today`, capabilities);
const isToday = (url: string) => /\/w\/ws-1\/today(\?|$)/.test(url);

describe('#360 Today', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows each section with its count — a capped backlog says so — and its rows', async () => {
        const seen = stubApi([(r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined)]);
        today(['record:read', 'record:write', 'task:write']);
        const replies = await screen.findByRole('region', { name: 'Replies waiting' });
        expect(await within(replies).findByRole('link', { name: 'Re: pricing' })).toHaveAttribute(
            'href',
            `/w/${WS}/today?thread=th-1`,
        );
        expect(within(replies).getByRole('link', { name: 'Pat Prospect' })).toHaveAttribute(
            'href',
            `/w/${WS}/today?open=person%3Ap-1`,
        );
        const followUps = screen.getByRole('region', { name: 'Follow-ups due' });
        expect(within(followUps).getByText('12,000+')).toBeInTheDocument();
        expect(within(followUps).getByRole('button', { name: 'Show more' })).toBeInTheDocument();
        expect(
            within(screen.getByRole('region', { name: 'New leads' })).getByText(
                'No new lead is waiting for a first touch.',
            ),
        ).toBeInTheDocument();
        // The reader's own day, in the reader's time zone; no member named.
        const asked = new URL(seen.find((r) => isToday(r.url))!.url, 'http://x');
        expect(asked.searchParams.get('memberId')).toBeNull();
        expect(asked.searchParams.get('timeZone')).toBeTruthy();
    });

    it('pages a section on "Show more" from the overview’s cursor', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined),
            (r) =>
                r.method === 'GET' && r.url.includes('/today/follow-ups')
                    ? json({
                          count: 12_000,
                          countIsExact: false,
                          nextCursor: null,
                          items: [deal('d-2', 'Launch wire')],
                      })
                    : undefined,
        ]);
        today(['record:read', 'record:write']);
        const followUps = await screen.findByRole('region', { name: 'Follow-ups due' });
        await userEvent.click(await within(followUps).findByRole('button', { name: 'Show more' }));
        expect(await within(followUps).findByText('Launch wire')).toBeInTheDocument();
        const page = new URL(seen.find((r) => r.url.includes('/today/follow-ups'))!.url, 'http://x');
        expect(page.searchParams.get('cursor')).toBe('next-follow-ups');
        expect(within(followUps).queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('completes a task in place, and it leaves the list', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined),
            (r) => (r.method === 'PATCH' && r.url.endsWith('/tasks/t-1') ? json({ id: 't-1' }) : undefined),
        ]);
        today(['record:read', 'task:write']);
        await userEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Send the deck”' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({ status: 'done' }));
        await waitFor(() => expect(screen.queryByText('Send the deck')).toBeNull());
    });

    it('plans a deal’s next follow-up through the deal itself', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined),
            (r) => (r.method === 'PATCH' && r.url.endsWith('/opportunities/d-1') ? json({ id: 'd-1' }) : undefined),
        ]);
        today(['record:read', 'record:write']);
        await userEvent.click(await screen.findByRole('button', { name: 'Set next follow-up for Q4 bundle' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({
                nextFollowUpDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            }),
        );
    });

    it('offers no writes to a reader without them, and no member picker to a non-admin', async () => {
        stubApi([(r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined)]);
        today(['record:read']);
        expect(await screen.findByRole('button', { name: 'Email Pat Prospect' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Set next follow-up/ })).toBeNull();
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Whose day' })).toBeNull();
    });

    it('lets an admin read another member’s day', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && isToday(r.url) ? json(DAY) : undefined),
            (r) =>
                r.method === 'GET' && r.url.endsWith('/members/summary')
                    ? json([
                          { memberId: 'm-1', name: 'Kate Morgan', leftAt: null },
                          { memberId: 'm-2', name: 'Ava Lee', leftAt: null },
                      ])
                    : undefined,
        ]);
        today(['record:read', 'workspace:admin']);
        await userEvent.click(await screen.findByRole('combobox', { name: 'Whose day' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Ava Lee' }));
        await waitFor(() =>
            expect(
                seen.some((r) => isToday(r.url) && new URL(r.url, 'http://x').searchParams.get('memberId') === 'm-2'),
            ).toBe(true),
        );
    });
});
