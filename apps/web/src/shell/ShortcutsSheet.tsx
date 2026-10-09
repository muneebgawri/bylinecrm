import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from '@bylinecrm/ui';
import { useCommands } from '../commands/registry';
import { formatShortcut } from '../commands/shortcuts';
import { PALETTE_GROUPS } from './CommandPalette';

/** `?` opens it: every registered command that has a shortcut, by group. */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const commands = useCommands().filter((c) => c.shortcut && (c.when?.() ?? true));
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>Keyboard shortcuts</DialogTitle>
                <DialogDescription>Press a key, or a chord of two keys within a second.</DialogDescription>
                <DialogBody>
                    <dl className="grid gap-4">
                        {PALETTE_GROUPS.map((group) => {
                            const rows = commands.filter((c) => c.group === group);
                            if (rows.length === 0) return null;
                            return (
                                <div key={group}>
                                    <dt className="mb-1.5 text-[11.5px] font-medium text-text-faint">{group}</dt>
                                    {rows.map((c) => (
                                        <dd key={c.id} className="flex items-center justify-between py-1 text-sm">
                                            <span>{c.title}</span>
                                            <kbd className="rounded-[5px] border border-border bg-surface-raised px-1.5 text-[11px] font-sans text-text-muted">
                                                {formatShortcut(c.shortcut ?? '')}
                                            </kbd>
                                        </dd>
                                    ))}
                                </div>
                            );
                        })}
                    </dl>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}
