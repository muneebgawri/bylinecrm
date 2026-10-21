import {
    CONTACT_STATUS_LABELS,
    customFieldKey,
    LOST_REASON_LABELS,
    STANDARD_FIELDS,
    type RecordObject,
    type ViewColumn,
} from '@bylinecrm/shared';
import { Badge } from '@bylinecrm/ui';
import type { ReactNode } from 'react';
import type {
    CompanyView,
    CustomFieldView,
    MemberSummaryView,
    OpportunityView,
    PersonView,
    RecordSummaryView,
} from '../../../api/types';
import { formatDate, formatDay, formatRelative } from '../../../lib/format';
import { formatMoney } from '../../../lib/money';

/** The two record objects that have a list page here; deals have the board and its list (P1-UI-4). */
export type ListObject = 'person' | 'company';
/** A row of any record object's list — the column catalogue covers all three (P1-UI-6). */
export type ListRow<O extends RecordObject> = O extends 'person'
    ? PersonView
    : O extends 'company'
      ? CompanyView
      : OpportunityView;

/**
 * One column of a list. `field` is the name the API knows — what a saved view stores, what the
 * sort parameter and the export's `columns` take — so a column, a sort and an export column are
 * the same thing. `exportFields` is what an export writes for it (a person's "Name" column is the
 * first and last name).
 */
export interface ListColumn<Row> {
    field: string;
    label: string;
    /** The starting width in pixels; a person can resize it and a view saves it. */
    width: number;
    exportFields: readonly string[];
    cell: (row: Row) => ReactNode;
}

const EMPTY = <span className="text-text-faint">—</span>;
const text = (value: string | null | undefined): ReactNode => (value ? value : EMPTY);

/** A standard field's label, from the shared descriptors (the one place labels are written). */
function labelOf(object: RecordObject, field: string): string {
    return STANDARD_FIELDS[object].find((f) => f.name === field)?.label ?? field;
}

export function personName(row: PersonView): string {
    return `${row.nameFirst} ${row.nameLast}`.trim() || row.emails.primary || 'Unnamed person';
}

/** A row's owner by the name the API embedded (P1-4a); "No owner" when there is none. */
export function ownerCell(owner: MemberSummaryView | null): ReactNode {
    if (!owner) return <Badge status="warning">No owner</Badge>;
    return owner.name ?? 'Unnamed member';
}

/** A related record by the name the API embedded; `null` (none, trashed, not visible) reads as empty. */
const related = (summary: RecordSummaryView | null): ReactNode => (summary ? summary.name : EMPTY);

const PERSON_COLUMNS: ListColumn<PersonView>[] = [
    {
        field: 'nameFirst',
        label: 'Name',
        width: 240,
        exportFields: ['nameFirst', 'nameLast'],
        // The identity cell is drawn by the table (avatar + name + title), so this is its text form.
        cell: (row) => personName(row),
    },
    {
        field: 'emailPrimary',
        label: labelOf('person', 'emailPrimary'),
        width: 220,
        exportFields: ['emailPrimary'],
        cell: (r) => text(r.emails.primary),
    },
    {
        field: 'companyId',
        label: labelOf('person', 'companyId'),
        width: 180,
        exportFields: ['companyId'],
        cell: (row) => related(row.company),
    },
    {
        field: 'jobTitle',
        label: labelOf('person', 'jobTitle'),
        width: 180,
        exportFields: ['jobTitle'],
        cell: (r) => text(r.jobTitle),
    },
    { field: 'city', label: labelOf('person', 'city'), width: 140, exportFields: ['city'], cell: (r) => text(r.city) },
    {
        field: 'ownerId',
        label: labelOf('person', 'ownerId'),
        width: 150,
        exportFields: ['ownerId'],
        cell: (r) => ownerCell(r.owner),
    },
    {
        field: 'contactStatus',
        label: labelOf('person', 'contactStatus'),
        width: 120,
        exportFields: ['contactStatus'],
        cell: (r) =>
            r.cadenceOverdue ? (
                <span className="inline-flex flex-wrap items-center gap-1">
                    {CONTACT_STATUS_LABELS[r.contactStatus]}
                    <Badge status="danger">Overdue</Badge>
                </span>
            ) : (
                CONTACT_STATUS_LABELS[r.contactStatus]
            ),
    },
    {
        field: 'lastContactedAt',
        label: labelOf('person', 'lastContactedAt'),
        width: 140,
        exportFields: ['lastContactedAt'],
        cell: (r) => (r.lastContactedAt ? formatRelative(r.lastContactedAt) : EMPTY),
    },
    {
        field: 'contactAttempts',
        label: labelOf('person', 'contactAttempts'),
        width: 110,
        exportFields: ['contactAttempts'],
        cell: (r) => <span className="tabular-nums">{r.contactAttempts}</span>,
    },
    {
        field: 'createdAt',
        label: labelOf('person', 'createdAt'),
        width: 130,
        exportFields: ['createdAt'],
        cell: (r) => formatDate(r.createdAt),
    },
    {
        field: 'updatedAt',
        label: labelOf('person', 'updatedAt'),
        width: 130,
        exportFields: ['updatedAt'],
        cell: (r) => formatRelative(r.updatedAt),
    },
];

const COMPANY_COLUMNS: ListColumn<CompanyView>[] = [
    { field: 'name', label: labelOf('company', 'name'), width: 240, exportFields: ['name'], cell: (r) => r.name },
    {
        field: 'domain',
        label: labelOf('company', 'domain'),
        width: 180,
        exportFields: ['domain'],
        cell: (r) => text(r.domain),
    },
    {
        field: 'employeeCount',
        label: labelOf('company', 'employeeCount'),
        width: 120,
        exportFields: ['employeeCount'],
        cell: (r) => (r.employeeCount === null ? EMPTY : r.employeeCount.toLocaleString()),
    },
    {
        field: 'arr',
        label: labelOf('company', 'arr'),
        width: 140,
        exportFields: ['arr'],
        cell: (r) => (r.arr ? formatMoney(r.arr) : EMPTY),
    },
    {
        field: 'icp',
        label: labelOf('company', 'icp'),
        width: 130,
        exportFields: ['icp'],
        cell: (r) => (r.icp ? <Badge status="success">Ideal customer</Badge> : EMPTY),
    },
    {
        field: 'ownerId',
        label: labelOf('company', 'ownerId'),
        width: 150,
        exportFields: ['ownerId'],
        cell: (r) => ownerCell(r.owner),
    },
    {
        field: 'createdAt',
        label: labelOf('company', 'createdAt'),
        width: 130,
        exportFields: ['createdAt'],
        cell: (r) => formatDate(r.createdAt),
    },
    {
        field: 'updatedAt',
        label: labelOf('company', 'updatedAt'),
        width: 130,
        exportFields: ['updatedAt'],
        cell: (r) => formatRelative(r.updatedAt),
    },
];

const OPPORTUNITY_COLUMNS: ListColumn<OpportunityView>[] = [
    // The identity column; the deals list draws it as a link that opens the deal.
    { field: 'name', label: labelOf('opportunity', 'name'), width: 240, exportFields: ['name'], cell: (r) => r.name },
    {
        field: 'companyId',
        label: labelOf('opportunity', 'companyId'),
        width: 180,
        exportFields: ['companyId'],
        cell: (r) => related(r.company),
    },
    {
        field: 'pointOfContactId',
        label: labelOf('opportunity', 'pointOfContactId'),
        width: 180,
        exportFields: ['pointOfContactId'],
        cell: (r) => related(r.pointOfContact),
    },
    {
        field: 'amount',
        label: labelOf('opportunity', 'amount'),
        width: 130,
        exportFields: ['amount'],
        cell: (r) => <span className="tabular-nums">{r.amount ? formatMoney(r.amount) : EMPTY}</span>,
    },
    {
        field: 'closeDate',
        label: labelOf('opportunity', 'closeDate'),
        width: 130,
        exportFields: ['closeDate'],
        // A calendar date, not an instant: no time, no shift by the viewer's time zone.
        cell: (r) => (r.closeDate ? formatDay(r.closeDate) : EMPTY),
    },
    {
        field: 'probability',
        label: labelOf('opportunity', 'probability'),
        width: 110,
        exportFields: ['probability'],
        cell: (r) => (r.probability === null ? EMPTY : `${r.probability}%`),
    },
    {
        field: 'nextFollowUpDate',
        label: labelOf('opportunity', 'nextFollowUpDate'),
        width: 130,
        exportFields: ['nextFollowUpDate'],
        cell: (r) => (r.nextFollowUpDate ? formatDay(r.nextFollowUpDate) : EMPTY),
    },
    {
        field: 'nextActivity',
        label: labelOf('opportunity', 'nextActivity'),
        width: 200,
        exportFields: ['nextActivity'],
        cell: (r) => text(r.nextActivity),
    },
    {
        field: 'serviceInterest',
        label: labelOf('opportunity', 'serviceInterest'),
        width: 160,
        exportFields: ['serviceInterest'],
        cell: (r) => text(r.serviceInterest),
    },
    {
        field: 'leadSource',
        label: labelOf('opportunity', 'leadSource'),
        width: 140,
        exportFields: ['leadSource'],
        cell: (r) => text(r.leadSource),
    },
    {
        field: 'lostReasonCode',
        label: labelOf('opportunity', 'lostReasonCode'),
        width: 170,
        exportFields: ['lostReasonCode'],
        cell: (r) => (r.lostReasonCode ? LOST_REASON_LABELS[r.lostReasonCode] : EMPTY),
    },
    {
        field: 'ownerId',
        label: labelOf('opportunity', 'ownerId'),
        width: 150,
        exportFields: ['ownerId'],
        cell: (r) => ownerCell(r.owner),
    },
    {
        field: 'createdAt',
        label: labelOf('opportunity', 'createdAt'),
        width: 130,
        exportFields: ['createdAt'],
        cell: (r) => formatDate(r.createdAt),
    },
    {
        field: 'updatedAt',
        label: labelOf('opportunity', 'updatedAt'),
        width: 130,
        exportFields: ['updatedAt'],
        cell: (r) => formatRelative(r.updatedAt),
    },
];

/** A custom field's value as a cell shows it: lists joined, booleans as words, dates formatted. */
function customCell(definition: CustomFieldView, value: unknown): ReactNode {
    if (value === undefined || value === null || value === '') return EMPTY;
    if (Array.isArray(value)) return value.length ? value.join(', ') : EMPTY;
    if (definition.type === 'boolean') return value ? 'Yes' : 'No';
    if (definition.type === 'date') return formatDay(String(value));
    if (definition.type === 'datetime') return formatDate(String(value));
    return String(value);
}

function customColumns<Row extends { custom: Record<string, unknown> }>(
    object: RecordObject,
    definitions: readonly CustomFieldView[],
): ListColumn<Row>[] {
    return definitions
        .filter((d) => d.object === object && d.archivedAt === null)
        .sort((a, b) => a.position - b.position)
        .map((d) => {
            const field = `custom.${d.key}`;
            return {
                field,
                label: d.label,
                width: 160,
                exportFields: [field],
                cell: (row: Row) => customCell(d, row.custom[d.key]),
            };
        });
}

/** Every column an object's list can show: its standard ones, then its live custom fields. */
const STANDARD_COLUMNS = {
    person: PERSON_COLUMNS,
    company: COMPANY_COLUMNS,
    opportunity: OPPORTUNITY_COLUMNS,
} as const;

export function allColumns<O extends RecordObject>(
    object: O,
    definitions: readonly CustomFieldView[],
): ListColumn<ListRow<O>>[] {
    const standard = STANDARD_COLUMNS[object] as unknown as ListColumn<ListRow<O>>[];
    return [...standard, ...customColumns<ListRow<O>>(object, definitions)];
}

/** What a list shows before anyone chooses: the identity column and the few most useful. */
export const DEFAULT_COLUMNS: Readonly<Record<RecordObject, readonly string[]>> = {
    person: ['nameFirst', 'emailPrimary', 'companyId', 'ownerId', 'contactStatus', 'city', 'updatedAt'],
    company: ['name', 'domain', 'employeeCount', 'arr', 'ownerId', 'updatedAt'],
    // A deal's stage and days in stage are the board's own columns, drawn by the deals list.
    opportunity: ['name', 'companyId', 'amount', 'ownerId', 'closeDate'],
};

/** The identity column, always first and never hidden: a row is always findable by its name. */
export const IDENTITY_FIELD: Readonly<Record<RecordObject, string>> = {
    person: 'nameFirst',
    company: 'name',
    opportunity: 'name',
};

/**
 * The columns to draw, in order, with widths: a saved view's when it has some (fields that no
 * longer exist dropped, the identity column kept first), the defaults otherwise.
 */
export function resolveColumns<O extends RecordObject>(
    object: O,
    available: readonly ListColumn<ListRow<O>>[],
    saved: readonly ViewColumn[] | undefined,
): { column: ListColumn<ListRow<O>>; width: number }[] {
    const byField = new Map(available.map((c) => [c.field, c]));
    const chosen: ViewColumn[] = saved?.length ? [...saved] : DEFAULT_COLUMNS[object].map((field) => ({ field }));
    const identity = IDENTITY_FIELD[object];
    if (!chosen.some((c) => c.field === identity)) chosen.unshift({ field: identity });
    const ordered = [...chosen.filter((c) => c.field === identity), ...chosen.filter((c) => c.field !== identity)];
    return ordered.flatMap((c) => {
        const column = byField.get(c.field);
        return column ? [{ column, width: c.width ?? column.width }] : [];
    });
}

/**
 * Whether a column may be sorted: the shared descriptors decide (P1-4), never this file — a
 * custom field is not sortable in v1, and a standard field is when its descriptor says so.
 */
export function isSortable(object: RecordObject, field: string): boolean {
    return customFieldKey(field) === null && STANDARD_FIELDS[object].some((f) => f.name === field && f.sortable);
}

/** Labels for the page around the list. */
export const LIST_COPY: Readonly<
    Record<
        RecordObject,
        { title: string; subtitle: string; singular: string; plural: string; add: string; search: string }
    >
> = {
    person: {
        title: 'People',
        subtitle: 'Leads and contacts in your portfolio. Verified before they are ever emailed.',
        singular: 'person',
        plural: 'people',
        add: 'Add person',
        search: 'Search people…',
    },
    company: {
        title: 'Companies',
        subtitle: 'Accounts, with their people, deals and NewswireOS history.',
        singular: 'company',
        plural: 'companies',
        add: 'Add company',
        search: 'Search companies…',
    },
    opportunity: {
        title: 'Deals',
        subtitle: 'Your pipeline, as a board and as a list.',
        singular: 'deal',
        plural: 'deals',
        add: 'New deal',
        search: 'Search deals…',
    },
};
