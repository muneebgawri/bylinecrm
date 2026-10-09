import {
    OPERATORS_BY_KIND,
    STANDARD_FIELDS,
    type FieldDescriptor,
    type FilterCondition,
    type FilterGroup,
    type FilterOperator,
} from '@bylinecrm/shared';
import {
    Badge,
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
} from '@bylinecrm/ui';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import type { MemberSummaryView } from '../../../api/types';
import { chipConditions, withCondition, withoutCondition } from '../../../lib/filterParam';
import { formatMoney, parseMoneyInput } from '../../../lib/money';

/** The operators in the member's words; one table for the menu and the chips. */
export const OPERATOR_LABELS: Readonly<Record<FilterOperator, string>> = {
    eq: 'is',
    neq: 'is not',
    in: 'is any of',
    nin: 'is none of',
    contains: 'contains',
    starts: 'starts with',
    gt: 'is more than',
    gte: 'is at least',
    lt: 'is less than',
    lte: 'is at most',
    between: 'is between',
    is_null: 'is empty',
    not_null: 'is not empty',
};

const NO_VALUE: readonly FilterOperator[] = ['is_null', 'not_null'];
const LIST_VALUE: readonly FilterOperator[] = ['in', 'nin'];

export interface FilterChipsProps {
    filter: FilterGroup | null;
    onChange: (filter: FilterGroup | null) => void;
    members: readonly MemberSummaryView[];
    /** An own-scoped member's list is already theirs; the Owner condition is not offered (doc 50 §B). */
    ownerFilterAllowed: boolean;
    /** The currency a typed money amount is read in. */
    currency: string;
}

/**
 * Filter chips over a top-level `and` (FR-CRMS-UI-1): each condition is a removable chip, "+ Filter"
 * adds one through a dialog whose fields and operators come from the shared vocabulary
 * (`STANDARD_FIELDS`, `OPERATORS_BY_KIND`) — nothing about the API's grammar is restated here.
 */
export function FilterChips({ filter, onChange, members, ownerFilterAllowed, currency }: FilterChipsProps) {
    const [adding, setAdding] = useState(false);
    const conditions = chipConditions(filter);
    const fields = useMemo(
        () =>
            STANDARD_FIELDS.opportunity.filter(
                (f) => (f.kind !== 'uuid' || (f.name === 'ownerId' && ownerFilterAllowed)) && f.name !== 'position',
            ),
        [ownerFilterAllowed],
    );
    const memberName = (id: unknown) => members.find((m) => m.memberId === id)?.name ?? 'a member';

    return (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filters" role="group">
            {conditions === 'advanced' ? (
                <Chip label="Advanced filter" onRemove={() => onChange(null)} />
            ) : (
                conditions.map((condition, index) => (
                    <Chip
                        key={`${condition.field}-${condition.op}-${index}`}
                        label={describeCondition(condition, fields, currency, memberName)}
                        onRemove={() => onChange(withoutCondition(filter, index))}
                    />
                ))
            )}
            <Button variant="secondary" size="sm" shape="square" onClick={() => setAdding(true)}>
                <Plus aria-hidden /> Filter
            </Button>
            <AddFilterDialog
                open={adding}
                onOpenChange={setAdding}
                fields={fields}
                members={members}
                currency={currency}
                onAdd={(condition) => {
                    onChange(withCondition(filter, condition));
                    setAdding(false);
                }}
            />
        </div>
    );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
    return (
        <Badge status="accent" className="h-7.5 gap-1.5 pr-1 text-[13px]">
            {label}
            <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove filter: ${label}`}
                className="inline-flex size-5 items-center justify-center rounded-sm hover:bg-accent/15"
            >
                <X aria-hidden className="size-3.5" />
            </button>
        </Badge>
    );
}

/** "Amount is at least $10,000", "Owner is Kate Morgan", "Close date is empty". */
export function describeCondition(
    condition: FilterCondition,
    fields: readonly FieldDescriptor[],
    currency: string,
    memberName: (id: unknown) => string,
): string {
    const field =
        fields.find((f) => f.name === condition.field) ??
        STANDARD_FIELDS.opportunity.find((f) => f.name === condition.field);
    const label = field?.label ?? condition.field;
    const op = OPERATOR_LABELS[condition.op];
    if (NO_VALUE.includes(condition.op)) return `${label} ${op}`;
    const show = (value: unknown): string =>
        field?.kind === 'money' && typeof value === 'number'
            ? formatMoney({ amountMinor: value, currency })
            : field?.kind === 'uuid'
              ? memberName(value)
              : String(value);
    const value = Array.isArray(condition.value)
        ? condition.op === 'between'
            ? condition.value.map(show).join(' and ')
            : condition.value.map(show).join(', ')
        : show(condition.value);
    return `${label} ${op} ${value}`;
}

interface AddFilterDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    fields: readonly FieldDescriptor[];
    members: readonly MemberSummaryView[];
    currency: string;
    onAdd: (condition: FilterCondition) => void;
}

function AddFilterDialog({ open, onOpenChange, fields, members, currency, onAdd }: AddFilterDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                {open && (
                    <AddFilterForm
                        fields={fields}
                        members={members}
                        currency={currency}
                        onAdd={onAdd}
                        onCancel={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function AddFilterForm({
    fields,
    members,
    currency,
    onAdd,
    onCancel,
}: Omit<AddFilterDialogProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
    const [fieldName, setFieldName] = useState(fields[0]?.name ?? '');
    const field = fields.find((f) => f.name === fieldName);
    const operators = field ? OPERATORS_BY_KIND[field.kind] : [];
    const [op, setOp] = useState<FilterOperator>(operators[0] ?? 'eq');
    const [first, setFirst] = useState('');
    const [second, setSecond] = useState('');
    const [error, setError] = useState<string | null>(null);

    function chooseField(name: string) {
        setFieldName(name);
        const next = fields.find((f) => f.name === name);
        setOp(next ? (OPERATORS_BY_KIND[next.kind][0] ?? 'eq') : 'eq');
        setFirst('');
        setSecond('');
        setError(null);
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        if (!field) return;
        if (NO_VALUE.includes(op)) {
            onAdd({ field: field.name, op });
            return;
        }
        const parse = (text: string) => parseValue(field, text, currency);
        let value: unknown;
        if (op === 'between') {
            const pair = [parse(first), parse(second)];
            if (pair.some((v) => v === undefined)) return setError(valueHint(field));
            value = pair;
        } else if (LIST_VALUE.includes(op)) {
            const list = first
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean)
                .map(parse);
            if (list.length === 0 || list.some((v) => v === undefined))
                return setError(`${valueHint(field)} Separate values with commas.`);
            value = list;
        } else {
            value = parse(first);
            if (value === undefined) return setError(valueHint(field));
        }
        onAdd({ field: field.name, op, value });
    }

    const valueInput = (value: string, onChangeValue: (v: string) => void, label: string) =>
        field?.kind === 'uuid' ? (
            <Field label={label} error={error}>
                <Select value={value} onValueChange={onChangeValue}>
                    <SelectTrigger aria-label={label}>
                        <SelectValue placeholder="Choose a member" />
                    </SelectTrigger>
                    <SelectContent>
                        {members.map((m) => (
                            <SelectItem key={m.memberId} value={m.memberId}>
                                {m.name ?? 'Member'}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
        ) : (
            <Field label={label} error={error} hint={field?.kind === 'money' ? `In ${currency}` : undefined}>
                <Input
                    type={field?.kind === 'date' || field?.kind === 'datetime' ? 'date' : 'text'}
                    inputMode={field?.kind === 'number' || field?.kind === 'money' ? 'decimal' : undefined}
                    value={value}
                    onChange={(e) => {
                        onChangeValue(e.target.value);
                        setError(null);
                    }}
                />
            </Field>
        );

    return (
        <form onSubmit={submit} noValidate className="contents">
            <DialogTitle>Add a filter</DialogTitle>
            <DialogDescription>Deals must match every filter shown.</DialogDescription>
            <DialogBody className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-4">
                    <Field label="Field">
                        <Select value={fieldName} onValueChange={chooseField}>
                            <SelectTrigger aria-label="Field">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {fields.map((f) => (
                                    <SelectItem key={f.name} value={f.name}>
                                        {f.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field label="Condition">
                        <Select value={op} onValueChange={(v) => setOp(v as FilterOperator)}>
                            <SelectTrigger aria-label="Condition">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {operators.map((o) => (
                                    <SelectItem key={o} value={o}>
                                        {OPERATOR_LABELS[o]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                </div>
                {!NO_VALUE.includes(op) &&
                    (op === 'between' ? (
                        <div className="grid grid-cols-2 gap-4">
                            {valueInput(first, setFirst, 'From')}
                            {valueInput(second, setSecond, 'To')}
                        </div>
                    ) : (
                        valueInput(first, setFirst, LIST_VALUE.includes(op) ? 'Values' : 'Value')
                    ))}
            </DialogBody>
            <DialogFooter>
                <Button type="button" variant="secondary" shape="square" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" shape="square">
                    Add filter
                </Button>
            </DialogFooter>
        </form>
    );
}

/** A typed value as the API's grammar takes it for the field's kind; `undefined` when it cannot be read. */
export function parseValue(field: FieldDescriptor, text: string, currency: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    switch (field.kind) {
        case 'number': {
            const n = Number(trimmed.replace(/,/g, ''));
            return Number.isFinite(n) ? n : undefined;
        }
        case 'money':
            return parseMoneyInput(trimmed, currency)?.amountMinor;
        case 'date':
            return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
        case 'datetime':
            return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : undefined;
        case 'boolean':
            return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
        default:
            return trimmed;
    }
}

function valueHint(field: FieldDescriptor): string {
    switch (field.kind) {
        case 'number':
            return 'Enter a number.';
        case 'money':
            return 'Enter an amount, like 10000 or 10,000.50.';
        case 'date':
        case 'datetime':
            return 'Choose a date.';
        case 'uuid':
            return 'Choose a member.';
        default:
            return 'Enter a value.';
    }
}
