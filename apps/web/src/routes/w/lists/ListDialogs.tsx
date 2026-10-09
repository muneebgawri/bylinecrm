import {
    Button,
    Checkbox,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@bylinecrm/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useBulkChange, useCreateRecord, type BulkResult } from '../../../api/lists';
import type { CompanyInput, PersonInput } from '../../../api/types';
import { LIST_COPY, type ListObject } from './listConfig';

/** The message for a failed request: the API's own words when it sent some. */
export function failureText(error: unknown): string {
    if (error instanceof ApiError) return error.fieldErrors[0]?.message ?? error.message;
    return error instanceof Error ? error.message : 'Something went wrong.';
}

/** "Assigned 12 people." / "Assigned 10 of 12 people; 2 were refused: …" */
export function bulkSummary(verb: string, plural: string, result: BulkResult): string {
    const total = result.succeeded + result.failed.length;
    if (result.failed.length === 0) return `${verb} ${total} ${plural}.`;
    return `${verb} ${result.succeeded} of ${total} ${plural}; ${result.failed.length} refused: ${failureText(result.failed[0]?.error)}`;
}

export function SaveViewDialog({
    open,
    onOpenChange,
    canShare,
    pending,
    error,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    canShare: boolean;
    pending: boolean;
    error: string | null;
    onSave: (name: string, isShared: boolean) => void;
}) {
    const [name, setName] = useState('');
    const [shared, setShared] = useState(false);
    const shareId = useId();
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), canShare && shared);
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogTitle>Save view</DialogTitle>
                    <DialogDescription>Keeps this filter, sort and these columns under a name.</DialogDescription>
                    <DialogBody className="flex flex-col gap-3">
                        <Field label="Name" required error={error ?? undefined}>
                            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
                        </Field>
                        {canShare && (
                            <label htmlFor={shareId} className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    id={shareId}
                                    checked={shared}
                                    onCheckedChange={(on) => setShared(on === true)}
                                />
                                Share with the workspace
                            </label>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button shape="square" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={pending}
                            disabled={!name.trim()}
                        >
                            Save view
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    body,
    confirm,
    pending,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    body: string;
    confirm: string;
    pending: boolean;
    onConfirm: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{body}</DialogDescription>
                <DialogFooter>
                    <Button shape="square" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button shape="square" variant="danger" loading={pending} onClick={onConfirm}>
                        {confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Assigns an owner to the chosen records; the API refuses rows the caller may not reassign. */
export function AssignOwnerDialog<O extends ListObject>({
    workspaceId,
    object,
    ids,
    members,
    onOpenChange,
    onDone,
}: {
    workspaceId: string;
    object: O;
    ids: readonly string[];
    members: ReadonlyMap<string, string>;
    onOpenChange: (open: boolean) => void;
    onDone: (summary: string) => void;
}) {
    const [ownerId, setOwnerId] = useState<string | undefined>();
    const change = useBulkChange(workspaceId, object);
    const copy = LIST_COPY[object];
    const submit = async () => {
        if (!ownerId) return;
        const result = await change.mutateAsync({ ids, patch: { ownerId } as never });
        onDone(bulkSummary('Assigned', ids.length === 1 ? copy.singular : copy.plural, result));
    };
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>Assign owner</DialogTitle>
                <DialogDescription>
                    {ids.length === 1 ? `One ${copy.singular}` : `${ids.length} ${copy.plural}`} will move to the owner
                    you choose.
                </DialogDescription>
                <Select {...(ownerId ? { value: ownerId } : {})} onValueChange={setOwnerId}>
                    <SelectTrigger aria-label="Owner">
                        <SelectValue placeholder="Choose a member…" />
                    </SelectTrigger>
                    <SelectContent>
                        {[...members].map(([id, name]) => (
                            <SelectItem key={id} value={id}>
                                {name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <DialogFooter>
                    <Button shape="square" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        shape="square"
                        variant="primary"
                        disabled={!ownerId}
                        loading={change.isPending}
                        onClick={() => void submit()}
                    >
                        Assign
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Adds a person (name, email) or a company (name, domain); everything else is edited on its record. */
export function CreateRecordDialog<O extends ListObject>({
    workspaceId,
    object,
    onOpenChange,
    onCreated,
}: {
    workspaceId: string;
    object: O;
    onOpenChange: (open: boolean) => void;
    onCreated: (id: string) => void;
}) {
    const create = useCreateRecord(workspaceId, object);
    const [a, setA] = useState('');
    const [b, setB] = useState('');
    const [c, setC] = useState('');
    const [error, setError] = useState<string | null>(null);
    const copy = LIST_COPY[object];
    const person = object === 'person';

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const input: PersonInput | CompanyInput = person
            ? { nameFirst: a.trim(), nameLast: b.trim(), emails: { primary: c.trim() || null, additional: [] } }
            : { name: a.trim(), ...(b.trim() ? { domain: b.trim() } : {}) };
        try {
            const created = await create.mutateAsync(input as never);
            onCreated(created.id);
        } catch (err) {
            setError(failureText(err));
        }
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
                <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
                    <DialogTitle>{copy.add}</DialogTitle>
                    <DialogDescription>Everything else is filled in on the record.</DialogDescription>
                    <DialogBody className="flex flex-col gap-3">
                        {person ? (
                            <>
                                <Field label="First name" required>
                                    <Input
                                        value={a}
                                        onChange={(e) => setA(e.target.value)}
                                        autoFocus
                                        autoComplete="off"
                                    />
                                </Field>
                                <Field label="Last name">
                                    <Input value={b} onChange={(e) => setB(e.target.value)} autoComplete="off" />
                                </Field>
                                <Field label="Email">
                                    <Input
                                        type="email"
                                        value={c}
                                        onChange={(e) => setC(e.target.value)}
                                        autoComplete="off"
                                    />
                                </Field>
                            </>
                        ) : (
                            <>
                                <Field label="Name" required>
                                    <Input
                                        value={a}
                                        onChange={(e) => setA(e.target.value)}
                                        autoFocus
                                        autoComplete="off"
                                    />
                                </Field>
                                <Field label="Domain" hint="acme.com — the company's website, without https://">
                                    <Input value={b} onChange={(e) => setB(e.target.value)} autoComplete="off" />
                                </Field>
                            </>
                        )}
                        {error && (
                            <p role="alert" className="m-0 text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button shape="square" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={create.isPending}
                            disabled={!a.trim()}
                        >
                            {copy.add}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
