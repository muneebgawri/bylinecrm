import { STANDARD_FIELDS } from '@bylinecrm/shared';

/**
 * How a standard field is named for a reader, once: the properties column, the timeline's
 * "changed" chips and any form read `fieldLabel`. A field the shared descriptors name (the list
 * columns, filters and exports read those) takes that label; this map holds only the fields they
 * don't describe. Anything else is spelled from its API name; a custom field is named by its label.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
    nameFirst: 'first name',
    nameLast: 'last name',
    emails: 'emails',
    phones: 'phones',
    jobTitle: 'job title',
    city: 'city',
    source: 'source',
    country: 'country',
    links: 'links',
    avatarUrl: 'avatar',
    companyId: 'company',
    ownerId: 'owner',
    pointOfContactId: 'point of contact',
    name: 'name',
    domain: 'domain',
    employeeCount: 'employees',
    arr: 'ARR',
    address: 'address',
    icp: 'ideal customer',
    amount: 'amount',
    closedAt: 'closed',
    probability: 'probability',
    stageId: 'stage',
    pipelineId: 'pipeline',
};

const DESCRIBED: ReadonlyMap<string, string> = new Map(
    Object.values(STANDARD_FIELDS)
        .flat()
        .map((f) => [f.name, f.label.toLowerCase()] as const),
);

/** `nameFirst` → "first name"; `closeDate` → "expected close"; `custom.lastOutlet` → "last outlet". */
export function fieldLabel(field: string): string {
    const last = field.split('.').pop() ?? field;
    return (
        FIELD_LABELS[last] ??
        DESCRIBED.get(last) ??
        last
            .replace(/([A-Z])/g, ' $1')
            .toLowerCase()
            .trim()
    );
}

/** Title case for a heading: "first name" → "First name". */
export function fieldTitle(field: string): string {
    const label = fieldLabel(field);
    return label.charAt(0).toUpperCase() + label.slice(1);
}
