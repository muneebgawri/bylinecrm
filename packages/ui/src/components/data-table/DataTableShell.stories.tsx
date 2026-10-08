import type { Meta, StoryObj } from '@storybook/react-vite';
import { Columns3, Filter } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Badge } from '../badge/Badge';
import { Button } from '../button/Button';
import { Checkbox } from '../checkbox/Checkbox';
import { DataTableShell } from './DataTableShell';

const meta = { title: 'Components/DataTableShell', component: DataTableShell } satisfies Meta<typeof DataTableShell>;
export default meta;
type Story = StoryObj;

const rows = [
    ['Series B PR', 'Acme Corp', 'New', '12,000', 'Dana', '3d'],
    ['Product PR', 'Wayne Ent.', 'Contacted', '9,000', 'Dana', '21d'],
    ['Rebrand', 'Globex', 'Replied', '8,000', 'Dana', '2d'],
    ['IPO wire', 'Initech', 'Meeting', '11,000', 'Sam', '1d'],
];
const cols = 'grid grid-cols-[2rem_1.5fr_1fr_1fr_6rem_5rem_4rem] items-center gap-2 px-3';

/** The frame with static rows standing in for the virtualised body P1-UI-2 brings. */
export const Gallery: Story = {
    render: () => (
        <DataTableShell
            label="Deals"
            className="h-80 max-w-4xl"
            toolbar={
                <>
                    <Button variant="secondary" size="sm">
                        <Filter aria-hidden /> Filter
                        <Badge>2</Badge>
                    </Button>
                    <Button variant="ghost" size="sm">
                        <Columns3 aria-hidden /> Columns
                    </Button>
                    <span className="ml-auto text-sm text-text-muted">30 deals · Σ $130k</span>
                </>
            }
            header={
                <div className={`${cols} h-9`}>
                    <Checkbox aria-label="Select all" />
                    <span>Deal</span>
                    <span>Company</span>
                    <span>Stage</span>
                    <span className="text-right">Amount</span>
                    <span>Owner</span>
                    <span>In stage</span>
                </div>
            }
            footer={
                <>
                    <span>1 selected</span>
                    <span>30 of 30</span>
                </>
            }
        >
            <ul className="divide-y divide-border text-sm">
                {rows.map(([deal, company, stage, amount, owner, age], i) => (
                    <li key={deal} className={`${cols} h-10 hover:bg-surface`}>
                        <Checkbox aria-label={`Select ${deal}`} defaultChecked={i === 0} />
                        <span className="font-medium">{deal}</span>
                        <span>{company}</span>
                        <Badge status={stage === 'Replied' ? 'success' : stage === 'Meeting' ? 'info' : 'neutral'}>
                            {stage}
                        </Badge>
                        <span className="text-right tabular-nums">{amount}</span>
                        <span>{owner}</span>
                        <span className={age === '21d' ? 'text-warning' : 'text-text-muted'}>{age}</span>
                    </li>
                ))}
            </ul>
        </DataTableShell>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
