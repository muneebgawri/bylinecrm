import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../theme/ThemeProvider';
import { THEMES, type Theme } from '../../theme/theme';
import { Button } from '../button/Button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '../dropdown-menu/DropdownMenu';

const LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };
const ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/** Light / dark / system, persisted by ThemeProvider. Lives in the app shell's top bar. */
export function ThemeToggle() {
    const { theme, setTheme } = useTheme();
    const Icon = ICONS[theme];
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Theme: ${LABELS[theme]}`}>
                    <Icon aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
                    {THEMES.map((t) => {
                        const ItemIcon = ICONS[t];
                        return (
                            <DropdownMenuRadioItem key={t} value={t}>
                                <ItemIcon aria-hidden />
                                {LABELS[t]}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
