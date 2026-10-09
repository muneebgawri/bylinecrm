import type { Meta, StoryObj } from '@storybook/react-vite';
import { Filter, Plus, Trash2 } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Button } from './Button';

const meta = { title: 'Components/Button', component: Button } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
    render: () => (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary">
                    <Plus aria-hidden /> Create
                </Button>
                <Button variant="accent">Accent</Button>
                <Button>Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">
                    <Trash2 aria-hidden /> Delete
                </Button>
                <Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Button shape="square" variant="primary">
                    Add person
                </Button>
                <Button shape="square">
                    <Filter aria-hidden /> Filter
                </Button>
                <Button shape="square" size="sm">
                    Review
                </Button>
                <Button shape="square" size="xs">
                    Prep
                </Button>
                <Button variant="ghost" size="sm">
                    Snooze
                </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
                <Button size="icon" aria-label="Add">
                    <Plus aria-hidden />
                </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" loading>
                    Saving
                </Button>
                <Button disabled>Disabled</Button>
                <Button loading>Loading</Button>
                <Button asChild>
                    <a href="#people">As link</a>
                </Button>
            </div>
        </div>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
