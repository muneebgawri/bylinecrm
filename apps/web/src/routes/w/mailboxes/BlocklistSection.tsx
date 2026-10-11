import { normaliseBlocklistValue, type BlocklistScope } from '@bylinecrm/shared';
import {
    Button,
    DataTableChrome,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenuItem,
    EmptyState,
    Field,
    Input,
    RadioGroup,
    toast,
    type RadioOption,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import { useAddBlocklistEntry, useBlocklist, useRemoveBlocklistEntry } from '../../../api/mailAdmin';
import type { BlocklistEntryCreatedView, BlocklistEntryView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';

const SCOPE_LABEL: Record<BlocklistScope, string> = { personal: 'Only you', workspace: 'Whole workspace' };

const SCOPES: readonly RadioOption<BlocklistScope>[] = [
    { value: 'personal', label: 'Only my mailboxes', description: 'Mail to and from it stays out of your mailboxes.' },
    {
        value: 'workspace',
        label: 'The whole workspace',
        description: 'Mail to and from it stays out of every mailbox in the workspace.',
    },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a new entry removed, in words (P2-2: the blocklist reaches mail already stored). */
export function purgeSummary(purged: BlocklistEntryCreatedView['purged']): string {
    if (purged.messages === 0) return 'No stored mail was covered.';
    return `Removed ${plural(purged.messages, 'message', 'messages')} from ${plural(purged.threads, 'thread', 'threads')}.`;
}

/**
 * Addresses and domains whose mail is never imported (FR-CRMS-2, PAR-017). A member keeps their
 * own list; an admin also keeps the workspace's. Adding an entry removes the stored mail it now
 * covers; removing one does not bring that mail back.
 */
export function BlocklistSection({ workspaceId }: { workspaceId: string }) {
    const entries = useBlocklist(workspaceId);
    const manage = useCan('mailbox:manage');
    const admin = useCan('workspace:admin');
    const remove = useRemoveBlocklistEntry(workspaceId);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<BlocklistEntryView | null>(null);
    if (entries.isError) throw entries.error;
    const canRemove = (entry: BlocklistEntryView) => manage && (entry.scope === 'personal' || admin);

    return (
        <section aria-labelledby="blocklist-title" className="mt-8">
            <h2 id="blocklist-title" className="m-0 mb-1 text-base font-semibold">
                Blocklist
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Mail whose every outside participant is on the blocklist is never imported. Adding an address also
                removes the mail already stored that it covers.
            </p>
            <DataTableChrome
                {...(manage && {
                    toolbar: {
                        extra: (
                            <Button shape="square" size="sm" onClick={() => setAdding(true)}>
                                Block an address
                            </Button>
                        ),
                    },
                })}
                data={{
                    label: 'Blocklist',
                    loading: entries.isPending,
                    rows: entries.data ?? [],
                    getRowId: (entry) => entry.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="Nothing is blocked"
                            body="Block a newsletter or a personal contact so its mail never reaches the CRM."
                        />
                    ),
                    columns: [
                        {
                            id: 'value',
                            header: 'Address or domain',
                            cell: (entry) => <code className="text-xs break-all">{entry.value}</code>,
                        },
                        { id: 'scope', header: 'Applies to', cell: (entry) => SCOPE_LABEL[entry.scope] },
                        {
                            id: 'added',
                            header: 'Added',
                            muted: true,
                            phone: 'meta',
                            cell: (entry) => formatDate(entry.createdAt),
                        },
                    ],
                    rowActions: {
                        label: (entry) => entry.value,
                        items: (entry) =>
                            canRemove(entry) ? (
                                <DropdownMenuItem
                                    destructive
                                    onSelect={() => {
                                        remove.reset();
                                        setRemoving(entry);
                                    }}
                                >
                                    Unblock
                                </DropdownMenuItem>
                            ) : null,
                    },
                }}
            />
            <AddEntryDialog workspaceId={workspaceId} admin={admin} open={adding} onOpenChange={setAdding} />
            <ConfirmDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                title={`Unblock ${removing?.value ?? ''}?`}
                body="Its mail is imported again from now on. Mail removed when it was blocked does not come back."
                confirm="Unblock"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() =>
                    removing &&
                    remove.mutate(removing.id, {
                        onSuccess: () => {
                            toast({ title: `Unblocked ${removing.value}` });
                            setRemoving(null);
                        },
                    })
                }
            />
        </section>
    );
}

function AddEntryDialog({
    workspaceId,
    admin,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    admin: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const add = useAddBlocklistEntry(workspaceId);
    const [value, setValue] = useState('');
    const [scope, setScope] = useState<BlocklistScope>('personal');
    const [invalid, setInvalid] = useState(false);
    const close = () => {
        setValue('');
        setScope('personal');
        setInvalid(false);
        add.reset();
        onOpenChange(false);
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        // The same rule the API applies, so a typo is caught here and a correct value is sent normalised.
        const normalised = normaliseBlocklistValue(value);
        if (!normalised) {
            setInvalid(true);
            return;
        }
        add.mutate(
            { value: normalised, scope },
            {
                onSuccess: (created) => {
                    toast({ title: `Blocked ${created.entry.value}`, description: purgeSummary(created.purged) });
                    close();
                },
            },
        );
    };
    const error = invalid
        ? 'Enter an address like someone@example.com, or a domain like @example.com.'
        : (fieldErrorAt(add.error, 'value') ?? (add.isError ? failureText(add.error) : undefined));
    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent>
                <DialogTitle>Block an address</DialogTitle>
                <DialogDescription>
                    Stored mail it fully covers is removed now, and new mail from it is never imported.
                </DialogDescription>
                <form onSubmit={submit} noValidate>
                    <DialogBody className="flex flex-col gap-4">
                        <Field
                            label="Address or domain"
                            required
                            hint="someone@example.com, or @example.com for a whole domain"
                            error={error}
                        >
                            <Input
                                value={value}
                                onChange={(e) => {
                                    setValue(e.target.value);
                                    setInvalid(false);
                                }}
                                autoComplete="off"
                                spellCheck={false}
                                inputMode="email"
                            />
                        </Field>
                        {admin && (
                            <RadioGroup
                                legend="Who it applies to"
                                options={SCOPES}
                                value={scope}
                                onValueChange={setScope}
                            />
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            shape="square"
                            loading={add.isPending}
                            disabled={!value.trim()}
                        >
                            Block
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
