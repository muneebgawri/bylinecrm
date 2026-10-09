import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { inMode } from '../../../.storybook/modes';
import { Avatar } from '../avatar/Avatar';
import { Badge } from '../badge/Badge';
import { CardList, type CardListItem } from './CardList';

const meta = { title: 'Shell/CardList', component: CardList } satisfies Meta<typeof CardList>;
export default meta;
type Story = StoryObj;

const PEOPLE: CardListItem[] = [
    {
        id: 'p1',
        leading: <Avatar name="Dana Reyes" size="md" />,
        primary: 'Dana Reyes',
        secondary: ['Acme Corp'],
        meta: [
            <Badge key="s" status="success">
                Owner: Kate
            </Badge>,
            '4h ago',
        ],
    },
    {
        id: 'p2',
        leading: <Avatar name="Sam Okafor" size="md" />,
        primary: 'Sam Okafor',
        secondary: ['Initech'],
        meta: [
            <Badge key="s" status="warning">
                No owner
            </Badge>,
            '1d ago',
        ],
    },
    {
        id: 'p3',
        leading: <Avatar name="Priya Nair" size="md" />,
        primary: 'Priya Nair',
        secondary: ['Nair & Co', 'Founder'],
        meta: ['9d ago'],
    },
];

function People({ selecting }: { selecting: boolean }) {
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['p2']));
    return (
        <div className="max-w-sm">
            <CardList
                aria-label="People"
                items={PEOPLE}
                onOpen={() => {}}
                selecting={selecting}
                selected={selected}
                onToggle={(id) =>
                    setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                    })
                }
            />
        </div>
    );
}

export const Gallery: Story = { render: () => <People selecting={false} /> };
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
export const Selecting: Story = { render: () => <People selecting /> };
export const SelectingDark: Story = inMode(Selecting, 'dark');
