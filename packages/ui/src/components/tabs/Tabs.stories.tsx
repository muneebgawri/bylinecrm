import type { Meta, StoryObj } from '@storybook/react-vite';
import { inMode } from '../../../.storybook/modes';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './Tabs';

const meta = { title: 'Components/Tabs', component: Tabs } satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
    render: () => (
        <Tabs defaultValue="all" className="max-w-lg">
            <TabsList aria-label="Activity filter">
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="emails">Emails</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
                <TabsTrigger value="tasks" disabled>
                    Tasks
                </TabsTrigger>
            </TabsList>
            <TabsContent value="all" className="text-sm text-text-muted">
                Everything on this record, newest first.
            </TabsContent>
            <TabsContent value="emails">Emails only.</TabsContent>
            <TabsContent value="notes">Notes only.</TabsContent>
        </Tabs>
    ),
};
export const GalleryDark: Story = inMode(Gallery, 'dark');
export const GalleryCompact: Story = inMode(Gallery, 'compact');
