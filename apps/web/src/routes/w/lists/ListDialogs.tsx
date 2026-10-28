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
    type ToastInput,
    toast,
} from '@bylinecrm/ui';
import type { RecordObject } from '@bylinecrm/shared';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useBulkChange, useCreateRecord } from '../../../api/lists';
import { people } from '../../../api/records';
import type { AddressCheckView, BulkResultView, CompanyInput, PersonInput } from '../../../api/types';
import { failureText } from '../../../lib/errors';
import { LIST_COPY, type ListObject } from './listConfig';

/** The shared dialog and message, re-exported where the lists and the deals page already read them. */
export { ConfirmDialog } from '../../../components/ConfirmDialog';
export { failureText };

/**
 * The one notice for a change to many records, from the API's per-record results (P1-4a):
 * "Assigned 10 people · 2 already were · 1 not found". A record the caller cannot act on reads
 * `not_found` whatever the reason, so the notice says "not found or not yours", never more.
 */
export function bulkSummary(
    verb: string,
    noun: { singular: string; plural: string },
    result: BulkResultView,
): ToastInput {
    const unchanged = result.results.filter((r) => r.ok && r.unchanged).length;
    const changed = result.succeeded - unchanged;
    const parts = [`${verb} ${changed} ${changed === 1 ? noun.singular : noun.plural}`];
    if (unchanged) parts.push(`${unchanged} already ${unchanged === 1 ? 'was' : 'were'}`);
    if (result.failed === 0) return { title: parts.join(' · '), tone: 'success' };
    return {
        title: parts.join(' · '),
        description: `${result.failed} not found or not yours to change.`,
        tone: 'warning',
    };
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

/** Assigns an owner to the chosen records in one bulk request; the API reports rows it would not change. */
export function AssignOwnerDialog<O extends RecordObject>({
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
    onDone: (summary: ToastInput) => void;
}) {
    const [ownerId, setOwnerId] = useState<string | undefined>();
    const change = useBulkChange(workspaceId, object);
    const copy = LIST_COPY[object];
    const submit = async () => {
        if (!ownerId) return;
        try {
            const result = await change.mutateAsync({ action: 'assign_owner', ids, ownerId });
            onDone(bulkSummary('Assigned', copy, result));
        } catch (error) {
            // Refused as a whole (an own-scoped member naming someone else, an owner who left): nothing changed.
            onDone({ title: 'Nobody was reassigned', description: failureText(error), tone: 'danger' });
        }
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

/**
 * Adds a person or a company (name, domain); everything else is edited on its record. A person starts
 * from the address: it is checked first, so a lead someone already has is caught before any typing,
 * by whose it is; then the name, title and phone. A lead with no address skips the check.
 */
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
    const [email, setEmail] = useState('');
    const [jobTitle, setJobTitle] = useState('');
    const [phone, setPhone] = useState('');
    const [extension, setExtension] = useState('');
    /** A person's step: the address first, then the rest once it is known to be free (or left out). */
    const [step, setStep] = useState<'email' | 'details'>('email');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** OWN-2: the company is another member's; the lead can be saved for them instead. */
    const [owned, setOwned] = useState<{ ownerName: string; companyName: string } | null>(null);
    const copy = LIST_COPY[object];
    const person = object === 'person';
    const askingEmail = person && step === 'email';

    const checkEmail = async () => {
        const address = email.trim();
        if (!address) return;
        setChecking(true);
        try {
            const check = await people.addressCheck(workspaceId, address);
            if (check.holder) {
                setError(takenText(check.holder));
                return;
            }
            setError(null);
            setStep('details');
        } catch (err) {
            setError(failureText(err));
        } finally {
            setChecking(false);
        }
    };

    const withoutEmail = () => {
        setEmail('');
        setError(null);
        setStep('details');
    };

    const save = async (handToOwner: boolean) => {
        const digits = phone.replace(/\D/g, '');
        const ext = extension.replace(/\D/g, '');
        const input: PersonInput | CompanyInput = person
            ? {
                  nameFirst: a.trim(),
                  nameLast: b.trim(),
                  emails: { primary: email.trim() || null, additional: [] },
                  ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
                  ...(digits
                      ? {
                            phones: {
                                primary: { number: digits, countryCode: 'US', ...(ext ? { extension: ext } : {}) },
                                additional: [],
                            },
                        }
                      : {}),
                  ...(handToOwner ? { handToOwner: true } : {}),
              }
            : { name: a.trim(), ...(b.trim() ? { domain: b.trim() } : {}) };
        try {
            const created = await create.mutateAsync(input as never);
            if (handToOwner && owned) {
                toast({ tone: 'success', title: `Saved for ${owned.ownerName}. They’ve been told.` });
                onOpenChange(false);
                return;
            }
            onCreated(created.id);
        } catch (err) {
            if (err instanceof ApiError && err.code === 'conflict.company_owned') {
                const ownerName = String(err.details['ownerName'] ?? 'another member');
                const companyName = String(err.details['companyName'] ?? 'This company');
                setOwned(person ? { ownerName, companyName } : null);
                setError(
                    person
                        ? `${companyName} is ${ownerName}’s. Its people and deals are theirs, so you can’t save this lead for yourself.`
                        : `${companyName} already has this domain, and it is ${ownerName}’s.`,
                );
                return;
            }
            setOwned(null);
            setError(failureText(err));
        }
    };
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (askingEmail) await checkEmail();
        else await save(false);
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
                <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
                    <DialogTitle>{copy.add}</DialogTitle>
                    <DialogDescription>
                        {askingEmail
                            ? 'Start with their email: we check nobody has them yet.'
                            : 'Everything else is filled in on the record.'}
                    </DialogDescription>
                    <DialogBody className="flex flex-col gap-3">
                        {askingEmail ? (
                            <>
                                <Field label="Email" required>
                                    <Input
                                        type="email"
                                        value={email}
                                        onChange={(e) => {
                                            setEmail(e.target.value);
                                            setError(null);
                                        }}
                                        autoFocus
                                        autoComplete="off"
                                    />
                                </Field>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    shape="square"
                                    className="self-start"
                                    onClick={withoutEmail}
                                >
                                    No email? Continue without one
                                </Button>
                            </>
                        ) : person ? (
                            <>
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-text-muted">Email</span>
                                    <span className="min-w-0 truncate">{email.trim() || 'None'}</span>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        shape="square"
                                        className="ml-auto"
                                        onClick={() => {
                                            setStep('email');
                                            setOwned(null);
                                            setError(null);
                                        }}
                                    >
                                        Change
                                    </Button>
                                </div>
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
                                <Field label="Job title">
                                    <Input
                                        value={jobTitle}
                                        onChange={(e) => setJobTitle(e.target.value)}
                                        autoComplete="off"
                                    />
                                </Field>
                                <div className="flex gap-2">
                                    <Field label="Phone" className="min-w-0 flex-1">
                                        <Input
                                            type="tel"
                                            value={phone}
                                            onChange={(e) => setPhone(e.target.value)}
                                            placeholder="digits only"
                                            autoComplete="off"
                                        />
                                    </Field>
                                    <Field label="Ext." className="w-24 shrink-0">
                                        <Input
                                            type="tel"
                                            value={extension}
                                            onChange={(e) => setExtension(e.target.value)}
                                            disabled={!phone.trim()}
                                            autoComplete="off"
                                        />
                                    </Field>
                                </div>
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
                        {owned && (
                            <Button
                                type="button"
                                shape="square"
                                className="self-start"
                                loading={create.isPending}
                                onClick={() => void save(true)}
                            >
                                Save for {owned.ownerName}
                            </Button>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button shape="square" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        {askingEmail ? (
                            <Button
                                type="submit"
                                shape="square"
                                variant="primary"
                                loading={checking}
                                disabled={!email.trim()}
                            >
                                Continue
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                shape="square"
                                variant="primary"
                                loading={create.isPending}
                                disabled={!a.trim()}
                            >
                                {copy.add}
                            </Button>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** A taken address, said by whose person has it — what the saver needs to know whom to ask. */
function takenText(holder: NonNullable<AddressCheckView['holder']>): string {
    if (holder.workspaceName) return `This person is already a lead in ${holder.workspaceName}.`;
    const whose = holder.ownerName
        ? `${holder.ownerName} already has this person`
        : 'This person is already saved, with no owner';
    return holder.trashed ? `${whose}, in the trash.` : `${whose}.`;
}
