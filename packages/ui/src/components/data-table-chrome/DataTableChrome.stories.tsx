import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pencil, Send, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { inMode } from '../../../.storybook/modes';
import { Avatar } from '../avatar/Avatar';
import { Badge } from '../badge/Badge';
import { BulkBar, BulkBarAction } from '../bulk-bar/BulkBar';
import { Checkbox } from '../checkbox/Checkbox';
import { ScoreBar } from '../score-bar/ScoreBar';
import { DropdownMenuItem } from '../dropdown-menu/DropdownMenu';
import { DataTableChrome, tableClasses, type TableColumn } from './DataTableChrome';

const meta = { title: 'Shell/DataTableChrome', component: DataTableChrome } satisfies Meta<typeof DataTableChrome>;
export default meta;
// Galleries render their own content; the story takes no args of its own.
type Story = StoryObj;

const ROWS = [
    {
        name: 'Dana Reyes',
        title: 'Head of Comms',
        company: 'Acme Corp',
        email: 'dana@acme.example',
        status: 'success',
        stage: 'Replied',
        stageTone: 'accent',
        score: 8,
        last: '4h ago',
        selected: true,
    },
    {
        name: 'Sam Okafor',
        title: 'VP Marketing',
        company: 'Initech',
        email: 'sam@initech.example',
        status: 'success',
        stage: 'Meeting',
        stageTone: 'info',
        score: 9,
        last: '1d ago',
        selected: true,
    },
    {
        name: 'Priya Nair',
        title: 'Founder',
        company: 'Nair & Co',
        email: 'p@nair.co',
        status: 'warning',
        stage: 'Contacted',
        stageTone: 'neutral',
        score: 4,
        last: '9d ago',
        selected: false,
    },
    {
        name: 'Lena Vogt',
        title: 'PR Lead',
        company: 'Kraft Media',
        email: 'lena@kraft.de',
        status: 'success',
        stage: 'New',
        stageTone: 'neutral',
        score: 6,
        last: 'EU · blocked by policy',
        selected: false,
    },
] as const;

function Example() {
    const [tab, setTab] = useState('all');
    const [q, setQ] = useState('');
    const [page, setPage] = useState(1);
    const [size, setSize] = useState(50);
    const selected = ROWS.filter((r) => r.selected).length;
    return (
        <div>
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'All' },
                    { id: 'mine', label: 'My leads', count: 1204 },
                    { id: 'replied', label: 'Replied', count: 9 },
                    { id: 'unverified', label: 'Unverified', count: 618 },
                ]}
                activeTab={tab}
                onTabChange={setTab}
                search={{ value: q, onChange: setQ, placeholder: 'Search people…' }}
                toolbar={{ onFilter: () => undefined, onSort: () => undefined, onColumns: () => undefined }}
                pagination={{
                    page,
                    pageCount: 97,
                    onPageChange: setPage,
                    pageSize: size,
                    onPageSizeChange: setSize,
                    selectionLabel: `${selected} of 50 rows selected`,
                }}
            >
                <table className={tableClasses.table}>
                    <thead>
                        <tr>
                            <th className={tableClasses.th}>
                                <Checkbox aria-label="Select all" />
                            </th>
                            <th className={tableClasses.th}>Person</th>
                            <th className={tableClasses.th}>Company</th>
                            <th className={tableClasses.th}>Email</th>
                            <th className={tableClasses.th}>Status</th>
                            <th className={tableClasses.th}>Stage</th>
                            <th className={tableClasses.th}>Score</th>
                            <th className={tableClasses.th}>Last activity</th>
                        </tr>
                    </thead>
                    <tbody>
                        {ROWS.map((row) => (
                            <tr key={row.email} className={tableClasses.tr} data-selected={row.selected}>
                                <td className={tableClasses.td}>
                                    <Checkbox aria-label={`Select ${row.name}`} checked={row.selected} />
                                </td>
                                <td className={tableClasses.td}>
                                    <div className="flex items-center gap-2.5">
                                        <Avatar name={row.name} />
                                        <div className="leading-tight">
                                            <b className="block font-medium">{row.name}</b>
                                            <span className="text-xs text-text-muted">{row.title}</span>
                                        </div>
                                    </div>
                                </td>
                                <td className={tableClasses.td}>{row.company}</td>
                                <td className={`${tableClasses.td} ${tableClasses.muted}`}>{row.email}</td>
                                <td className={tableClasses.td}>
                                    <Badge dot status={row.status}>
                                        {row.status === 'success' ? 'Valid' : 'Risky'}
                                    </Badge>
                                </td>
                                <td className={tableClasses.td}>
                                    <Badge status={row.stageTone}>{row.stage}</Badge>
                                </td>
                                <td className={tableClasses.td}>
                                    <ScoreBar value={row.score} />
                                </td>
                                <td className={`${tableClasses.td} ${tableClasses.muted}`}>{row.last}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </DataTableChrome>
            <BulkBar count={selected} onDiscard={() => undefined}>
                <BulkBarAction>
                    <Send aria-hidden /> Enrol in sequence
                </BulkBarAction>
                <BulkBarAction>
                    <UserPlus aria-hidden /> Assign to
                </BulkBarAction>
                <BulkBarAction>
                    <Pencil aria-hidden /> Edit
                </BulkBarAction>
            </BulkBar>
        </div>
    );
}

export const Gallery: Story = { render: () => <Example /> };
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');

/** The chrome drawing its own rows from columns: a table on a desktop, the same rows as cards on a phone. */
interface MemberRow {
    id: string;
    name: string;
    email: string;
    role: string;
    joined: string;
}

const MEMBERS: MemberRow[] = [
    { id: 'm1', name: 'Dana Reyes', email: 'dana@acme.example', role: 'admin', joined: 'Oct 1, 2026' },
    { id: 'm2', name: 'Sam Okafor', email: 'sam@initech.example', role: 'member', joined: 'Oct 3, 2026' },
    { id: 'm3', name: 'Priya Nair', email: 'priya@nair.example', role: 'member', joined: 'Oct 7, 2026' },
];

const MEMBER_COLUMNS: TableColumn<MemberRow>[] = [
    { id: 'name', header: 'Member', className: 'font-medium', cell: (m) => m.name },
    {
        id: 'role',
        header: 'Role',
        cell: (m) => <Badge status={m.role === 'admin' ? 'accent' : 'neutral'}>{m.role}</Badge>,
    },
    { id: 'joined', header: 'Joined', muted: true, cell: (m) => m.joined },
    { id: 'email', header: 'Email', muted: true, phone: 'hidden', cell: (m) => m.email },
];

function Members({ layout }: { layout: 'table' | 'cards' }) {
    return (
        <div className={layout === 'cards' ? 'max-w-sm' : undefined}>
            <DataTableChrome<string, MemberRow>
                tabs={[{ id: 'all', label: 'All', count: MEMBERS.length }]}
                activeTab="all"
                data={{
                    label: 'Members',
                    layout,
                    rows: MEMBERS,
                    getRowId: (m) => m.id,
                    leading: (m) => <Avatar name={m.name} size="md" />,
                    columns: MEMBER_COLUMNS,
                    rowActions: {
                        label: (m) => m.name,
                        items: () => <DropdownMenuItem destructive>Remove from workspace</DropdownMenuItem>,
                    },
                }}
            />
        </div>
    );
}

export const RowsAsTable: Story = { render: () => <Members layout="table" /> };
export const RowsAsTableDark: Story = inMode(RowsAsTable, 'dark');
export const RowsAsCards: Story = { render: () => <Members layout="cards" /> };
export const RowsAsCardsDark: Story = inMode(RowsAsCards, 'dark');
export const RowsAsCardsCompact: Story = inMode(RowsAsCards, 'compact');
