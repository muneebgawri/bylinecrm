import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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

interface ThemeContextValue {
    theme: Theme;
    density: Density;
    setTheme: (theme: Theme) => void;
    setDensity: (density: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** localStorage can throw (private windows, blocked storage); a preference that cannot be read is the default. */
function readStored<T>(key: string, guard: (value: unknown) => value is T, fallback: T): T {
    try {
        const raw = window.localStorage.getItem(key);
        return guard(raw) ? raw : fallback;
    } catch {
        return fallback;
    }
}

function writeStored(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // Nothing to do: the choice still applies for this page; it just will not persist.
    }
}

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

    useEffect(() => applyTheme(root ?? document.documentElement, theme), [root, theme]);
    useEffect(() => applyDensity(root ?? document.documentElement, density), [root, density]);

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
