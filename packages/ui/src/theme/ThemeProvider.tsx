import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import {
    applyDensity,
    applyTheme,
    DENSITY_STORAGE_KEY,
    isDensity,
    isTheme,
    THEME_STORAGE_KEY,
    type Density,
    type Theme,
} from './theme';
import { readStored, writeStored } from '../lib/persisted';

interface ThemeContextValue {
    theme: Theme;
    density: Density;
    setTheme: (theme: Theme) => void;
    setDensity: (density: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
    children: ReactNode;
    /** Where the attributes go. Defaults to `<html>`, which is what `tokens.css` targets. */
    root?: HTMLElement;
}

export function ThemeProvider({ children, root }: ThemeProviderProps) {
    const [theme, setThemeState] = useState<Theme>(() => readStored(THEME_STORAGE_KEY, isTheme, 'system'));
    const [density, setDensityState] = useState<Density>(() =>
        readStored(DENSITY_STORAGE_KEY, isDensity, 'comfortable'),
    );

    // Layout effects run before paint, so a change never shows a frame of the previous mode. The
    // very first paint is covered earlier still, by the bootstrap script in the app's index.html.
    useLayoutEffect(() => applyTheme(root ?? document.documentElement, theme), [root, theme]);
    useLayoutEffect(() => applyDensity(root ?? document.documentElement, density), [root, density]);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        writeStored(THEME_STORAGE_KEY, next);
    }, []);
    const setDensity = useCallback((next: Density) => {
        setDensityState(next);
        writeStored(DENSITY_STORAGE_KEY, next);
    }, []);

    const value = useMemo(() => ({ theme, density, setTheme, setDensity }), [theme, density, setTheme, setDensity]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
    return ctx;
}
