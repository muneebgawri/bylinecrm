/**
 * How a standard field is named for a reader, once: the properties column, the timeline's
 * "changed" chips and any form read this map. A field not listed here is spelled from its API
 * name (`closeDate` → "close date"); a custom field is named by its definition's label.
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
    nameFirst: 'first name',
    nameLast: 'last name',
    emails: 'emails',
    phones: 'phones',
    jobTitle: 'job title',
    city: 'city',
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
    closeDate: 'close date',
    probability: 'probability',
    stageId: 'stage',
    pipelineId: 'pipeline',
};

/** `nameFirst` → "first name"; `custom.lastOutlet` → "last outlet". */
export function fieldLabel(field: string): string {
    const last = field.split('.').pop() ?? field;
    return (
        FIELD_LABELS[last] ??
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
