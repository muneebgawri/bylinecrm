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
    Textarea,
    type ToastInput,
    toast,
} from '@bylinecrm/ui';
import {
    companyDomainOfAddress,
    DELETE_NOTE_MAX,
    DELETE_REASONS,
    type DeleteReason,
    type RecordObject,
} from '@bylinecrm/shared';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { usePipelines } from '../../../api/deals';
import { useBulkChange, useCreateRecord } from '../../../api/lists';
import { people, useCustomFields } from '../../../api/records';
import type {
    AddressCheckView,
    BulkResultView,
    CompanyCreateInput,
    CustomFieldView,
    PersonCreateInput,
} from '../../../api/types';
import { RecordPicker } from '../../../components/RecordPicker';
import { useCan } from '../../../auth/capabilities';
import { DELETE_REASON_LABEL } from '../../../lib/deleteReasons';
import { failureText } from '../../../lib/errors';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { linkTo, TEXT_TYPES } from '../records/PropertiesColumn';
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
/**
 * Deletes records — people, companies or deals, from a list's bulk bar or a record page (#416) — in one place: the
 * reason is required, a note optional, both kept with the records in Trash, where they can be restored. One bulk
 * request; `onDone` gets the toast to show, success or refusal.
 */
export function DeleteRecordsDialog<O extends RecordObject>({
    workspaceId,
    object,
    ids,
    onOpenChange,
    onDone,
}: {
    workspaceId: string;
    object: O;
    ids: readonly string[];
    onOpenChange: (open: boolean) => void;
    onDone: (summary: ToastInput, deleted: boolean) => void;
}) {
    const [reason, setReason] = useState<DeleteReason | ''>('');
    const [note, setNote] = useState('');
    const change = useBulkChange(workspaceId, object);
    const copy = LIST_COPY[object];
    const submit = async () => {
        if (!reason) return;
        try {
            const trimmed = note.trim();
            const result = await change.mutateAsync({
                action: 'delete',
                ids: [...ids],
                reason,
                ...(trimmed ? { note: trimmed } : {}),
            });
            onDone(bulkSummary('Deleted', copy, result), result.succeeded > 0);
        } catch (error) {
            onDone({ title: 'Nothing was deleted', description: failureText(error), tone: 'danger' }, false);
        }
    };
    return (
        <ConfirmDialog
            open
            onOpenChange={onOpenChange}
            title={ids.length === 1 ? `Delete this ${copy.singular}?` : `Delete ${ids.length} ${copy.plural}?`}
            body="Delete what is not a lead at all. They move to Trash, where they can be restored. A real lead you no longer work is better released from its Owner field, so someone else can have it."
            confirm="Delete"
            pending={change.isPending}
            confirmDisabled={reason === ''}
            onConfirm={() => void submit()}
        >
            <Field label="Why" required>
                <Select value={reason} onValueChange={(v) => setReason(v as DeleteReason)}>
                    <SelectTrigger aria-label="Why">
                        <SelectValue placeholder="Choose a reason" />
                    </SelectTrigger>
                    <SelectContent>
                        {DELETE_REASONS.map((r) => (
                            <SelectItem key={r} value={r}>
                                {DELETE_REASON_LABEL[r]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <Field label="Note (optional)">
                <Textarea value={note} maxLength={DELETE_NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
            </Field>
        </ConfirmDialog>
    );
}

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

/** The line under "Create a deal": where it starts and the name the API gives it ("<Company> — <Person>"). */
export function dealHint(stage: string | undefined, company: string | undefined, first: string, last: string): string {
    const name = [company, `${first} ${last}`.trim()].filter(Boolean).join(' — ');
    const where = stage ? `In ${stage}` : 'In the first stage';
    return name ? `${where}, named “${name}”. You own it; rename it on the deal.` : `${where}. You own it.`;
}

/**
 * Adds a person or a company (name, domain); everything else is edited on its record. A person starts
 * from the address: it is checked first, so a lead someone already has is caught before any typing,
 * by whose it is; then the name, title and phone. A lead with no address skips the check.
 */
export function CreateRecordDialog<O extends ListObject>({
    workspaceId,
    object,
    lead = false,
    onOpenChange,
    onCreated,
}: {
    workspaceId: string;
    object: O;
    /**
     * "Add lead": the person's deal is made with them, in one request (`withDeal`), unless the rep unticks it.
     * "Add person" offers the same tick, off: a contact is not always a sale.
     */
    lead?: boolean;
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
    /** The asked custom fields' values as typed (a multi-select's as the options ticked), by key; typed on save. */
    const [customValues, setCustomValues] = useState<Record<string, CustomValue>>({});
    /**
     * A person's company: required here (not by the API, which imports and keys write without one). One the rep
     * adds ("Create company") is `NEW_COMPANY`: save sends its name with the person, and the API makes both in one
     * transaction (#353), so a cancelled popup or a refused person leaves no empty company.
     */
    const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
    /** The company came from the address's domain, not the rep: a changed address may replace it. */
    const [companyGuessed, setCompanyGuessed] = useState(false);
    /** Said under the company when saving without one (the button stays live, so the rep learns why). */
    const [companyError, setCompanyError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    /** A person's step: the address first, then the rest once it is known to be free (or left out). */
    const [step, setStep] = useState<'email' | 'details'>('email');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** OWN-2: the company is another member's; the lead can be saved for them instead. */
    const [owned, setOwned] = useState<{ ownerName: string; companyName: string } | null>(null);
    const copy = LIST_COPY[object];
    const person = object === 'person';
    const mayDeal = useCan('deal:edit') && person;
    const [withDeal, setWithDeal] = useState(lead);
    const dealId = useId();
    const pipelines = usePipelines(workspaceId);
    const firstStage = (pipelines.data?.find((p) => p.isDefault) ?? pipelines.data?.[0])?.stages
        .filter((st) => st.kind === 'open')
        .sort((x, y) => x.position - y.position)[0];
    const title = person && lead ? 'Add lead' : copy.add;
    const askingEmail = person && step === 'email';
    // The custom fields an admin asks for here (Settings → Custom fields), and every required one: the API
    // refuses a new person without those. Keyed on this dialog's own object: for New company that is the list
    // page's cached query, so it costs no request, and none of it is asked.
    const asked = (useCustomFields(workspaceId, object).data ?? [])
        .filter((d) => person && d.archivedAt === null && (d.showOnCreate || d.required))
        .sort((x, y) => x.position - y.position);
    const mayAddCompany = useCan('record:write');
    const unfilled = person ? asked.filter((d) => d.required && !filled(customValues[d.key])) : [];

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
            // The company is found from the domain: one already saved, else a new one named for the domain (made
            // on save, or joined to the domain's company if one turns up then). A rep's own choice stays.
            if (!company || companyGuessed) {
                const domain = companyDomainOfAddress(address);
                const found = check.company ?? (domain && mayAddCompany ? { id: NEW_COMPANY, name: domain } : null);
                setCompany(found);
                setCompanyGuessed(found !== null);
                if (found) setCompanyError(null);
            }
            setStep('details');
        } catch (err) {
            setError(failureText(err));
        } finally {
            setChecking(false);
        }
    };

    const withoutEmail = () => {
        setEmail('');
        if (companyGuessed) {
            setCompany(null);
            setCompanyGuessed(false);
        }
        setError(null);
        setStep('details');
    };

    const save = async (handToOwner: boolean) => {
        setSaving(true);
        try {
            await saveRecord(handToOwner);
        } finally {
            setSaving(false);
        }
    };
    /** Another member owns the company: say whose, and (for a person) offer to save the lead for them. */
    const showOwned = (err: ApiError) => {
        const ownerName = String(err.details['ownerName'] ?? 'another member');
        const companyName = String(err.details['companyName'] ?? 'This company');
        setOwned(person ? { ownerName, companyName } : null);
        setError(
            person
                ? `${companyName} is ${ownerName}’s. Its people and deals are theirs, so you can’t save this lead for yourself.`
                : `${companyName} already has this domain, and it is ${ownerName}’s.`,
        );
    };
    const saveRecord = async (handToOwner: boolean) => {
        if (person && !company) {
            setCompanyError('Choose the company they work at: search for it, or type its name and add it.');
            return;
        }
        if (unfilled.length > 0) {
            setError(`Fill in ${unfilled.map((d) => d.label).join(', ')}.`);
            return;
        }
        // A company the rep added goes with the person in the one request (#353); one they chose goes by its id.
        const companyRef = company
            ? company.id === NEW_COMPANY
                ? { company: { name: company.name } }
                : { companyId: company.id }
            : {};
        const digits = phone.replace(/\D/g, '');
        const ext = extension.replace(/\D/g, '');
        const input: PersonCreateInput | CompanyCreateInput = person
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
                  ...companyRef,
                  custom: customInput(asked, customValues),
                  ...(handToOwner ? { handToOwner: true } : {}),
                  // The deal goes with the person, in the API's one transaction; a lead handed to its owner gets none.
                  ...(mayDeal && withDeal && !handToOwner ? { withDeal: {} } : {}),
              }
            : { name: a.trim(), ...(b.trim() ? { domain: b.trim() } : {}) };
        try {
            const created = await create.mutateAsync(input as never);
            if (handToOwner && owned) {
                toast({ tone: 'success', title: `Saved for ${owned.ownerName}. They’ve been told.` });
                onOpenChange(false);
                return;
            }
            if ('deal' in created && created.deal) {
                toast({ tone: 'success', title: `Deal “${created.deal.name}” created` });
            }
            onCreated(created.id);
        } catch (err) {
            if (err instanceof ApiError && err.code === 'conflict.company_owned') {
                const existing = err.details['companyId'];
                // The company the rep added has another member's domain: nothing was made. Choose that company, not
                // a twin, and offer what saving can actually do — hand the lead to its owner.
                if (company?.id === NEW_COMPANY && typeof existing === 'string') {
                    setCompany({ id: existing, name: String(err.details['companyName'] ?? 'Another company') });
                }
                showOwned(err);
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
                    <DialogTitle>{title}</DialogTitle>
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
                                <Field label="Company" required error={companyError ?? undefined}>
                                    <RecordPicker
                                        workspaceId={workspaceId}
                                        object="company"
                                        label="Company"
                                        placeholder="Search or add a company"
                                        value={company?.id ?? null}
                                        valueLabel={company?.name}
                                        onChange={(id) => {
                                            if (!id) setCompany(null);
                                            setCompanyGuessed(false);
                                        }}
                                        onResolved={(id, name) => {
                                            setCompany({ id, name });
                                            setCompanyGuessed(false);
                                            setCompanyError(null);
                                        }}
                                        onCreate={
                                            mayAddCompany
                                                ? (name) =>
                                                      Promise.resolve({ id: NEW_COMPANY, title: name, pending: true })
                                                : undefined
                                        }
                                    />
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
                                {asked.map((definition) => (
                                    <CustomFieldInput
                                        key={definition.key}
                                        definition={definition}
                                        value={customValues[definition.key] ?? ''}
                                        onChange={(v) => setCustomValues((all) => ({ ...all, [definition.key]: v }))}
                                    />
                                ))}
                                {mayDeal && (
                                    <div className="flex flex-col gap-0.5">
                                        <label htmlFor={dealId} className="flex items-center gap-2 text-sm">
                                            <Checkbox
                                                id={dealId}
                                                checked={withDeal}
                                                onCheckedChange={(on) => setWithDeal(on === true)}
                                            />
                                            Create a deal
                                        </label>
                                        {withDeal && (
                                            <p className="m-0 pl-6 text-xs text-text-muted">
                                                {dealHint(firstStage?.name, company?.name, a.trim(), b.trim())}
                                            </p>
                                        )}
                                    </div>
                                )}
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
                                loading={saving}
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
                                loading={saving}
                                disabled={!a.trim()}
                            >
                                {title}
                            </Button>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** An asked custom field as a form input, by its type; the value is kept as typed until save. */
function CustomFieldInput({
    definition,
    value,
    onChange,
}: {
    definition: CustomFieldView;
    value: CustomValue | undefined;
    onChange: (value: CustomValue) => void;
}) {
    if (definition.type === 'multiselect') {
        const ticked = new Set(Array.isArray(value) ? value : []);
        return (
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1 text-sm font-medium">
                    {definition.label}
                    {definition.required && <span className="text-danger"> *</span>}
                </legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {definition.options.map((option) => (
                        <label key={option} className="flex min-h-9 items-center gap-1.5 text-sm max-md:min-h-touch">
                            <Checkbox
                                checked={ticked.has(option)}
                                onCheckedChange={(on) => {
                                    const next = new Set(ticked);
                                    if (on === true) next.add(option);
                                    else next.delete(option);
                                    // In the field's own order, whatever order they were ticked in.
                                    onChange(definition.options.filter((o) => next.has(o)));
                                }}
                            />
                            {option}
                        </label>
                    ))}
                </div>
            </fieldset>
        );
    }
    const text = typeof value === 'string' ? value : '';
    const choices =
        definition.type === 'select' ? definition.options : definition.type === 'boolean' ? ['Yes', 'No'] : null;
    if (choices) {
        return (
            <Field label={definition.label} required={definition.required}>
                <Select {...(text ? { value: text } : {})} onValueChange={onChange}>
                    <SelectTrigger aria-label={definition.label}>
                        <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                        {choices.map((o) => (
                            <SelectItem key={o} value={o}>
                                {o}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
        );
    }
    return (
        <Field label={definition.label} required={definition.required}>
            <Input
                // A link pasted without https:// is taken (linkTo adds it on save); `type="url"` would refuse it.
                {...(definition.type === 'url'
                    ? { type: 'text', inputMode: 'url' as const }
                    : { type: TEXT_TYPES[definition.type] ?? 'text' })}
                value={text}
                onChange={(e) => onChange(e.target.value)}
                autoComplete="off"
            />
        </Field>
    );
}

/** The asked fields' typed values in their types, as the API takes them; an empty one is left out. */
function customInput(
    definitions: readonly CustomFieldView[],
    typed: Record<string, CustomValue>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const d of definitions) {
        const value = typed[d.key];
        if (value === undefined || !filled(value)) continue;
        if (Array.isArray(value)) {
            out[d.key] = value;
            continue;
        }
        const raw = value.trim();
        if (d.type === 'number') out[d.key] = Number(raw);
        else if (d.type === 'boolean') out[d.key] = raw === 'Yes';
        else if (d.type === 'url') out[d.key] = linkTo(raw);
        else out[d.key] = raw;
    }
    return out;
}

/** A taken address, said by whose person has it — what the saver needs to know whom to ask. */
function takenText(holder: NonNullable<AddressCheckView['holder']>): string {
    if (holder.workspaceName) return `This person is already a lead in ${holder.workspaceName}.`;
    const whose = holder.ownerName
        ? `${holder.ownerName} already has this person`
        : 'This person is already saved, with no owner';
    return holder.trashed ? `${whose}, in the trash.` : `${whose}.`;
}

/** An asked field's value in the form: text as typed, or a multi-select's ticked options. */
type CustomValue = string | string[];

const filled = (value: CustomValue | undefined): boolean =>
    Array.isArray(value) ? value.length > 0 : (value ?? '').trim() !== '';

/** The picker's id for a company added in the popup and not made yet (it is made on save). */
const NEW_COMPANY = 'new-company';
