import type { Decorator, Preview } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { applyDensity, applyTheme } from '../src/theme/theme';
import { TooltipProvider } from '../src/components/tooltip/Tooltip';
import { MODES, type ModeName } from './modes';
import './storybook.css';

/**
 * The mode's attributes are written to <html> BEFORE the story renders, not in an effect after
 * it: an effect runs after the first paint, so every colour on a `transition-colors` element
 * would animate from the light value to the dark one — the a11y gate (which has no animation
 * control) read those in-between colours and failed contrast on exactly the transparent
 * buttons, and the visual gate's screenshot depended on when the race was caught. Setting the
 * attribute first means the story's first computed style is already the mode's; nothing
 * transitions. The write is idempotent, so a repeated render is harmless.
 */
function applyMode(mode: ModeName) {
    const { theme, density } = MODES[mode];
    applyTheme(document.documentElement, theme);
    applyDensity(document.documentElement, density);
}

function Frame({ children }: { children: ReactNode }) {
    return (
        <TooltipProvider>
            <div className="min-h-screen bg-background p-6 text-text">{children}</div>
        </TooltipProvider>
    );
}

const withMode: Decorator = (Story, context) => {
    applyMode((context.parameters.mode as ModeName | undefined) ?? 'light');
    return (
        <Frame>
            <Story />
        </Frame>
    );
};

const preview: Preview = {
    decorators: [withMode],
    parameters: {
        layout: 'fullscreen',
        backgrounds: { disable: true },
    },
};

export default preview;
