import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { DENSITY_ATTRIBUTE, THEME_ATTRIBUTE, THEME_STORAGE_KEY } from './theme';

/** Drives the provider the way a settings screen would: through its hook, from the DOM. */
function Probe() {
    const { theme, setTheme, setDensity } = useTheme();
    return (
        <>
            <output>{theme}</output>
            <button onClick={() => setTheme('dark')}>dark</button>
            <button onClick={() => setTheme('system')}>system</button>
            <button onClick={() => setDensity('compact')}>compact</button>
        </>
    );
}

function renderProbe() {
    return render(
        <ThemeProvider>
            <Probe />
        </ThemeProvider>,
    );
}

describe('ThemeProvider', () => {
    afterEach(() => {
        window.localStorage.clear();
        document.documentElement.removeAttribute(THEME_ATTRIBUTE);
        document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
    });

    it('defaults to system (no attribute) and persists an explicit choice under one key', async () => {
        renderProbe();
        expect(document.documentElement).not.toHaveAttribute(THEME_ATTRIBUTE);

        await userEvent.click(screen.getByRole('button', { name: 'dark' }));
        expect(document.documentElement).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

        await userEvent.click(screen.getByRole('button', { name: 'system' }));
        expect(document.documentElement).not.toHaveAttribute(THEME_ATTRIBUTE);
    });

    it('reads a stored preference on mount and ignores an invalid one', async () => {
        window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
        renderProbe();
        expect(screen.getByRole('status')).toHaveTextContent('system');

        await userEvent.click(screen.getByRole('button', { name: 'compact' }));
        expect(document.documentElement).toHaveAttribute(DENSITY_ATTRIBUTE, 'compact');
    });
});
