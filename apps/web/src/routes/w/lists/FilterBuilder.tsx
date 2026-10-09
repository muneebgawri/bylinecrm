import { DEFAULT_CURRENCY, type FieldDescriptor, type FilterOperator } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
    cn,
    Input,
    SegmentedControl,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@bylinecrm/ui';
import { FolderPlus, Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { RecordPicker } from '../../../components/RecordPicker';
import {
    canNest,
    emptyGroup,
    formatScalar,
    isDraftGroup,
    newCondition,
    operatorLabel,
    operatorsFor,
    parseScalar,
    valueShape,
    type DraftCondition,
    type DraftGroup,
    type DraftNode,
} from '../../../lib/filterModel';
import { minorDigits, toMajor, toMinor } from '../../../lib/money';

export interface FilterBuilderProps {
    workspaceId: string;
    fields: readonly FieldDescriptor[];
    value: DraftGroup;
    onChange: (next: DraftGroup) => void;
    /** Member id → name, for an owner condition's choices. */
    members: ReadonlyMap<string, string>;
}

/**
 * The filter editor (FR-CRMS-UI-1): groups of "all of" / "any of" over conditions, nested up to
 * the grammar's depth. Controlled — the panel around it owns the draft and decides when it is
 * applied. Its own chunk: only a person who opens the filter pays for it.
 */
export default function FilterBuilder({ workspaceId, fields, value, onChange, members }: FilterBuilderProps) {
    return (
        <GroupEditor
            group={value}
            depth={1}
            fields={fields}
            workspaceId={workspaceId}
            members={members}
            onChange={onChange}
            onRemove={undefined}
        />
    );
}

interface GroupEditorProps {
    group: DraftGroup;
    depth: number;
    fields: readonly FieldDescriptor[];
    workspaceId: string;
    members: ReadonlyMap<string, string>;
    onChange: (next: DraftGroup) => void;
    /** Absent for the top-level group, which cannot be removed. */
    onRemove: (() => void) | undefined;
}

function GroupEditor({ group, depth, fields, workspaceId, members, onChange, onRemove }: GroupEditorProps) {
    const first = fields[0];
    const replace = (index: number, node: DraftNode | null) =>
        onChange({
            ...group,
            children:
                node === null
                    ? group.children.filter((_, i) => i !== index)
                    : group.children.map((c, i) => (i === index ? node : c)),
        });

    return (
        <div
            className={cn(
                'flex flex-col gap-2.5',
                depth > 1 && 'rounded-md border border-border bg-surface-raised p-2.5',
            )}
        >
            <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                    aria-label="Match"
                    value={group.connective}
                    onValueChange={(connective) => onChange({ ...group, connective })}
                    options={[
                        { value: 'and', label: 'Match all' },
                        { value: 'or', label: 'Match any' },
                    ]}
                />
                {onRemove && (
                    <Button size="xs" shape="square" variant="ghost" className="ml-auto" onClick={onRemove}>
                        <X aria-hidden /> Remove group
                    </Button>
                )}
            </div>
            {group.children.length === 0 && (
                <p className="m-0 text-[13px] text-text-muted">No conditions yet — add one below.</p>
            )}
            {group.children.map((child, index) =>
                isDraftGroup(child) ? (
                    <GroupEditor
                        key={child.id}
                        group={child}
                        depth={depth + 1}
                        fields={fields}
                        workspaceId={workspaceId}
                        members={members}
                        onChange={(next) => replace(index, next)}
                        onRemove={() => replace(index, null)}
                    />
                ) : (
                    <ConditionRow
                        key={child.id}
                        condition={child}
                        fields={fields}
                        workspaceId={workspaceId}
                        members={members}
                        onChange={(next) => replace(index, next)}
                        onRemove={() => replace(index, null)}
                    />
                ),
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    size="sm"
                    shape="square"
                    disabled={!first}
                    onClick={() => first && onChange({ ...group, children: [...group.children, newCondition(first)] })}
                >
                    <Plus aria-hidden /> Add condition
                </Button>
                {canNest(depth) && (
                    <Button
                        size="sm"
                        shape="square"
                        variant="ghost"
                        onClick={() =>
                            onChange({
                                ...group,
                                children: [...group.children, emptyGroup(group.connective === 'and' ? 'or' : 'and')],
                            })
                        }
                    >
                        <FolderPlus aria-hidden /> Add group
                    </Button>
                )}
            </div>
        </div>
    );
}

interface ConditionRowProps {
    condition: DraftCondition;
    fields: readonly FieldDescriptor[];
    workspaceId: string;
    members: ReadonlyMap<string, string>;
    onChange: (next: DraftCondition) => void;
    onRemove: () => void;
}

function ConditionRow({ condition, fields, workspaceId, members, onChange, onRemove }: ConditionRowProps) {
    const field = fields.find((f) => f.name === condition.field) ?? fields[0];
    const fieldId = useId();
    const opId = useId();
    if (!field) return null;
    const ops = operatorsFor(field);

    const changeField = (name: string) => {
        const next = fields.find((f) => f.name === name);
        if (next) onChange({ ...newCondition(next), id: condition.id });
    };
    const changeOp = (op: FilterOperator) => {
        // A value survives an operator change only when its shape still fits.
        const keep = valueShape(op) === valueShape(condition.op);
        onChange({ id: condition.id, field: condition.field, op, ...(keep ? { value: condition.value } : {}) });
    };

    return (
        <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-surface p-2 md:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)_auto] md:items-start md:border-0 md:p-0">
            <Select value={field.name} onValueChange={changeField}>
                <SelectTrigger id={fieldId} aria-label="Field">
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
            <Select value={condition.op} onValueChange={(op) => changeOp(op as FilterOperator)}>
                <SelectTrigger id={opId} aria-label="Condition">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {ops.map((op) => (
                        <SelectItem key={op} value={op}>
                            {operatorLabel(field.kind, op)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <ValueEditor
                key={`${field.name}:${condition.op}`}
                field={field}
                condition={condition}
                workspaceId={workspaceId}
                members={members}
                onValue={(value) => onChange({ ...condition, value })}
            />
            <Button size="icon" shape="square" variant="ghost" aria-label="Remove condition" onClick={onRemove}>
                <X aria-hidden />
            </Button>
        </div>
    );
}

interface ValueEditorProps {
    field: FieldDescriptor;
    condition: DraftCondition;
    workspaceId: string;
    members: ReadonlyMap<string, string>;
    onValue: (value: unknown) => void;
}

/** The value input a condition needs: by the field's kind and the operator's shape. */
function ValueEditor({ field, condition, workspaceId, members, onValue }: ValueEditorProps) {
    const shape = valueShape(condition.op);
    if (shape === 'none') return <span aria-hidden className="hidden md:block" />;
    const label = field.label;

    // Choices from a fixed set: options, yes/no, members.
    const choices = choicesFor(field, members);
    if (choices) {
        if (shape === 'list') {
            const chosen = new Set(Array.isArray(condition.value) ? (condition.value as unknown[]).map(String) : []);
            return (
                <fieldset className="m-0 flex flex-wrap gap-x-3 gap-y-1.5 border-0 p-0">
                    <legend className="sr-only">{label}</legend>
                    {choices.map((choice) => (
                        <label key={choice.value} className="flex min-h-9 items-center gap-1.5 text-sm max-md:min-h-11">
                            <Checkbox
                                checked={chosen.has(choice.value)}
                                onCheckedChange={(on) => {
                                    const next = new Set(chosen);
                                    if (on) next.add(choice.value);
                                    else next.delete(choice.value);
                                    onValue([...next].map((v) => typedChoice(field, v)));
                                }}
                            />
                            {choice.label}
                        </label>
                    ))}
                </fieldset>
            );
        }
        return (
            <Select
                {...(condition.value === undefined ? {} : { value: String(condition.value) })}
                onValueChange={(v) => onValue(typedChoice(field, v))}
            >
                <SelectTrigger aria-label={label}>
                    <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                    {choices.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        );
    }

    // A reference to a company or a person: chosen by search, never typed as an id.
    const object = field.name === 'companyId' ? 'company' : field.name === 'pointOfContactId' ? 'person' : null;
    if (field.kind === 'uuid' && object) {
        return (
            <ReferenceEditor
                workspaceId={workspaceId}
                object={object}
                label={label}
                shape={shape}
                value={condition.value}
                onValue={onValue}
            />
        );
    }

    if (field.kind === 'money')
        return <MoneyEditor label={label} shape={shape} value={condition.value} onValue={onValue} />;

    const type =
        field.kind === 'number'
            ? 'number'
            : field.kind === 'date'
              ? 'date'
              : field.kind === 'datetime'
                ? 'datetime-local'
                : 'text';
    if (shape === 'pair') {
        const pair = Array.isArray(condition.value) ? (condition.value as unknown[]) : [];
        const set = (i: 0 | 1, raw: string) => {
            const next = [pair[0], pair[1]];
            next[i] = parseScalar(field.kind, raw);
            onValue(next);
        };
        return (
            <div className="flex items-center gap-2">
                <Input
                    type={type}
                    aria-label={`${label} from`}
                    defaultValue={formatScalar(field.kind, pair[0])}
                    onChange={(e) => set(0, e.target.value)}
                />
                <span className="text-text-muted">and</span>
                <Input
                    type={type}
                    aria-label={`${label} to`}
                    defaultValue={formatScalar(field.kind, pair[1])}
                    onChange={(e) => set(1, e.target.value)}
                />
            </div>
        );
    }
    if (shape === 'list') {
        const list = Array.isArray(condition.value) ? (condition.value as unknown[]) : [];
        return (
            <Input
                aria-label={`${label}, separated by commas`}
                placeholder="One, another, a third"
                defaultValue={list.map((v) => formatScalar(field.kind, v)).join(', ')}
                onChange={(e) =>
                    onValue(
                        e.target.value
                            .split(',')
                            .map((part) => parseScalar(field.kind, part))
                            .filter((v) => v !== undefined),
                    )
                }
            />
        );
    }
    return (
        <Input
            type={type}
            aria-label={label}
            defaultValue={formatScalar(field.kind, condition.value)}
            onChange={(e) => onValue(parseScalar(field.kind, e.target.value))}
        />
    );
}

interface Choice {
    value: string;
    label: string;
}

/** The fixed choices of a field, or `null` when its value is typed or searched for. */
function choicesFor(field: FieldDescriptor, members: ReadonlyMap<string, string>): Choice[] | null {
    if (field.options) return field.options.map((o) => ({ value: o, label: o }));
    if (field.kind === 'boolean') {
        return [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
        ];
    }
    if (field.name === 'ownerId') return [...members].map(([id, name]) => ({ value: id, label: name }));
    return null;
}

function typedChoice(field: FieldDescriptor, value: string): unknown {
    return field.kind === 'boolean' ? value === 'true' : value;
}

/** Amounts are typed in a currency's major units and sent as minor units, the API's form. */
function MoneyEditor({
    label,
    shape,
    value,
    onValue,
}: {
    label: string;
    shape: 'one' | 'list' | 'pair';
    value: unknown;
    onValue: (value: unknown) => void;
}) {
    const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
    const toInput = (minor: unknown) =>
        typeof minor === 'number' ? String(toMajor({ amountMinor: minor, currency })) : '';
    const fromInput = (raw: string) => {
        const major = Number(raw);
        return raw.trim() !== '' && Number.isFinite(major) ? toMinor(major, currency) : undefined;
    };
    const step = 1 / 10 ** minorDigits(currency);
    const currencyInput = (
        <Input
            aria-label="Currency"
            className="w-20 uppercase"
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase() || DEFAULT_CURRENCY)}
        />
    );
    if (shape === 'pair') {
        const pair = Array.isArray(value) ? (value as unknown[]) : [];
        const set = (i: 0 | 1, raw: string) => {
            const next = [pair[0], pair[1]];
            next[i] = fromInput(raw);
            onValue(next);
        };
        return (
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    type="number"
                    step={step}
                    aria-label={`${label} from`}
                    defaultValue={toInput(pair[0])}
                    onChange={(e) => set(0, e.target.value)}
                    className="w-28"
                />
                <span className="text-text-muted">and</span>
                <Input
                    type="number"
                    step={step}
                    aria-label={`${label} to`}
                    defaultValue={toInput(pair[1])}
                    onChange={(e) => set(1, e.target.value)}
                    className="w-28"
                />
                {currencyInput}
            </div>
        );
    }
    if (shape === 'list') {
        const list = Array.isArray(value) ? (value as unknown[]) : [];
        return (
            <div className="flex items-center gap-2">
                <Input
                    aria-label={`${label}, separated by commas`}
                    defaultValue={list.map(toInput).join(', ')}
                    onChange={(e) =>
                        onValue(
                            e.target.value
                                .split(',')
                                .map(fromInput)
                                .filter((v) => v !== undefined),
                        )
                    }
                />
                {currencyInput}
            </div>
        );
    }
    return (
        <div className="flex items-center gap-2">
            <Input
                type="number"
                step={step}
                aria-label={label}
                defaultValue={toInput(value)}
                onChange={(e) => onValue(fromInput(e.target.value))}
            />
            {currencyInput}
        </div>
    );
}

/** One or several companies / people, each found by search. */
function ReferenceEditor({
    workspaceId,
    object,
    label,
    shape,
    value,
    onValue,
}: {
    workspaceId: string;
    object: 'company' | 'person';
    label: string;
    shape: 'one' | 'list' | 'pair';
    value: unknown;
    onValue: (value: unknown) => void;
}) {
    const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
    if (shape === 'list') {
        const ids = Array.isArray(value) ? (value as string[]) : [];
        return (
            <div className="flex flex-col gap-1.5">
                {ids.length > 0 && (
                    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                        {ids.map((id) => (
                            <li key={id}>
                                <Badge>
                                    {labels.get(id) ?? 'Chosen'}
                                    <button
                                        type="button"
                                        aria-label={`Remove ${labels.get(id) ?? 'this one'}`}
                                        className="grid place-items-center rounded-sm max-md:size-11"
                                        onClick={() => onValue(ids.filter((v) => v !== id))}
                                    >
                                        <X aria-hidden className="size-3" />
                                    </button>
                                </Badge>
                            </li>
                        ))}
                    </ul>
                )}
                <RecordPicker
                    workspaceId={workspaceId}
                    object={object}
                    label={`Add ${label.toLowerCase()}`}
                    value={null}
                    clearLabel={`Add ${label.toLowerCase()}…`}
                    onChange={(id) => {
                        if (id && !ids.includes(id)) onValue([...ids, id]);
                    }}
                    onResolved={(id, name) => setLabels((m) => new Map(m).set(id, name))}
                />
            </div>
        );
    }
    const id = typeof value === 'string' ? value : null;
    return (
        <RecordPicker
            workspaceId={workspaceId}
            object={object}
            label={label}
            value={id}
            valueLabel={id ? labels.get(id) : undefined}
            onChange={(next) => onValue(next ?? undefined)}
            onResolved={(rid, name) => setLabels((m) => new Map(m).set(rid, name))}
        />
    );
}
