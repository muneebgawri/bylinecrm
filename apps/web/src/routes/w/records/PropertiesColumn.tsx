import { Info } from 'lucide-react';
import type { CustomFieldType, RecordObject } from '@bylinecrm/shared';
import { Skeleton } from '@bylinecrm/ui';
import type { ReactNode } from 'react';
import { useCustomFields } from '../../../api/records';
import type { CustomFieldView } from '../../../api/types';
import { formatDate } from '../../../lib/format';
import { fieldTitle } from './fields';
import { InlineSelect, InlineText } from './InlineEdit';

/** A patch of one field, as the page's `usePatchRecord` sends it. */
export type SaveField = (patch: Record<string, unknown>) => Promise<unknown>;

export interface PropertyRow {
    /** The API field; also the label's source and the field-error path. */
    field: string;
    control: ReactNode;
}

/**
 * PNW-766: the record's NewswireOS client, read-only (a won-deal push writes it); no row until it has one. Plain
 * text: NewswireOS has no client page to link to.
 */
export function newswireosClientRow(customerId: string | null): PropertyRow[] {
    return customerId
        ? [
              {
                  field: 'newswireosCustomerId',
                  control: <span className="block px-1 pt-1.5 text-[13px] break-all">{customerId}</span>,
              },
          ]
        : [];
}

/** The left column: a heading, then label/value rows; custom fields follow the standard ones. */
export function PropertiesColumn({
    workspaceId,
    object,
    custom,
    standard,
    audit,
    onSave,
    canEdit,
    reason,
}: {
    workspaceId: string;
    object: RecordObject;
    /** The record's `custom` values. */
    custom: Record<string, unknown>;
    /** The standard fields' rows, built by the record page (it knows the shape). */
    standard: readonly PropertyRow[];
    /** `createdAt`, `updatedAt`, who created it. */
    audit: { createdAt: string; updatedAt: string; createdBy: string };
    onSave: SaveField;
    canEdit: boolean;
    reason: string;
}) {
    const definitions = useCustomFields(workspaceId, object);
    return (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
            <h3 className="m-0 flex items-center gap-2 border-b border-border px-4 py-3.5 text-sm font-semibold">
                <Info aria-hidden className="size-4 text-text-muted" />
                Information
                {canEdit && <span className="ml-auto text-xs font-normal text-text-faint">click to edit</span>}
            </h3>
            <dl className="m-0 py-1.5">
                {standard.map((row) => (
                    <Row key={row.field} label={fieldTitle(row.field)}>
                        {row.control}
                    </Row>
                ))}
            </dl>
            <SectionLabel>Custom fields</SectionLabel>
            {/* A <dl> holds only term/definition groups; the loading, error and empty states sit outside it. */}
            {definitions.isPending ? (
                <div className="px-4 py-2">
                    <Skeleton className="h-6 w-2/3" />
                </div>
            ) : definitions.isError ? (
                <p className="m-0 px-4 py-2 text-xs text-text-faint">Custom fields could not be loaded.</p>
            ) : definitions.data.length === 0 ? (
                <p className="m-0 px-4 py-2 text-xs text-text-faint">
                    None defined for{' '}
                    {object === 'opportunity' ? 'deals' : `${object === 'person' ? 'people' : 'companies'}`} yet.
                </p>
            ) : (
                <dl className="m-0 py-1.5">
                    {definitions.data
                        .filter((d) => !d.archivedAt)
                        .map((definition) => (
                            <Row key={definition.id} label={definition.label}>
                                <CustomFieldControl
                                    definition={definition}
                                    value={custom[definition.key]}
                                    canEdit={canEdit}
                                    reason={reason}
                                    onSave={(v) => onSave({ custom: { [definition.key]: v } })}
                                />
                            </Row>
                        ))}
                </dl>
            )}
            <SectionLabel>Record</SectionLabel>
            <dl className="m-0 py-1.5 pb-2.5">
                <Row label="Created">
                    <span className="block px-1 text-[13px]">
                        {formatDate(audit.createdAt)} · {audit.createdBy}
                    </span>
                </Row>
                <Row label="Updated">
                    <span className="block px-1 text-[13px]">{formatDate(audit.updatedAt)}</span>
                </Row>
            </dl>
        </div>
    );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="px-4 py-2">
            <dt className="text-xs font-medium text-text-muted">{label}</dt>
            <dd className="m-0 -ml-1 min-w-0">{children}</dd>
        </div>
    );
}

export function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <p className="m-0 border-t border-border px-4 pt-3 pb-0.5 text-[11px] font-semibold tracking-wide text-text-faint uppercase">
            {children}
        </p>
    );
}

const TEXT_TYPES: Partial<Record<CustomFieldType, 'text' | 'email' | 'url' | 'number' | 'date' | 'tel'>> = {
    text: 'text',
    number: 'number',
    date: 'date',
    datetime: 'text',
    url: 'url',
    email: 'email',
    phone: 'tel',
};

/** A custom field's control from its definition's type: select → InlineSelect, boolean → yes/no, else text. */
function CustomFieldControl({
    definition,
    value,
    canEdit,
    reason,
    onSave,
}: {
    definition: CustomFieldView;
    value: unknown;
    canEdit: boolean;
    reason: string;
    onSave: (value: unknown) => Promise<unknown>;
}) {
    const path = `custom.${definition.key}`;
    if (definition.type === 'select') {
        return (
            <InlineSelect
                label={definition.label}
                path={path}
                value={typeof value === 'string' ? value : null}
                options={definition.options.map((o) => ({ value: o, label: o }))}
                clearLabel={definition.required ? undefined : '—'}
                canEdit={canEdit}
                reason={reason}
                onSave={onSave}
            />
        );
    }
    if (definition.type === 'boolean') {
        return (
            <InlineSelect
                label={definition.label}
                path={path}
                value={value === true ? 'true' : value === false ? 'false' : null}
                options={[
                    { value: 'true', label: 'Yes' },
                    { value: 'false', label: 'No' },
                ]}
                clearLabel={definition.required ? undefined : '—'}
                canEdit={canEdit}
                reason={reason}
                onSave={(v) => onSave(v === null ? null : v === 'true')}
            />
        );
    }
    if (definition.type === 'multiselect') {
        const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
        return (
            <InlineText
                label={definition.label}
                path={path}
                value={list.length ? list.join(', ') : null}
                placeholder={definition.options.join(', ')}
                canEdit={canEdit}
                reason={reason}
                onSave={(v) =>
                    onSave(
                        v === null
                            ? null
                            : v
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                    )
                }
            />
        );
    }
    return (
        <InlineText
            label={definition.label}
            path={path}
            type={TEXT_TYPES[definition.type] ?? 'text'}
            value={value === null || value === undefined ? null : String(value)}
            canEdit={canEdit}
            reason={reason}
            onSave={(v) => onSave(v === null ? null : definition.type === 'number' ? Number(v) : v)}
        />
    );
}

export { OwnerControl } from './OwnerControl';
