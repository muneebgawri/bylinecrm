import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect, type ReactNode } from 'react';
import { applyDensity, applyTheme } from '../src/theme/theme';
import { TooltipProvider } from '../src/components/tooltip/Tooltip';
import { MODES, type ModeName } from './modes';
import './storybook.css';

/** Sets the mode's attributes the way the app does, then frames the story on the page background. */
function ModeFrame({ mode, children }: { mode: ModeName; children: ReactNode }) {
    const { theme, density } = MODES[mode];
    useEffect(() => {
        applyTheme(document.documentElement, theme);
        applyDensity(document.documentElement, density);
    }, [theme, density]);
    return (
        <TooltipProvider>
            <div className="min-h-screen bg-background p-6 text-text">{children}</div>
        </TooltipProvider>
    );
}

const withMode: Decorator = (Story, context) => (
    <ModeFrame mode={(context.parameters.mode as ModeName | undefined) ?? 'light'}>
        <Story />
    </ModeFrame>
);

const preview: Preview = {
    decorators: [withMode],
    parameters: {
        layout: 'fullscreen',
        backgrounds: { disable: true },
    },
};

export default preview;
