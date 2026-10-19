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
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateDeal } from '../../../api/deals';
import { useRecordList } from '../../../api/records';
import type { CompanyView, PipelineView } from '../../../api/types';
import { parseMoneyInput } from '../../../lib/money';
import { fieldTitle } from '../records/fields';

export interface NewDealDialogProps {
    workspaceId: string;
    pipeline: PipelineView | undefined;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The workspace's currency for an amount typed without one. */
    currency: string;
}

/** How long typing pauses before the company search asks the API. */
const SEARCH_DEBOUNCE_MS = 250;
/** How many companies the picker suggests. */
const COMPANY_SUGGESTIONS = 8;

/** "+ New deal": name, company (searched), amount, close date, starting stage (first open stage by default). */
export function NewDealDialog({ workspaceId, pipeline, open, onOpenChange, currency }: NewDealDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                {open && pipeline && (
                    <NewDealForm
                        workspaceId={workspaceId}
                        pipeline={pipeline}
                        currency={currency}
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
    onDone,
}: {
    workspaceId: string;
    pipeline: PipelineView;
    currency: string;
    onDone: () => void;
}) {
    const openStages = useMemo(() => pipeline.stages.filter((s) => s.kind === 'open'), [pipeline.stages]);
    const [name, setName] = useState('');
    const [stageId, setStageId] = useState(openStages[0]?.id ?? '');
    const [amountText, setAmountText] = useState('');
    const [closeDate, setCloseDate] = useState('');
    const [companyText, setCompanyText] = useState('');
    const [company, setCompany] = useState<CompanyView | null>(null);
    const [debounced, setDebounced] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const create = useCreateDeal(workspaceId);
    const search = useRecordList(
        workspaceId,
        'company',
        { q: debounced, limit: COMPANY_SUGGESTIONS },
        debounced.length > 0,
    );

    useEffect(() => {
        const handle = setTimeout(() => setDebounced(company ? '' : companyText.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [companyText, company]);

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

    const suggestions = company ? [] : (search.data?.items ?? []);

    return (
        <form onSubmit={submit} noValidate className="contents">
            <DialogTitle>New deal</DialogTitle>
            <DialogDescription>It starts in {pipeline.name}, in the stage you choose.</DialogDescription>
            <DialogBody className="flex flex-col gap-4">
                <Field label="Name" required error={errors.name}>
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field
                    label="Company"
                    required
                    error={errors.companyId}
                    hint={company ? `Linked to ${company.name}` : 'Type to search by name or domain'}
                >
                    <Input
                        value={company ? company.name : companyText}
                        onChange={(e) => {
                            setCompany(null);
                            setCompanyText(e.target.value);
                        }}
                        role="combobox"
                        aria-expanded={suggestions.length > 0}
                        aria-autocomplete="list"
                        aria-controls="new-deal-company-options"
                    />
                </Field>
                {suggestions.length > 0 && (
                    <ul
                        id="new-deal-company-options"
                        role="listbox"
                        aria-label="Companies"
                        className="-mt-3 max-h-40 overflow-auto rounded-md border border-border bg-surface-raised py-1 text-sm"
                    >
                        {suggestions.map((c) => (
                            <li key={c.id} role="option" aria-selected={false}>
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-surface"
                                    onClick={() => setCompany(c)}
                                >
                                    <span>{c.name}</span>
                                    {c.domain && <span className="text-xs text-text-faint">{c.domain}</span>}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
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
