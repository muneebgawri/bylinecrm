import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoleView } from '../../../api/types';
import { Roles } from './Roles';
import { json, renderAt, route, stubApi } from './settingsTestKit';

const WS = 'ws-1';
const roles: RoleView[] = [
    { id: 'r-admin', name: 'admin', isSystem: true, recordScope: 'all', capabilities: [] },
    {
        id: 'r-am',
        name: 'Account manager',
        isSystem: false,
        recordScope: 'own',
        capabilities: ['record:read', 'deal:read'],
    },
];

function api() {
    return stubApi([
        (r) => (r.method === 'POST' && r.url.endsWith('/roles') ? json({ ...roles[1], id: 'r-new' }, 201) : undefined),
        (r) => (r.method === 'PATCH' ? json(roles[1]) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith('/roles') ? json(roles) : undefined),
    ]);
}

const page = () =>
    renderAt([route('/w/:workspaceId/settings/roles', <Roles />)], `/w/${WS}/settings/roles`, ['workspace:admin']);

describe('FR-CRMS-UI-6: roles set what members may do and which records they see', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('creates a role limited to the records its members own', async () => {
        const seen = api();
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'New role' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Account manager');
        await userEvent.click(within(dialog).getByRole('radio', { name: /Only records they own/ }));
        await userEvent.click(within(dialog).getByRole('checkbox', { name: 'See people and companies' }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create role' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST')).toBe(true));
        expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
            name: 'Account manager',
            capabilities: ['record:read'],
            recordScope: 'own',
        });
    });

    it('opens an existing role on its saved scope, and saves a change to it', async () => {
        const seen = api();
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Account manager' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('radio', { name: /Only records they own/ })).toBeChecked();
        await userEvent.click(within(dialog).getByRole('radio', { name: /All records/ }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PATCH')).toBe(true));
        expect(seen.find((r) => r.method === 'PATCH')?.body).toMatchObject({ recordScope: 'all' });
    });

    it('names capabilities in words, grouped by area; the catalogue string is not on the page', async () => {
        api();
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'New role' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('group', { name: 'Deals' })).toBeInTheDocument();
        expect(within(dialog).getByRole('checkbox', { name: 'Move deals between stages' })).toBeInTheDocument();
        expect(within(dialog).queryByText('deal:move')).not.toBeInTheDocument();
    });

    it('shows the scope in the table so an admin sees who is limited', async () => {
        api();
        page();
        expect(await screen.findByText('Only their own records')).toBeInTheDocument();
    });
});
