import type { Capability } from '@bylinecrm/shared';
import { TooltipProvider, toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import type { MembershipSummary } from '../api/types';
import { CapabilitiesProvider } from '../auth/capabilities';
import { SEARCH_DEBOUNCE_MS } from '../lib/useDebounced';
import { RecordPicker } from './RecordPicker';
import { useCompanyCreator } from './useCompanyCreator';

const WS = '11111111-2222-4333-8444-555555555555';

function json(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('RecordPicker', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('searches once typing pauses, lists the matches and saves the one chosen', async () => {
        const user = userEvent.setup();
        const fetchMock = vi.fn(async (_input: string) =>
            json({
                person: [],
                company: [{ object: 'company', id: 'c1', title: 'Acme Corp', subtitle: 'acme.com' }],
                opportunity: [],
            }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const onChange = vi.fn();
        render(
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <RecordPicker
                        workspaceId={WS}
                        object="company"
                        label="Company"
                        value={null}
                        clearLabel="No company"
                        onChange={onChange}
                    />
                </QueryClientProvider>
            </TooltipProvider>,
        );

        await user.click(screen.getByRole('button', { name: 'Company: No company' }));
        await user.type(await screen.findByRole('combobox', { name: 'Search company' }), 'acm');
        // Three keystrokes, one request: nothing is asked while typing continues.
        expect(fetchMock).not.toHaveBeenCalled();

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: SEARCH_DEBOUNCE_MS * 8 });
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/w/${WS}/search?q=acm&limit=10&objects=company`);

        await user.click(await screen.findByRole('option', { name: /Acme Corp/ }));
        expect(onChange).toHaveBeenCalledWith('c1');
    });
});

const member = (capabilities: Capability[]): MembershipSummary => ({
    memberId: 'm',
    workspaceId: WS,
    apiKeyId: null,
    userId: 'u',
    roleId: 'r',
    roleName: 'member',
    recordScope: 'all',
    capabilities,
});

/** A person's company field as the record pages wire it: the picker plus the "New company" create. */
function CompanyField({ address, onChange }: { address: string | null; onChange: (id: string | null) => unknown }) {
    const createCompany = useCompanyCreator(WS, address);
    return (
        <RecordPicker
            workspaceId={WS}
            object="company"
            label="Company"
            value={null}
            clearLabel="No company"
            onChange={async (id) => {
                await onChange(id);
            }}
            onCreate={createCompany}
        />
    );
}

interface Call {
    url: string;
    method: string;
    body: unknown;
}

/** Search answers `hits`; `POST …/companies` answers `created` (a status and a body). */
function stubApi(hits: { id: string; title: string }[], created: { status: number; body: unknown }) {
    const calls: Call[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes('/search?')) {
                return json({ person: [], opportunity: [], company: hits.map((h) => ({ object: 'company', ...h })) });
            }
            return new Response(JSON.stringify(created.body), {
                status: created.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }),
    );
    return calls;
}

function renderField({ address, capabilities }: { address: string | null; capabilities?: Capability[] }) {
    const onChange = vi.fn();
    render(
        <TooltipProvider>
            <QueryClientProvider client={createQueryClient()}>
                <CapabilitiesProvider membership={member(capabilities ?? ['record:read', 'record:write'])}>
                    <CompanyField address={address} onChange={onChange} />
                    <Toaster />
                </CapabilitiesProvider>
            </QueryClientProvider>
        </TooltipProvider>,
    );
    return onChange;
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.click(screen.getByRole('button', { name: 'Company: No company' }));
    await user.type(await screen.findByRole('combobox', { name: 'Search company' }), text);
}

const WAIT = { timeout: SEARCH_DEBOUNCE_MS * 8 };
const CREATE = 'Create company "Globex"';

describe('RecordPicker: creating the company typed', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('offers to create what was typed after the matches, and not once a match has that name', async () => {
        const user = userEvent.setup();
        stubApi([{ id: 'c1', title: 'Globex Holdings' }], { status: 201, body: {} });
        renderField({ address: null });

        await search(user, 'Globex');
        await screen.findByRole('option', { name: CREATE }, WAIT);
        expect(screen.getAllByRole('option').at(-1)).toHaveAccessibleName(CREATE);

        await user.type(screen.getByRole('combobox', { name: 'Search company' }), ' HOLDINGS');
        await waitFor(
            () => expect(screen.queryByRole('option', { name: /^Create company/ })).not.toBeInTheDocument(),
            WAIT,
        );
        expect(screen.getByRole('option', { name: /Globex Holdings/ })).toBeInTheDocument();
    });

    it('offers nothing to create to a member who may not create companies', async () => {
        const user = userEvent.setup();
        stubApi([], { status: 201, body: {} });
        renderField({ address: null, capabilities: ['record:read'] });

        await search(user, 'Globex');
        expect(await screen.findByText('No matches.', {}, WAIT)).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /^Create company/ })).not.toBeInTheDocument();
    });

    it('creates it from the keyboard with the person’s company domain, links it, closes and says so', async () => {
        const user = userEvent.setup();
        const calls = stubApi([], { status: 201, body: { id: 'c9', name: 'Globex', domain: 'globex.example' } });
        const onChange = renderField({ address: 'hank@Globex.example' });

        await search(user, 'Globex');
        // The only option, so the active one: Enter chooses it.
        await screen.findByRole('option', { name: CREATE }, WAIT);
        await user.keyboard('{Enter}');

        await waitFor(() => expect(onChange).toHaveBeenCalledWith('c9'));
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.url).toBe(`/api/w/${WS}/companies`);
        expect(post?.body).toEqual({ name: 'Globex', domain: 'globex.example' });
        expect(await screen.findByText('Created company “Globex”.')).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'Search company' })).not.toBeInTheDocument();
    });

    it('leaves the domain out for a free-mail address', async () => {
        const user = userEvent.setup();
        const calls = stubApi([], { status: 201, body: { id: 'c9', name: 'Globex', domain: null } });
        const onChange = renderField({ address: 'hank@gmail.com' });

        await search(user, 'Globex');
        await user.click(await screen.findByRole('option', { name: CREATE }, WAIT));

        await waitFor(() => expect(onChange).toHaveBeenCalledWith('c9'));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Globex' });
    });

    it('keeps the picker open and says why when the create is refused', async () => {
        const user = userEvent.setup();
        stubApi([], {
            status: 403,
            body: { code: 'forbidden', message: 'You may not create companies.', requestId: 'req-1' },
        });
        const onChange = renderField({ address: null });

        await search(user, 'Globex');
        await user.click(await screen.findByRole('option', { name: CREATE }, WAIT));

        expect(await screen.findByText('Could not create company “Globex”.')).toBeInTheDocument();
        expect(screen.getByText('You may not create companies.')).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Search company' })).toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('offers the company that already has the domain rather than making a second', async () => {
        const user = userEvent.setup();
        stubApi([], {
            status: 409,
            body: {
                code: 'conflict.company_owned',
                message: 'That domain is another company’s.',
                requestId: 'req-2',
                details: { companyId: 'c1', companyName: 'Globex Corp', ownerMemberId: 'm2', ownerName: 'Ana' },
            },
        });
        const onChange = renderField({ address: 'hank@globex.example' });

        await search(user, 'Globex');
        await user.click(await screen.findByRole('option', { name: CREATE }, WAIT));

        expect(await screen.findByText('Globex Corp already has that domain.')).toBeInTheDocument();
        await user.click(screen.getByRole('option', { name: 'Globex Corp' }));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith('c1'));
    });
});
