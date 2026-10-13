import { TWENTY_IMPORT_SOURCE, type TwentyImportObject } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import {
    mapCompany,
    mapLeadLookup,
    mapLeadView,
    mapMessageCampaign,
    mapNote,
    mapOpportunity,
    mapPerson,
    mapTask,
    type LinkIndex,
} from './mappers';

/** A link index over a few known Twenty ids. */
function links(known: Partial<Record<TwentyImportObject, Record<string, string>>>): LinkIndex {
    const resolve = (object: TwentyImportObject, externalId: unknown) =>
        typeof externalId === 'string' ? (known[object]?.[externalId] ?? null) : null;
    return {
        resolve,
        link: (object, externalId) => {
            const localId = resolve(object, externalId);
            return localId
                ? { object, externalId: String(externalId), localType: 'person', localId, label: null }
                : null;
        },
    };
}

const MEMBER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const PERSON = '33333333-3333-4333-8333-333333333333';
const DEAL = '44444444-4444-4444-8444-444444444444';
const base = { id: 'ext-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };

describe('P4-4 (doc 48 §11): a Twenty company becomes a company', () => {
    it('P4-4b: a company whose link does not parse maps with no domain instead of throwing', () => {
        const mapped = mapCompany(
            {
                ...base,
                name: 'Broken Link Ltd',
                domainName: { primaryLinkUrl: 'http://', primaryLinkLabel: '', secondaryLinks: [] },
            },
            links({}),
        );
        expect(mapped).toMatchObject({ input: { domain: null } });
    });

    it('maps the standard fields, the owner through the member link, and the rest as custom values', () => {
        const mapped = mapCompany(
            {
                ...base,
                name: 'Robert Half',
                domainName: {
                    primaryLinkUrl: 'https://www.RobertHalf.com/about',
                    primaryLinkLabel: '',
                    secondaryLinks: [],
                },
                employees: 120,
                idealCustomerProfile: true,
                annualRecurringRevenue: { amountMicros: 1250000000, currencyCode: 'USD' },
                address: {
                    addressStreet1: '1 Main St',
                    addressStreet2: 'Floor 2',
                    addressCity: 'Menlo Park',
                    addressState: 'CA',
                    addressPostcode: '94025',
                    addressCountry: 'US',
                },
                linkedinLink: {
                    primaryLinkUrl: 'https://linkedin.com/company/rh',
                    primaryLinkLabel: 'RH',
                    secondaryLinks: [],
                },
                xLink: { primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] },
                accountOwnerId: 'tm-1',
                biginrecordid: 'zcrm_1',
                stripeltv: { amountMicros: 5000000, currencyCode: 'USD' },
                stripelastchargeat: '2026-03-01T10:00:00.000Z',
                deletedinbiginat: null,
                position: 5,
                createdBy: { source: 'MANUAL' },
            },
            links({ workspaceMembers: { 'tm-1': MEMBER } }),
        );
        expect(mapped).toMatchObject({
            input: {
                name: 'Robert Half',
                domain: 'roberthalf.com',
                employeeCount: 120,
                icp: true,
                arr: { amountMinor: 125000, currency: 'USD' },
                address: {
                    street: '1 Main St, Floor 2',
                    city: 'Menlo Park',
                    state: 'CA',
                    country: 'US',
                    postalCode: '94025',
                },
                links: { linkedin: { url: 'https://linkedin.com/company/rh', label: 'RH' }, x: null },
                ownerId: MEMBER,
            },
            custom: {
                biginrecordid: { type: 'text', value: 'zcrm_1' },
                stripeltv: { type: 'number', value: 5 },
                stripeltv_currency: { type: 'text', value: 'USD' },
                stripelastchargeat: { type: 'datetime', value: '2026-03-01T10:00:00.000Z' },
                deletedinbiginat: null,
            },
        });
        // Bookkeeping fields are never custom values.
        expect('position' in (mapped as { custom: object }).custom).toBe(false);
        expect('createdBy' in (mapped as { custom: object }).custom).toBe(false);
    });

    it('an owner Twenty names that no member matches leaves the record unowned; a blank domain is null', () => {
        const mapped = mapCompany(
            { ...base, name: 'How 2 Media', domainName: { primaryLinkUrl: '' }, accountOwnerId: 'tm-9' },
            links({}),
        );
        expect(mapped).toMatchObject({ input: { name: 'How 2 Media', domain: null, ownerId: null } });
    });

    it('a company without a name cannot be a company', () => {
        expect(mapCompany({ ...base, name: '' }, links({}))).toEqual({ skip: 'no name' });
    });
});

describe('P4-4 (doc 48 §11): a Twenty person becomes a person', () => {
    it('maps name, emails, phones (with the country from the code or the calling code), links, company and owner', () => {
        const mapped = mapPerson(
            {
                ...base,
                name: { firstName: ' Matthew', lastName: 'Croteau' },
                emails: { primaryEmail: 'Matthew.Croteau@roberthalf.com', additionalEmails: ['m@example.com'] },
                phones: {
                    primaryPhoneNumber: '9782522121',
                    primaryPhoneCountryCode: '',
                    primaryPhoneCallingCode: '+1',
                    additionalPhones: [
                        { number: '2025550101', countryCode: 'US', callingCode: '+1' },
                        { number: '5550101', countryCode: '', callingCode: '' },
                    ],
                },
                jobTitle: 'VP Marketing',
                city: 'Boston',
                linkedinLink: { primaryLinkUrl: 'linkedin.com/in/mc', primaryLinkLabel: '', secondaryLinks: [] },
                xLink: { primaryLinkUrl: '', primaryLinkLabel: '', secondaryLinks: [] },
                avatarUrl: 'https://crm.example/file/x?token=secret',
                companyId: 'tc-1',
                personOwnerId: 'tm-1',
                inboundLeadSource: 'GOOGLE_ADS',
                seniority: '',
                prLink: 'https://www.newswire.ca/news-releases/x',
                emailStatus: 'DELIVERABLE',
                enrichedAt: '2026-10-02T16:24:11.794Z',
                stripeltv: { amountMicros: null, currencyCode: 'USD' },
                emailCheckedAt: null,
            },
            links({ workspaceMembers: { 'tm-1': MEMBER }, companies: { 'tc-1': COMPANY } }),
        );
        expect(mapped).toMatchObject({
            input: {
                nameFirst: 'Matthew',
                nameLast: 'Croteau',
                emails: { primary: 'matthew.croteau@roberthalf.com', additional: ['m@example.com'] },
                phones: {
                    primary: { number: '9782522121', countryCode: 'US' },
                    additional: [{ number: '2025550101', countryCode: 'US' }],
                },
                jobTitle: 'VP Marketing',
                city: 'Boston',
                links: { linkedin: { url: 'https://linkedin.com/in/mc', label: null }, x: null },
                companyId: COMPANY,
                ownerId: MEMBER,
                source: `${TWENTY_IMPORT_SOURCE}:google_ads`,
            },
            custom: {
                pr_link: { type: 'url', value: 'https://www.newswire.ca/news-releases/x' },
                email_status: { type: 'select', value: 'DELIVERABLE' },
                enriched_at: { type: 'datetime', value: '2026-10-02T16:24:11.794Z' },
                inbound_lead_source: { type: 'select', value: 'GOOGLE_ADS' },
                seniority: null,
                stripeltv: null,
                stripeltv_currency: { type: 'text', value: 'USD' },
            },
        });
        // A Twenty avatar URL carries a signed token: it is never copied.
        expect((mapped as { input: { avatarUrl?: unknown } }).input.avatarUrl).toBeUndefined();
    });

    it('a person Twenty gives no source is from the import; one with neither a name nor an email is skipped', () => {
        expect(
            mapPerson({ ...base, name: { firstName: 'Josh', lastName: '' }, emails: { primaryEmail: '' } }, links({})),
        ).toMatchObject({ input: { nameFirst: 'Josh', nameLast: '', source: TWENTY_IMPORT_SOURCE } });
        expect(
            mapPerson({ ...base, name: { firstName: '', lastName: '' }, emails: { primaryEmail: '' } }, links({})),
        ).toEqual({
            skip: 'no name and no email',
        });
    });
});

describe('P4-4 (doc 48 §11): a Twenty opportunity becomes a deal', () => {
    it('maps the amount from micros to minor units, the stage by name and kind, and the references', () => {
        const mapped = mapOpportunity(
            {
                ...base,
                name: 'BELFOR Franchise Group',
                amount: { amountMicros: 12500000000, currencyCode: 'USD' },
                closeDate: '2024-12-05T00:00:00.000Z',
                stage: 'CUSTOMER',
                lostReason: null,
                companyId: 'tc-1',
                pointOfContactId: 'tp-1',
                ownerId: 'tm-1',
                leadfollowupstage: 'First Followup Done',
                gatekeeperblocked: false,
                objectioncategory: 'OTHER',
                nexttouchdate: null,
                biginrecordid: 'zcrm_2',
            },
            links({ workspaceMembers: { 'tm-1': MEMBER }, companies: { 'tc-1': COMPANY }, people: { 'tp-1': PERSON } }),
            'EUR',
        );
        expect(mapped).toMatchObject({
            input: {
                name: 'BELFOR Franchise Group',
                amount: { amountMinor: 1250000, currency: 'USD' },
                closeDate: '2024-12-05',
                companyId: COMPANY,
                pointOfContactId: PERSON,
                ownerId: MEMBER,
            },
            stage: { name: 'Customer', kind: 'won' },
            lostReason: null,
            custom: {
                leadfollowupstage: { type: 'text', value: 'First Followup Done' },
                gatekeeperblocked: { type: 'boolean', value: false },
                objectioncategory: { type: 'select', value: 'OTHER' },
                nexttouchdate: null,
                biginrecordid: { type: 'text', value: 'zcrm_2' },
            },
        });
    });

    it('a zero-decimal currency keeps its units; a lost deal carries its reason; no amount means no amount', () => {
        const lost = mapOpportunity(
            {
                ...base,
                name: 'Lost one',
                amount: { amountMicros: 150000000, currencyCode: 'JPY' },
                stage: 'CLOSED_LOST',
                lostReason: 'NO_RESPONSE',
            },
            links({}),
            'USD',
        );
        expect(lost).toMatchObject({
            input: { amount: { amountMinor: 150, currency: 'JPY' } },
            stage: { name: 'Closed lost', kind: 'lost' },
            lostReason: 'No response',
        });
        const open = mapOpportunity(
            { ...base, name: 'Open', amount: { amountMicros: null, currencyCode: null }, stage: 'NEW' },
            links({}),
            'USD',
        );
        expect(open).toMatchObject({ input: { amount: null }, stage: { name: 'New', kind: 'open' } });
    });
});

describe('P4-4 (doc 48 §11): notes and tasks land on the records they were on', () => {
    const index = links({
        people: { 'tp-1': PERSON },
        companies: { 'tc-1': COMPANY },
        opportunities: { 'to-1': DEAL },
        workspaceMembers: { 'tm-1': MEMBER },
    });

    it('a note keeps its title, its body as rich text, its author, and every target BylineCRM has', () => {
        const mapped = mapNote(
            {
                ...base,
                title: 'voice mail',
                bodyV2: { markdown: 'Left a message.\n\nCall back Monday.' },
                createdBy: { source: 'MANUAL', workspaceMemberId: 'tm-1', name: 'Kate' },
                noteTargets: [
                    {
                        id: 'nt-1',
                        targetPersonId: 'tp-1',
                        targetCompanyId: null,
                        targetOpportunityId: null,
                        targetLeadLookupId: null,
                    },
                    {
                        id: 'nt-2',
                        targetPersonId: null,
                        targetCompanyId: 'tc-1',
                        targetOpportunityId: null,
                        targetLeadLookupId: null,
                    },
                    {
                        id: 'nt-4',
                        targetPersonId: null,
                        targetCompanyId: null,
                        targetOpportunityId: null,
                        targetLeadLookupId: 'tl-1',
                    },
                ],
            },
            index,
        );
        expect(mapped).toMatchObject({
            input: {
                title: 'voice mail',
                authorId: MEMBER,
                targets: [
                    { type: 'person', id: PERSON },
                    { type: 'company', id: COMPANY },
                ],
            },
        });
        const body = (mapped as { input: { body: { content: { type: string }[] } } }).input.body;
        expect(body.content.map((n) => n.type)).toEqual(['paragraph', 'paragraph']);
    });

    it('a note whose every target has no home in BylineCRM is skipped, and says so', () => {
        expect(
            mapNote(
                {
                    ...base,
                    title: 'x',
                    bodyV2: { markdown: '' },
                    noteTargets: [{ id: 'nt', targetLeadLookupId: 'tl-1' }],
                },
                index,
            ),
        ).toEqual({ skip: 'no target in BylineCRM' });
    });

    it('a task maps its status, due date, assignee and targets; done tasks are done', () => {
        const mapped = mapTask(
            {
                ...base,
                title: 'Follow up',
                bodyV2: { markdown: '' },
                status: 'IN_PROGRESS',
                dueAt: '2026-10-20T09:00:00.000Z',
                assigneeId: 'tm-1',
                taskTargets: [{ id: 'tt-1', targetOpportunityId: 'to-1' }],
            },
            index,
        );
        expect(mapped).toMatchObject({
            input: {
                title: 'Follow up',
                status: 'in_progress',
                dueAt: '2026-10-20T09:00:00.000Z',
                assigneeId: MEMBER,
                targets: [{ type: 'opportunity', id: DEAL }],
            },
        });
        expect(
            mapTask({ ...base, title: '', status: 'DONE', taskTargets: [{ id: 't', targetPersonId: 'tp-1' }] }, index),
        ).toMatchObject({
            input: { title: '(untitled)', status: 'done' },
        });
    });
});

describe('P4-4 (doc 48 §11) / FR-CRMS-10: a lead lookup says who works an address', () => {
    it('an assigned lookup excludes the address for its account manager; an unassigned one releases it', () => {
        expect(
            mapLeadLookup({
                ...base,
                email: 'Raphael.Camp@comexposium.com',
                status: 'Assigned',
                assignedToName: 'Tom Lane',
                assignedToEmail: 'tom@example.com',
            }),
        ).toEqual({ action: 'exclude', address: 'raphael.camp@comexposium.com', accountManagerName: 'Tom Lane' });
        expect(mapLeadLookup({ ...base, email: 'x@example.com', status: 'Unassigned', assignedToName: '' })).toEqual({
            action: 'release',
            address: 'x@example.com',
        });
        expect(mapLeadLookup({ ...base, email: 'not an address', status: 'Assigned' })).toEqual({ skip: 'no address' });
    });

    it('#180: an address the one email rule refuses is skipped as no address, not written as an empty exclusion', () => {
        expect(mapLeadLookup({ ...base, email: 'joe@acme_corp.com', status: 'Assigned' })).toEqual({
            skip: 'no address',
        });
    });
});

describe('P4-4 (doc 48 §11): a lead view adds the Lead Engine fields to its person', () => {
    it('finds the person through the link, else by email, and carries the lead fields as custom values', () => {
        const mapped = mapLeadView(
            {
                ...base,
                firstName: 'Margaret',
                lastName: 'McKoin',
                email: 'Magaret@thetimegroup.net',
                phone: '+18949294879',
                companyName: 'Thetimegroup',
                leadId: 'lead-7',
                personId: 'tp-1',
                assignedAm: 'Steve Hardy',
                assignedAmMemberId: 'tm-1',
                lifetimeValue: { amountMicros: 2500000000, currencyCode: 'USD' },
                opportunityStage: '',
                leadCreatedAt: '2026-08-08T08:01:48.082Z',
                gclId: '',
                lastSyncedAt: '2026-10-12T06:05:01.634Z',
            },
            links({ people: { 'tp-1': PERSON }, workspaceMembers: { 'tm-1': MEMBER } }),
        );
        expect(mapped).toMatchObject({
            personId: PERSON,
            email: 'magaret@thetimegroup.net',
            input: {
                nameFirst: 'Margaret',
                nameLast: 'McKoin',
                emails: { primary: 'magaret@thetimegroup.net', additional: [] },
            },
            custom: {
                lead_id: { type: 'text', value: 'lead-7' },
                lead_assigned_am: { type: 'text', value: 'Steve Hardy' },
                lead_company_name: { type: 'text', value: 'Thetimegroup' },
                lead_lifetime_value: { type: 'number', value: 2500 },
                lead_lifetime_value_currency: { type: 'text', value: 'USD' },
                lead_created_at: { type: 'datetime', value: '2026-08-08T08:01:48.082Z' },
                lead_opportunity_stage: null,
            },
        });
        expect('lead_last_synced_at' in (mapped as { custom: object }).custom).toBe(false);
    });
});

describe('P4-4 (doc 48 §11): a message campaign becomes an outreach template', () => {
    it('keeps the name, subject and body; its send counts stay in Twenty', () => {
        expect(
            mapMessageCampaign({
                ...base,
                name: 'Launch',
                subject: 'Hello {{firstName}}',
                bodyTemplate: 'Hi there\n\nThanks.',
                status: 'SENT',
                sentCount: 10,
            }),
        ).toMatchObject({
            input: { name: 'Launch', kind: 'outreach', subject: 'Hello {{firstName}}', body: { type: 'doc' } },
        });
        expect(mapMessageCampaign({ ...base, name: '' })).toEqual({ skip: 'no name' });
    });
});
