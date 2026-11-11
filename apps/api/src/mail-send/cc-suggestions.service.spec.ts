import { describe, expect, it } from 'vitest';
import type { GuardRequest, GuardVerdict, RecipientGuard } from '../guardrails/recipient-guard';
import type { RlsPrismaService, WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceContext, WorkspaceRunContext } from '../infra/workspace-context';
import { CcSuggestionsService, groupSuggestions, type CcCandidate } from './cc-suggestions.service';
import { MAIL_CC_SUGGESTIONS_MAX } from './mail-send.constants';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const MEMBER = uuid(900_001);
const ACME = { id: uuid(1), name: 'Acme', deletedAt: null };
const INITECH = { id: uuid(2), name: 'Initech', deletedAt: null };

const person = (i: number, over: Partial<CcCandidate & { ownerId: string | null }> = {}) => ({
    id: uuid(100 + i),
    nameFirst: `First${i}`,
    nameLast: `Last${i}`,
    emailPrimary: `p${i}@acme.example`,
    jobTitle: null,
    lastContactedAt: null,
    companyId: ACME.id,
    company: ACME,
    ownerId: MEMBER,
    ...over,
});
type Row = ReturnType<typeof person>;

/**
 * A fake world: the people rows, a transaction client answering the two reads the service makes (the recipients'
 * companies, then the colleagues) with the scope filters applied by hand, and a guard that blocks named addresses.
 */
function harness(rows: Row[], options: { blocked?: string[]; ownerScope?: string } = {}) {
    const guardRequests: GuardRequest[] = [];
    const visible = (row: Row) => !options.ownerScope || row.ownerId === options.ownerScope;
    const tx = {
        person: {
            findMany: (args: {
                where: {
                    id?: { in?: string[]; notIn?: string[] };
                    companyId?: { in?: string[]; not?: null };
                    emailPrimary?: { not: null };
                    ownerId?: string;
                };
                take?: number;
            }) => {
                const w = args.where;
                if (options.ownerScope) expect(w.ownerId).toBe(options.ownerScope);
                const out = rows.filter(
                    (r) =>
                        visible(r) &&
                        (!w.id?.in || w.id.in.includes(r.id)) &&
                        (!w.id?.notIn || !w.id.notIn.includes(r.id)) &&
                        (!w.companyId?.in || (r.companyId !== null && w.companyId.in.includes(r.companyId))) &&
                        (!('not' in (w.companyId ?? {})) || r.companyId !== null) &&
                        (!w.emailPrimary || r.emailPrimary !== null),
                );
                return Promise.resolve(args.take ? out.slice(0, args.take) : out);
            },
        },
    } as unknown as WorkspaceClient;
    const rls = {
        withWorkspace: (fn: (tx: WorkspaceClient) => Promise<unknown>) => fn(tx),
    } as unknown as RlsPrismaService;
    const context: WorkspaceRunContext = {
        workspaceId: uuid(7),
        memberId: MEMBER,
        capabilities: new Set(['record:read']),
        ...(options.ownerScope ? { ownerScopeMemberId: options.ownerScope } : {}),
    };
    const contexts = { get: () => context } as unknown as WorkspaceContext;
    const guard = {
        check: (request: GuardRequest) => {
            guardRequests.push(request);
            return Promise.resolve(
                request.recipients.map((r): GuardVerdict => ({
                    address: r.address,
                    personId: r.personId,
                    field: r.field,
                    ...(options.blocked?.includes(r.address)
                        ? { outcome: 'blocked', kind: 'owned_by_other', message: 'another member’s lead' }
                        : { outcome: 'pass', message: '' }),
                })),
            );
        },
    } as unknown as RecipientGuard;
    return { service: new CcSuggestionsService(rls, contexts, guard), guardRequests };
}

describe('CcSuggestionsService: the composer’s "Also at <Company>" row', () => {
    it('offers the recipient’s colleagues with an address, not the recipient, grouped under the company', async () => {
        const dana = person(1);
        const rows = [dana, person(2, { jobTitle: 'CTO' }), person(3, { emailPrimary: null }), person(4)];
        const { service, guardRequests } = harness(rows);
        const result = await service.suggest([dana.id]);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0]?.company).toEqual({ id: ACME.id, name: 'Acme' });
        expect(result.groups[0]?.people.map((p) => p.id)).toEqual([rows[1]?.id, rows[3]?.id]);
        expect(result.groups[0]?.people[0]).toEqual({
            id: rows[1]?.id,
            name: 'First2 Last2',
            email: 'p2@acme.example',
            jobTitle: 'CTO',
            lastContactedAt: null,
        });
        // Judged as a send would, in the `cc` field, without an audit row.
        expect(guardRequests).toHaveLength(1);
        expect(guardRequests[0]).toMatchObject({ path: 'send', outreach: false, record: false });
        expect(guardRequests[0]?.recipients.map((r) => r.field)).toEqual(['cc', 'cc']);
    });

    it('leaves out whoever the recipient guard blocks (suppressed, pooled, another member’s lead)', async () => {
        const dana = person(1);
        const rows = [dana, person(2), person(3)];
        const { service } = harness(rows, { blocked: ['p2@acme.example'] });
        const result = await service.suggest([dana.id]);
        expect(result.groups[0]?.people.map((p) => p.email)).toEqual(['p3@acme.example']);
    });

    it('is empty for a recipient with no company, and asks the guard nothing', async () => {
        const solo = person(1, { companyId: null, company: null });
        const { service, guardRequests } = harness([solo, person(2)]);
        expect(await service.suggest([solo.id])).toEqual({ groups: [] });
        expect(guardRequests).toHaveLength(0);
    });

    it('groups by company in the To line’s order, several recipients at once', async () => {
        const dana = person(1);
        const sam = person(5, { companyId: INITECH.id, company: INITECH, emailPrimary: 'sam@initech.example' });
        const rows = [
            dana,
            sam,
            person(6, { companyId: INITECH.id, company: INITECH, emailPrimary: 'p6@initech.example' }),
            person(2),
        ];
        const { service } = harness(rows);
        const result = await service.suggest([sam.id, dana.id]);
        expect(result.groups.map((g) => g.company.name)).toEqual(['Initech', 'Acme']);
        expect(result.groups.map((g) => g.people.map((p) => p.email))).toEqual([
            ['p6@initech.example'],
            ['p2@acme.example'],
        ]);
    });

    it('reads inside the caller’s record scope: an own-scoped member sees only their own colleagues', async () => {
        const dana = person(1);
        const rows = [dana, person(2, { ownerId: uuid(900_002) }), person(3)];
        const { service } = harness(rows, { ownerScope: MEMBER });
        const result = await service.suggest([dana.id]);
        expect(result.groups[0]?.people.map((p) => p.email)).toEqual(['p3@acme.example']);
    });
});

describe('groupSuggestions', () => {
    const verdict = (c: CcCandidate, outcome: GuardVerdict['outcome']): GuardVerdict => ({
        address: c.emailPrimary ?? '',
        personId: c.id,
        outcome,
        message: '',
    });

    it(`offers at most ${MAIL_CC_SUGGESTIONS_MAX} across every company, in the order read`, () => {
        const many = Array.from({ length: MAIL_CC_SUGGESTIONS_MAX + 5 }, (_, i) => person(10 + i));
        const result = groupSuggestions(
            [ACME.id],
            many,
            many.map((c) => verdict(c, 'pass')),
            MAIL_CC_SUGGESTIONS_MAX,
        );
        expect(result.groups[0]?.people).toHaveLength(MAIL_CC_SUGGESTIONS_MAX);
        expect(result.groups[0]?.people[0]?.id).toBe(many[0]?.id);
    });

    it('drops a company in the trash and an empty group', () => {
        const gone = { ...ACME, deletedAt: new Date() };
        const c = person(1, { company: gone });
        expect(groupSuggestions([ACME.id], [c], [verdict(c, 'pass')], 20)).toEqual({ groups: [] });
        const d = person(2);
        expect(groupSuggestions([ACME.id], [d], [verdict(d, 'blocked')], 20)).toEqual({ groups: [] });
    });

    it('keeps a warned recipient: only a block hides someone', () => {
        const c = person(1);
        expect(groupSuggestions([ACME.id], [c], [verdict(c, 'warned')], 20).groups[0]?.people).toHaveLength(1);
    });
});
