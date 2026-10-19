import { CUSTOM_FIELD_TYPES, type CustomFieldType, type RecordObject } from '@bylinecrm/shared';
import {
    Badge,
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
    cn,
    focusRing,
    toast,
} from '@bylinecrm/ui';
import { ArrowDown, ArrowUp, ChevronRight, X } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useCustomFields } from '../../../api/records';
import {
    useArchiveCustomField,
    useArchivedCustomFields,
    useCreateCustomField,
    useRestoreCustomField,
    useUpdateCustomField,
} from '../../../api/settings';
import type { CustomFieldView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { useWorkspaceId } from '../../params';
import { SelectField, SwitchRow } from './fields';
import { FIELD_KEY_PATTERN, fieldKeyFromLabel } from './settingsText';
import { formatDate } from './SettingsLayout';

/** The record kinds a field can belong to, as the tabs name them. */
const OBJECTS: readonly { id: RecordObject; label: string; template: string }[] = [
    { id: 'person', label: 'Person', template: 'person' },
    { id: 'company', label: 'Company', template: 'company' },
    { id: 'opportunity', label: 'Deal', template: 'deal' },
];

const TYPE_LABEL: Record<CustomFieldType, string> = {
    text: 'Text',
    number: 'Number',
    boolean: 'Yes / no',
    date: 'Date',
    datetime: 'Date and time',
    select: 'Select',
    multiselect: 'Multi-select',
    url: 'Link',
    email: 'Email',
    phone: 'Phone',
};
const TYPE_OPTIONS = CUSTOM_FIELD_TYPES.map((type) => ({ value: type, label: TYPE_LABEL[type] }));
const hasOptions = (type: CustomFieldType) => type === 'select' || type === 'multiselect';

/** "Select · 2 options", "Text" — the type as the list shows it. */
function typeSummary(field: CustomFieldView): string {
    if (!hasOptions(field.type)) return TYPE_LABEL[field.type];
    const n = field.options.length;
    return `${TYPE_LABEL[field.type]} · ${n} ${n === 1 ? 'option' : 'options'}`;
}

/**
 * The fields records carry beyond the standard ones (doc 48 §5): per record kind, defined here,
 * filled in on the record, filterable in lists and usable in templates. A field is archived, never
 * deleted — records keep their values. Writes need `workspace:admin` (FR-CRMS-UI-6).
 */
export function CustomFields() {
    const workspaceId = useWorkspaceId();
    const canEdit = useCan('workspace:admin');
    const [object, setObject] = useState<RecordObject>('person');
    const fields = useCustomFields(workspaceId, object);
    const archive = useArchiveCustomField(workspaceId);
    const [editing, setEditing] = useState<CustomFieldView | 'new' | null>(null);
    const [archiving, setArchiving] = useState<CustomFieldView | null>(null);
    if (fields.isError) throw fields.error;
    const rows = [...(fields.data ?? [])].sort((a, b) => a.position - b.position);
    const current = OBJECTS.find((o) => o.id === object) ?? OBJECTS[0]!;

    return (
        <div className="grid gap-4">
            <DataTableChrome
                tabs={OBJECTS.map((o) => ({ id: o.id, label: o.label }))}
                activeTab={object}
                onTabChange={(id) => setObject(id)}
                {...(canEdit && {
                    toolbar: {
                        extra: (
                            <Button
                                data-primary-action
                                data-primary-dialog
                                variant="primary"
                                shape="square"
                                size="sm"
                                onClick={() => setEditing('new')}
                            >
                                New field
                            </Button>
                        ),
                    },
                })}
                data={{
                    label: `${current.label} fields`,
                    loading: fields.isPending,
                    rows,
                    getRowId: (f) => f.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title={`No ${current.label.toLowerCase()} fields yet`}
                            body="Add a field for anything your team tracks that isn't built in — a beat, an outlet, a renewal date."
                        />
                    ),
                    columns: [
                        {
                            id: 'label',
                            header: 'Field',
                            cell: (f) => (
                                <span className="grid gap-0.5">
                                    <span className="font-medium">{f.label}</span>
                                    <code className="text-xs text-text-faint">
                                        {current.template}.custom.{f.key}
                                    </code>
                                </span>
                            ),
                        },
                        { id: 'type', header: 'Type', muted: true, cell: typeSummary },
                        {
                            id: 'required',
                            header: 'Required',
                            phone: 'meta',
                            cell: (f) => (f.required ? <Badge shape="pill">Required</Badge> : null),
                        },
                        {
                            id: 'adminOnly',
                            header: 'Visibility',
                            phone: 'meta',
                            cell: (f) => (f.adminOnly ? <Badge shape="pill">Admins only</Badge> : null),
                        },
                    ],
                    ...(canEdit && {
                        rowActions: {
                            label: (f: CustomFieldView) => f.label,
                            items: (f: CustomFieldView) => (
                                <>
                                    <DropdownMenuItem onSelect={() => setEditing(f)}>Edit</DropdownMenuItem>
                                    <DropdownMenuItem destructive onSelect={() => setArchiving(f)}>
                                        Archive
                                    </DropdownMenuItem>
                                </>
                            ),
                        },
                    }),
                }}
            />
            <ArchivedFields workspaceId={workspaceId} object={object} canRestore={canEdit} />
            {editing !== null && (
                <CustomFieldEditor
                    workspaceId={workspaceId}
                    object={object}
                    template={current.template}
                    field={editing === 'new' ? null : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            <ConfirmDialog
                open={archiving !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setArchiving(null);
                        archive.reset();
                    }
                }}
                title={`Archive ${archiving?.label ?? 'field'}?`}
                body="Records keep their values; the field leaves forms, filters and templates until it is restored from Archived fields."
                confirm="Archive field"
                pending={archive.isPending}
                error={archive.error ? failureText(archive.error) : undefined}
                onConfirm={() => archiving && archive.mutate(archiving.id, { onSuccess: () => setArchiving(null) })}
            />
        </div>
    );
}

/**
 * The archived fields of one record kind, collapsed by default. An admin restores one from its row
 * (the key stayed reserved while archived, so a restore cannot collide); others read only.
 */
function ArchivedFields({
    workspaceId,
    object,
    canRestore,
}: {
    workspaceId: string;
    object: RecordObject;
    canRestore: boolean;
}) {
    const [open, setOpen] = useState(false);
    const archived = useArchivedCustomFields(workspaceId, object);
    const restore = useRestoreCustomField(workspaceId);
    const rows = archived.data ?? [];
    if (archived.isPending || rows.length === 0) return null;
    return (
        <section className="rounded-lg border border-border bg-surface">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    'flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-muted hover:text-text max-md:min-h-touch',
                    focusRing,
                )}
            >
                <ChevronRight aria-hidden className={cn('size-4 transition-transform', open && 'rotate-90')} />
                Archived fields ({rows.length})
            </button>
            {open && (
                <>
                    <ul aria-label="Archived fields" className="m-0 list-none border-t border-border p-0">
                        {rows.map((f) => (
                            <li
                                key={f.id}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-b-0"
                            >
                                <span className="min-w-0 flex-1 text-sm">{f.label}</span>
                                <span className="text-xs text-text-muted">
                                    {typeSummary(f)}
                                    {f.archivedAt && ` · archived ${formatDate(f.archivedAt)}`}
                                </span>
                                {canRestore && (
                                    <Button
                                        shape="square"
                                        size="sm"
                                        aria-label={`Restore ${f.label}`}
                                        loading={restore.isPending && restore.variables === f.id}
                                        onClick={() =>
                                            restore.mutate(f.id, {
                                                onSuccess: () => toast({ title: `${f.label} restored` }),
                                            })
                                        }
                                    >
                                        Restore
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                    {restore.error && (
                        <p role="alert" className="m-0 border-t border-border px-4 py-2 text-sm text-danger">
                            {failureText(restore.error)}
                        </p>
                    )}
                </>
            )}
        </section>
    );
}

/**
 * Create or edit a field. On create the key follows the label until someone edits it, and the key
 * and type are fixed once the field exists — records and templates refer to them. Options for a
 * select are added with Enter and ordered with the arrows.
 */
function CustomFieldEditor({
    workspaceId,
    object,
    template,
    field,
    onClose,
}: {
    workspaceId: string;
    object: RecordObject;
    template: string;
    field: CustomFieldView | null;
    onClose: () => void;
}) {
    const create = useCreateCustomField(workspaceId);
    const update = useUpdateCustomField(workspaceId);
    const [label, setLabel] = useState(field?.label ?? '');
    const [key, setKey] = useState(field?.key ?? '');
    const [keyEdited, setKeyEdited] = useState(false);
    const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
    const [options, setOptions] = useState<string[]>(field?.options ?? []);
    const [draftOption, setDraftOption] = useState('');
    const [required, setRequired] = useState(field?.required ?? false);
    const [adminOnly, setAdminOnly] = useState(field?.adminOnly ?? false);
    const mutation = field ? update : create;

    const shownKey = field ? field.key : keyEdited ? key : fieldKeyFromLabel(label);
    const keyError =
        !field && shownKey && !FIELD_KEY_PATTERN.test(shownKey)
            ? 'Starts with a letter; lower-case letters, digits and _ only.'
            : undefined;
    const needsOptions = hasOptions(type);
    const valid = label.trim() !== '' && shownKey !== '' && !keyError && (!needsOptions || options.length > 0);

    const addOption = () => {
        const value = draftOption.trim();
        if (value && !options.includes(value)) setOptions([...options, value]);
        setDraftOption('');
    };
    const onOptionKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addOption();
        }
    };
    const moveOption = (from: number, to: number) => {
        if (to < 0 || to >= options.length) return;
        const next = [...options];
        const [item] = next.splice(from, 1);
        if (item !== undefined) next.splice(to, 0, item);
        setOptions(next);
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!valid) return;
        const shared = { label: label.trim(), ...(needsOptions && { options }), required, adminOnly };
        if (field) update.mutate({ fieldId: field.id, ...shared }, { onSuccess: onClose });
        else create.mutate({ object, key: shownKey, type, ...shared }, { onSuccess: onClose });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>{field ? `Edit ${field.label}` : 'New field'}</DialogTitle>
                <DialogDescription>
                    {field
                        ? `In templates: ${template}.custom.${field.key}. Its key and type are fixed.`
                        : 'Appears on every record of this kind, in list filters, and in templates.'}
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="grid gap-4">
                        <Field label="Label" required error={mutation.error ? failureText(mutation.error) : undefined}>
                            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoFocus />
                        </Field>
                        {!field && (
                            <>
                                <Field
                                    label="Key"
                                    required
                                    hint={`In templates: ${template}.custom.${shownKey || '…'}. It can't change later.`}
                                    error={keyError}
                                >
                                    <Input
                                        value={shownKey}
                                        maxLength={64}
                                        onChange={(e) => {
                                            setKeyEdited(true);
                                            setKey(e.target.value);
                                        }}
                                    />
                                </Field>
                                <SelectField label="Type" value={type} onValueChange={setType} options={TYPE_OPTIONS} />
                            </>
                        )}
                        {needsOptions && (
                            <fieldset className="m-0 grid gap-2 border-0 p-0">
                                <legend className="mb-1 p-0 text-[13px] font-medium">Options</legend>
                                {options.length > 0 && (
                                    <ol aria-label="Options" className="m-0 grid list-none gap-1 p-0">
                                        {options.map((option, i) => (
                                            <li
                                                key={option}
                                                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
                                            >
                                                <span className="flex-1 truncate px-1">{option}</span>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    shape="square"
                                                    aria-label={`Move ${option} up`}
                                                    disabled={i === 0}
                                                    onClick={() => moveOption(i, i - 1)}
                                                >
                                                    <ArrowUp aria-hidden />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    shape="square"
                                                    aria-label={`Move ${option} down`}
                                                    disabled={i === options.length - 1}
                                                    onClick={() => moveOption(i, i + 1)}
                                                >
                                                    <ArrowDown aria-hidden />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    shape="square"
                                                    aria-label={`Remove ${option}`}
                                                    onClick={() => setOptions(options.filter((o) => o !== option))}
                                                >
                                                    <X aria-hidden />
                                                </Button>
                                            </li>
                                        ))}
                                    </ol>
                                )}
                                <div className="flex gap-2">
                                    <Input
                                        aria-label="New option"
                                        placeholder="Add an option and press Enter"
                                        value={draftOption}
                                        maxLength={120}
                                        onChange={(e) => setDraftOption(e.target.value)}
                                        onKeyDown={onOptionKey}
                                    />
                                    <Button
                                        type="button"
                                        shape="square"
                                        onClick={addOption}
                                        disabled={!draftOption.trim()}
                                    >
                                        Add
                                    </Button>
                                </div>
                            </fieldset>
                        )}
                        <SwitchRow
                            label="Required"
                            hint="A record can't be saved without it."
                            checked={required}
                            onCheckedChange={setRequired}
                        />
                        <SwitchRow
                            label="Admins only"
                            hint="Members don't see or edit it — on records, in lists, filters and exports."
                            checked={adminOnly}
                            onCheckedChange={setAdminOnly}
                        />
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={mutation.isPending}
                            disabled={!valid}
                        >
                            {field ? 'Save field' : 'Create field'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
