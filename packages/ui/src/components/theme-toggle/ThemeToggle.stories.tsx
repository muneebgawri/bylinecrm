import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThemeProvider } from '../../theme/ThemeProvider';
import { ThemeToggle } from './ThemeToggle';

/**
 * This component controls the theme itself, so it is the one story not exported per mode: it
 * mounts a real ThemeProvider and is exercised by hand (and by its unit test) rather than frozen
 * in dark/compact by the decorator.
 */
const meta: Meta<typeof ThemeToggle> = {
    title: 'Components/ThemeToggle',
    component: ThemeToggle,
    decorators: [
        (Story) => (
            <ThemeProvider>
                <Story />
            </ThemeProvider>
        ),
    ],
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => (
        <div className="flex items-center gap-3">
            <ThemeToggle />
            <span className="text-sm text-text-muted">Light / dark / system, remembered per browser.</span>
        </div>
    ),
};
