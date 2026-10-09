import type { Meta, StoryObj } from '@storybook/react-vite';
import { Info } from 'lucide-react';
import { inMode } from '../../../.storybook/modes';
import { Button } from '../button/Button';
import { Tooltip, TooltipContent, TooltipTrigger } from './Tooltip';

const meta = { title: 'Components/Tooltip', component: Tooltip } satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Rendered open so the gates see it; in the product it opens on hover and on focus. */
export const Open: Story = {
    render: () => (
        <div className="flex h-32 items-end">
            <Tooltip open>
                <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Why is this address risky?">
                        <Info aria-hidden />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Verification returned "risky": the domain accepts any address.</TooltipContent>
            </Tooltip>
        </div>
    ),
};
export const OpenDark: Story = inMode(Open, 'dark');
export const OpenCompact: Story = inMode(Open, 'compact');
