import {
    TEMPLATE_RENDER_LOCALE,
    formatMoneyIn,
    parseVariablePath,
    type CustomVariableSource,
    type Emails,
    type FieldError,
    type StandardVariablePath,
} from '@bylinecrm/shared';
import type { VariableResolver } from './serializer';

/**
 * The variable registry against a workspace and a recipient (P2-4): which paths a template may
 * name, and what each one is worth for one person, their company, a deal and a sender.
 */

/** The custom-field keys a template may name, per source. `deal` is the opportunity object. */
export type CustomKeys = Record<CustomVariableSource, ReadonlySet<string>>;

/** Variables a template names that the registry or the workspace's custom fields do not have. */
export function unknownVariables(found: { path: string; at: string }[], custom: CustomKeys): FieldError[] {
    const problems: FieldError[] = [];
    for (const { path, at } of found) {
        const parsed = parseVariablePath(path);
        const known =
            parsed?.kind === 'standard' || (parsed?.kind === 'custom' && custom[parsed.source].has(parsed.key));
        if (!known) problems.push({ path: at, message: `unknown variable "${path}"` });
    }
    return problems;
}

/** What a render reads, already scoped to what the caller may see. */
export interface RenderSubjects {
    person: {
        nameFirst: string;
        nameLast: string;
        emails: Emails;
        jobTitle: string | null;
        city: string | null;
        custom: Record<string, unknown>;
    };
    company: { name: string; domain: string | null; custom: Record<string, unknown> } | null;
    deal: {
        name: string;
        amountMinor: number | null;
        currency: string;
        custom: Record<string, unknown>;
    } | null;
    sender: { displayName: string | null } | null;
    /** Custom keys the caller may not see (admin-only): they render blank, neither a value nor missing. */
    hidden?: Partial<Record<'person' | 'company' | 'deal', ReadonlySet<string>>> | undefined;
}

/** A value, or `null` when it is empty — whitespace is empty. */
function present(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/** A custom field's stored value as it reads in an email; `null` when there is none. */
export function customText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
    if (Array.isArray(value)) {
        const parts = value.map((v) => customText(v)).filter((v): v is string => v !== null);
        return parts.length > 0 ? parts.join(', ') : null;
    }
    if (typeof value === 'string') return present(value);
    return null;
}

function standardValue(path: StandardVariablePath, s: RenderSubjects): string | null {
    const { person, company, deal, sender } = s;
    switch (path) {
        case 'person.firstName':
            return present(person.nameFirst);
        case 'person.lastName':
            return present(person.nameLast);
        case 'person.fullName':
            return present(`${person.nameFirst} ${person.nameLast}`);
        case 'person.email':
            return present(person.emails.primary);
        case 'person.jobTitle':
            return present(person.jobTitle);
        case 'person.city':
            return present(person.city);
        case 'company.name':
            return present(company?.name);
        case 'company.domain':
            return present(company?.domain);
        case 'deal.name':
            return present(deal?.name);
        case 'deal.amount':
            return deal && deal.amountMinor !== null
                ? formatMoneyIn({ amountMinor: deal.amountMinor, currency: deal.currency }, TEMPLATE_RENDER_LOCALE)
                : null;
        case 'sender.firstName':
            return present(sender?.displayName?.trim().split(/\s+/)[0]);
        case 'sender.fullName':
            return present(sender?.displayName);
        case 'sender.signature':
            // Never a value: in a body the renderer puts the mailbox's signature where it is named
            // (#193); a subject cannot carry it (refused on save), so there it is nothing.
            return '';
    }
}

/** The resolver a render uses: each path's value for these subjects, `null` when it has none. */
export function resolverFor(subjects: RenderSubjects): VariableResolver {
    return (path) => {
        const parsed = parseVariablePath(path);
        if (!parsed) return null;
        if (parsed.kind === 'standard') return standardValue(parsed.variable.path, subjects);
        if (subjects.hidden?.[parsed.source]?.has(parsed.key)) return '';
        const record =
            parsed.source === 'person'
                ? subjects.person
                : parsed.source === 'company'
                  ? subjects.company
                  : subjects.deal;
        return record ? customText(record.custom[parsed.key]) : null;
    };
}
