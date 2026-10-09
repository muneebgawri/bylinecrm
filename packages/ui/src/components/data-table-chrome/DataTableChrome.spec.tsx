import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DropdownMenuItem } from '../dropdown-menu/DropdownMenu';
import { DataTableChrome, pageWindow, phoneRoles, type TableColumn, type TableData } from './DataTableChrome';

describe('pageWindow', () => {
    it('keeps the current page in a three-wide window clamped to the range', () => {
        expect(pageWindow(1, 97)).toEqual([1, 2, 3]);
        expect(pageWindow(50, 97)).toEqual([49, 50, 51]);
        expect(pageWindow(97, 97)).toEqual([95, 96, 97]);
        expect(pageWindow(1, 2)).toEqual([1, 2]);
        expect(pageWindow(1, 1)).toEqual([1]);
    });
});

describe('DataTableChrome', () => {
    it('reports tab, search and page changes, and disables the edges', async () => {
        const user = userEvent.setup();
        const onTabChange = vi.fn();
        const onChange = vi.fn();
        const onPageChange = vi.fn();
        render(
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'All' },
                    { id: 'mine', label: 'My leads', count: 1204 },
                ]}
                activeTab="all"
                onTabChange={onTabChange}
                search={{ value: '', onChange, placeholder: 'Search people…' }}
                pagination={{ page: 1, pageCount: 3, onPageChange, pageSize: 50 }}
            >
                <table>
                    <tbody>
                        <tr>
                            <td>row</td>
                        </tr>
                    </tbody>
                </table>
            </DataTableChrome>,
        );
        expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
        await user.click(screen.getByRole('tab', { name: /My leads/ }));
        expect(onTabChange).toHaveBeenCalledWith('mine');

        await user.type(screen.getByRole('searchbox', { name: 'Search people…' }), 'd');
        expect(onChange).toHaveBeenCalledWith('d');

        expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Next' }));
        expect(onPageChange).toHaveBeenCalledWith(2);
        await user.click(screen.getByRole('button', { name: 'Page 3' }));
        expect(onPageChange).toHaveBeenCalledWith(3);
        expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
});

interface Member {
    id: string;
    name: string;
    role: string;
    joined: string;
    status: string;
}

const MEMBERS: Member[] = [
    { id: 'm1', name: 'Dana Reyes', role: 'admin', joined: 'Oct 1', status: 'Active' },
    { id: 'm2', name: 'Sam Okafor', role: 'member', joined: 'Oct 3', status: 'Invited' },
];

const COLUMNS: TableColumn<Member>[] = [
    { id: 'name', header: 'Member', cell: (m) => m.name },
    { id: 'role', header: 'Role', cell: (m) => m.role },
    { id: 'joined', header: 'Joined', cell: (m) => m.joined },
    { id: 'status', header: 'Status', cell: (m) => m.status },
];

function members(layout: 'table' | 'cards', extra: Partial<TableData<Member>> = {}) {
    return (
        <DataTableChrome<string, Member>
            data={{
                label: 'Members',
                rows: MEMBERS,
                getRowId: (m) => m.id,
                columns: COLUMNS,
                layout,
                rowActions: {
                    label: (m) => m.name,
                    items: (m) => (m.id === 'm2' ? null : <DropdownMenuItem>Remove</DropdownMenuItem>),
                },
                ...extra,
            }}
        />
    );
}

describe('phoneRoles', () => {
    it('defaults to one primary, two secondary, the rest hidden, and keeps a declared role', () => {
        expect(phoneRoles(COLUMNS)).toEqual(['primary', 'secondary', 'secondary', 'hidden']);
        expect(phoneRoles([...COLUMNS.slice(0, 3), { ...COLUMNS[3]!, phone: 'meta' as const }])).toEqual([
            'primary',
            'secondary',
            'secondary',
            'meta',
        ]);
    });
});

describe('DataTableChrome rows (data)', () => {
    it('draws a table with a header per column and one actions menu per row that has actions', () => {
        render(members('table'));
        expect(screen.getByRole('table')).toBeInTheDocument();
        expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
            'Member',
            'Role',
            'Joined',
            'Status',
            'Actions',
        ]);
        expect(screen.getByRole('button', { name: 'Actions for Dana Reyes' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Actions for Sam Okafor' })).not.toBeInTheDocument();
    });

    it('draws cards from the same columns on a phone: no table, hidden columns left off', () => {
        render(members('cards'));
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        const list = screen.getByRole('list', { name: 'Members' });
        expect(list.querySelectorAll('li')).toHaveLength(2);
        expect(list).toHaveTextContent('Dana Reyes');
        expect(list).toHaveTextContent('admin');
        expect(list).toHaveTextContent('Oct 1');
        expect(list).not.toHaveTextContent('Active');
        expect(screen.getByRole('button', { name: 'Actions for Dana Reyes' })).toBeInTheDocument();
    });

    it('chooses cards below the phone breakpoint by itself', () => {
        const original = window.matchMedia;
        window.matchMedia = ((query: string) => ({
            ...original(query),
            matches: query.includes('max-width'),
        })) as typeof window.matchMedia;
        try {
            render(
                <DataTableChrome<string, Member>
                    data={{ label: 'Members', rows: MEMBERS, getRowId: (m) => m.id, columns: COLUMNS }}
                />,
            );
            expect(screen.queryByRole('table')).not.toBeInTheDocument();
            expect(screen.getByRole('list', { name: 'Members' })).toBeInTheDocument();
        } finally {
            window.matchMedia = original;
        }
    });

    it('shows the loading state, then the empty state when there are no rows', () => {
        const { rerender } = render(members('table', { loading: true }));
        expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
        rerender(members('table', { rows: [], empty: <p>No members yet</p> }));
        expect(screen.getByText('No members yet')).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
});
