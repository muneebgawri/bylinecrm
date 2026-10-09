import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomFieldView } from '../../../api/types';
import { CustomFields } from './CustomFields';
import { json, renderAt, route, stubApi, type FakeRequest } from './settingsTestKit';

const WS = 'ws-1';
const field = (over: Partial<CustomFieldView>): CustomFieldView => ({
    id: 'f-1',
    object: 'person',
    key: 'beat',
    label: 'Beat',
    type: 'select',
    options: ['Fintech', 'Health'],
    required: false,
    position: 1,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
});

function api(extra: ((r: FakeRequest) => Response | undefined)[] = []) {
    return stubApi([
        ...extra,
        (r) =>
            r.method === 'GET' && r.url.includes('/custom-fields?') && r.url.includes('archived=true')
                ? json(
                      r.url.includes('object=person')
                          ? [
                                field({
                                    id: 'f-old',
                                    key: 'region',
                                    label: 'Region',
                                    type: 'text',
                                    options: [],
                                    archivedAt: '2026-10-05T00:00:00Z',
                                }),
                            ]
                          : [],
                  )
                : undefined,
        (r) =>
            r.method === 'GET' && r.url.includes('/custom-fields?')
                ? json(r.url.includes('object=person') ? [field({})] : [])
                : undefined,
    ]);
}

const page = () =>
    renderAt([route('/w/:workspaceId/settings/custom-fields', <CustomFields />)], `/w/${WS}/settings/custom-fields`, [
        'record:read',
        'workspace:admin',
    ]);

describe('Custom fields settings (doc 48 §5; FR-CRMS-UI-6)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists a person field with its type, and the archived ones apart and read-only', async () => {
        api();
        page();
        expect(await screen.findByText('Beat')).toBeInTheDocument();
        expect(screen.getByText('Select · 2 options')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: /Archived fields/ }));
        const archived = await screen.findByRole('list', { name: 'Archived fields' });
        expect(within(archived).getByText('Region')).toBeInTheDocument();
        expect(within(archived).queryByRole('button')).not.toBeInTheDocument();
    });

    it('creates a select field: the key follows the label, the options in order, the exact body', async () => {
        const seen = api([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/custom-fields') ? json(field({ id: 'f-2' }), 201) : undefined,
        ]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'New field' }));
        const dialog = await screen.findByRole('dialog');
        // Text arrives by paste: per-key typing of ~30 characters outlasts the timeout on a loaded machine.
        await userEvent.click(within(dialog).getByLabelText(/^Label/));
        await userEvent.paste('Last outlet');
        expect(within(dialog).getByLabelText(/^Key/)).toHaveValue('last_outlet');
        await userEvent.click(within(dialog).getByRole('combobox', { name: 'Type' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Select' }));
        const newOption = within(dialog).getByLabelText('New option');
        await userEvent.click(newOption);
        await userEvent.paste('TechWire');
        await userEvent.keyboard('{Enter}');
        await userEvent.paste('Axios');
        await userEvent.keyboard('{Enter}');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Move Axios up' }));
        await userEvent.click(within(dialog).getByRole('switch', { name: 'Required' }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST')).toBe(true));
        expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
            object: 'person',
            key: 'last_outlet',
            label: 'Last outlet',
            type: 'select',
            options: ['Axios', 'TechWire'],
            required: true,
        });
    });

    it('archives a field from its menu — never deletes', async () => {
        const seen = api([(r) => (r.method === 'DELETE' ? json(null, 204) : undefined)]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Beat' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Archive field' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'DELETE')).toBe(true));
        expect(seen.find((r) => r.method === 'DELETE')?.url).toMatch(/\/custom-fields\/f-1$/);
    });

    it('edits a field without offering to change its key or type', async () => {
        const seen = api([(r) => (r.method === 'PATCH' ? json(field({ label: 'Beat area' })) : undefined)]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for Beat' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByLabelText(/^Key/)).not.toBeInTheDocument();
        expect(within(dialog).queryByRole('combobox', { name: 'Type' })).not.toBeInTheDocument();
        const label = within(dialog).getByLabelText(/^Label/);
        await userEvent.clear(label);
        await userEvent.type(label, 'Beat area');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save field' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PATCH')).toBe(true));
        expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({
            label: 'Beat area',
            options: ['Fintech', 'Health'],
            required: false,
        });
    });
});
