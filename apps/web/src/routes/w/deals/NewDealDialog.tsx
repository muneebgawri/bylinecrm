import {
    Button,
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
    toast,
} from '@bylinecrm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateDeal } from '../../../api/deals';
import { keys } from '../../../api/queries';
import { people } from '../../../api/records';
import type { PipelineView } from '../../../api/types';
import { RecordPicker } from '../../../components/RecordPicker';
import { parseMoneyInput } from '../../../lib/money';
import { fieldTitle } from '../records/fields';

export interface NewDealDialogProps {
    workspaceId: string;
    pipeline: PipelineView | undefined;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The workspace's currency for an amount typed without one. */
    currency: string;
    /** Filled in when the dialog opens from a record (a person's "New deal"): the contact, and their company. */
    contact?: Linked | null | undefined;
    company?: Linked | null | undefined;
}

/** A record the deal links to, by id and name. */
interface Linked {
    id: string;
    name: string;
}

/**
 * "+ New deal": name, contact, company, amount, close date, starting stage (first open stage by default). Picking a
 * contact fills in their company; both are found with the one record picker.
 */
export function NewDealDialog({
    workspaceId,
    pipeline,
    open,
    onOpenChange,
    currency,
    contact,
    company,
}: NewDealDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                {open && pipeline && (
                    <NewDealForm
                        workspaceId={workspaceId}
                        pipeline={pipeline}
                        currency={currency}
                        initialContact={contact ?? null}
                        initialCompany={company ?? null}
                        onDone={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function NewDealForm({
    workspaceId,
    pipeline,
    currency,
    initialContact,
    initialCompany,
    onDone,
}: {
    workspaceId: string;
    pipeline: PipelineView;
    currency: string;
    initialContact: Linked | null;
    initialCompany: Linked | null;
    onDone: () => void;
}) {
    const openStages = useMemo(() => pipeline.stages.filter((s) => s.kind === 'open'), [pipeline.stages]);
    const [name, setName] = useState('');
    const [stageId, setStageId] = useState(openStages[0]?.id ?? '');
    const [amountText, setAmountText] = useState('');
    const [closeDate, setCloseDate] = useState('');
    const [contact, setContact] = useState<Linked | null>(initialContact);
    const [company, setCompany] = useState<Linked | null>(initialCompany);
    /** The contact last picked: their company fills the company field when the person has loaded, unless another was picked since. */
    const latestContact = useRef<string | null>(initialContact?.id ?? null);
    const client = useQueryClient();
    const pickContact = (id: string, name: string) => {
        setContact({ id, name });
        latestContact.current = id;
        void client
            .fetchQuery({
                queryKey: keys.record(workspaceId, 'person', id),
                queryFn: ({ signal }) => people.get(workspaceId, id, signal),
            })
            .then((person) => {
                if (latestContact.current === id && person.company) setCompany({ ...person.company });
            })
            .catch(() => undefined);
    };
    const [errors, setErrors] = useState<Record<string, string>>({});
    const create = useCreateDeal(workspaceId);

    function submit(event: FormEvent) {
        event.preventDefault();
        const next: Record<string, string> = {};
        if (!name.trim()) next.name = 'Give the deal a name.';
        const amount = amountText.trim() ? parseMoneyInput(amountText, currency) : null;
        if (amountText.trim() && !amount) next.amount = 'Enter an amount, like 12000 or 12,000.50.';
        // OWN-2b: a deal is with a company, and is its owner's.
        if (!company) next.companyId = 'Pick the company this deal is with.';
        if (Object.keys(next).length) {
            setErrors(next);
            return;
        }
        create.mutate(
            {
                name: name.trim(),
                pipelineId: pipeline.id,
                stageId,
                amount,
                closeDate: closeDate || null,
                companyId: company?.id ?? null,
                pointOfContactId: contact?.id ?? null,
            },
            {
                onSuccess: (deal) => {
                    toast({ title: `${deal.name} created`, tone: 'success' });
                    onDone();
                },
                onError: (error) => {
                    if (error instanceof ApiError && error.fieldErrors.length) {
                        setErrors(
                            Object.fromEntries(
                                error.fieldErrors.map((f) => [f.path.split('.')[0] ?? f.path, f.message]),
                            ),
                        );
                    } else {
                        toast({
                            title: 'The deal was not created',
                            description: error instanceof ApiError ? error.message : 'The server could not be reached.',
                            tone: 'danger',
                        });
                    }
                },
            },
        );
    }

    return (
        <form onSubmit={submit} noValidate className="contents">
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>It starts in {pipeline.name}, in the stage you choose.</DialogDescription>
            <DialogBody className="flex flex-col gap-4">
                <Field label="Name" required error={errors.name}>
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field label="Contact" error={errors.pointOfContactId} hint="Their company fills in below">
                    <RecordPicker
                        workspaceId={workspaceId}
                        object="person"
                        label="Contact"
                        clearLabel="No contact"
                        placeholder="Search people"
                        value={contact?.id ?? null}
                        valueLabel={contact?.name}
                        onChange={(id) => {
                            if (!id) {
                                setContact(null);
                                latestContact.current = null;
                            }
                        }}
                        onResolved={pickContact}
                    />
                </Field>
                <Field label="Company" required error={errors.companyId}>
                    <RecordPicker
                        workspaceId={workspaceId}
                        object="company"
                        label="Company"
                        placeholder="Search by name or domain"
                        value={company?.id ?? null}
                        valueLabel={company?.name}
                        onChange={(id) => {
                            if (!id) setCompany(null);
                        }}
                        onResolved={(id, title) => setCompany({ id, name: title })}
                    />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                    <Field label={`Amount (${currency})`} error={errors.amount}>
                        <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
                    </Field>
                    <Field label={fieldTitle('closeDate')} error={errors.closeDate}>
                        <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
                    </Field>
                </div>
                <Field label="Stage" error={errors.stageId}>
                    <Select value={stageId} onValueChange={setStageId}>
                        <SelectTrigger aria-label="Stage">
                            <SelectValue placeholder="Choose a stage" />
                        </SelectTrigger>
                        <SelectContent>
                            {openStages.map((stage) => (
                                <SelectItem key={stage.id} value={stage.id}>
                                    {stage.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            </DialogBody>
            <DialogFooter>
                <Button type="button" variant="secondary" shape="square" onClick={onDone} disabled={create.isPending}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" shape="square" loading={create.isPending}>
                    Create deal
                </Button>
            </DialogFooter>
        </form>
    );
}
