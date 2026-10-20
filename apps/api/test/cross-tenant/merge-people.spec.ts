import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { PeopleDedupe } from '../../src/records/people-dedupe.service';
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

function browserFrom(res: Response) {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * Person dedupe: people saved more than once (the 2026-10-12 Twenty import) are merged — everything attached moves
 * to the survivor, the duplicate is trashed with a pointer, the member who first contacted the lead owns the result
 * through an audited forced transfer — once, and never across workspaces.
 */
describe('person dedupe: merging people saved more than once', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let dedupe: PeopleDedupe;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `acme-${stamp}.test`;
    let workspace: string;
    let other: string;
    let admin: { cookie: string; csrf: string };
    let adminMember: string;
    let second: string;
    let company: string;
    let p1: string;
    let p2: string;
    let p3: string;
    let otherA: string;
    let otherB: string;

    const as = (who: { cookie: string; csrf: string }) => ({
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = workspace) => `/api/w/${ws}${path}`;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        dedupe = app.get(PeopleDedupe);
        const signUp = async (email: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(`dedupe-${stamp}@example.test`));
        const otherSignup = await signUp(`dedupe-other-${stamp}@example.test`);
        other = otherSignup.id;
        const seat = await owner.workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace } });
        adminMember = seat.id;
        const user = await owner.user.create({ data: { email: `dedupe-second-${stamp}@example.test` } });
        second = (
            await owner.workspaceMember.create({
                data: { workspaceId: workspace, userId: user.id, roleId: seat.roleId },
            })
        ).id;

        company = (
            (await as(admin).post(w('/companies')).send({ name: 'Acme', domain }).expect(201)).body as { id: string }
        ).id;
        const create = async (body: object, who = admin, ws = workspace) =>
            ((await as(who).post(w('/people', ws)).send(body).expect(201)).body as { id: string }).id;
        // Rick, saved three times: twice sharing an address (auto), once only by name at the company (review).
        p1 = await create({
            nameFirst: 'Rick',
            nameLast: 'Hoganson',
            companyId: company,
            emails: { primary: `rick@${domain}`, additional: [] },
            jobTitle: 'CEO',
        });
        p2 = await create({
            nameFirst: 'Rick',
            nameLast: 'Hoganson',
            emails: { primary: `rick.h-${stamp}@gmail.com`, additional: [] },
        });
        p3 = await create({
            nameFirst: 'Rick',
            nameLast: 'Hoganson',
            companyId: company,
            emails: { primary: `rhoganson@${domain}`, additional: [] },
        });
        // Written past the API, as the import did: p2 also carries p1's address and is linked to its own Bigin Contact.
        await owner.$executeRaw`UPDATE people SET emails = jsonb_set(emails, '{additional}', ${JSON.stringify([`RICK@${domain}`])}::jsonb),
            city = 'Austin', owner_id = NULL WHERE id = ${p2}::uuid`;
        await owner.biginImportLink.create({
            data: {
                workspaceId: workspace,
                object: 'Contacts',
                externalId: `zcrm_${stamp}`,
                localType: 'person',
                localId: p2,
            },
        });
        await owner.biginContactReuse.create({
            data: {
                workspaceId: workspace,
                biginId: `zcrm_${stamp}`,
                previousPersonId: p2,
                newPersonId: p3,
                before: {},
                after: {},
            },
        });
        await as(admin)
            .post(w('/notes'))
            .send({
                title: 'On both',
                targets: [
                    { type: 'person', id: p1 },
                    { type: 'person', id: p2 },
                ],
            })
            .expect(201);
        const early = (
            (
                await as(admin)
                    .post(w('/notes'))
                    .send({ title: 'First call', targets: [{ type: 'person', id: p2 }] })
                    .expect(201)
            ).body as { id: string }
        ).id;
        // The second member logged the first contact, long before anyone else.
        await owner.$executeRaw`UPDATE notes SET created_by = ${JSON.stringify({ kind: 'member', id: second })}::jsonb,
            created_at = '2026-01-01T00:00:00Z' WHERE id = ${early}::uuid`;

        // The other workspace has the same duplicates; it is never touched.
        otherA = await create(
            { nameFirst: 'Rick', nameLast: 'Hoganson', emails: { primary: `rick@${domain}`, additional: [] } },
            otherSignup.browser,
            other,
        );
        otherB = await create(
            {
                nameFirst: 'Rick',
                nameLast: 'Hoganson',
                emails: { primary: `other-${stamp}@gmail.com`, additional: [] },
            },
            otherSignup.browser,
            other,
        );
        await owner.$executeRaw`UPDATE people SET emails = jsonb_set(emails, '{additional}', ${JSON.stringify([`rick@${domain}`])}::jsonb) WHERE id = ${otherB}::uuid`;
        await settle(app);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('detects per workspace: shared address is auto, same name at the company is review', async () => {
        const groups = await dedupe.detect(workspace);
        expect(groups.map((g) => [g.tier, g.personIds])).toEqual([
            ['auto', [p1, p2]],
            ['review', [p1, p2, p3]],
        ]);
        expect((await dedupe.detect(other)).map((g) => g.personIds)).toEqual([[otherA, otherB]]);
    });

    it('a dry run reports the merge, with the first contact’s member as owner, and changes nothing', async () => {
        const report = await dedupe.run(workspace, { apply: false });
        expect(report.tiers).toEqual({ auto: { groups: 1, people: 2 }, review: { groups: 1, people: 3 } });
        expect(report.merged).toBe(1);
        const [auto, review] = report.groups;
        expect(auto).toMatchObject({ outcome: 'would merge', survivorId: p1, mergedIds: [p2], ownerId: second });
        expect(auto!.ownerWhy).toContain('first contact: note');
        expect(auto!.biginIds).toEqual([`zcrm_${stamp}`]);
        expect(auto!.counts).toMatchObject({ noteLinks: 1, biginLinks: 1 });
        expect(review).toMatchObject({ outcome: 'listed', tier: 'review' });
        expect((await owner.person.findUniqueOrThrow({ where: { id: p2 } })).deletedAt).toBeNull();
        expect(await owner.ownershipTransfer.count({ where: { recordId: p1 } })).toBe(0);
    });

    it('--apply merges the auto tier: everything moves, the duplicate is trashed with a pointer, the owner changes by transfer', async () => {
        const report = await dedupe.run(workspace, { apply: true });
        expect(report).toMatchObject({ merged: 1, failed: 0 });
        await settle(app);

        const kept = await owner.person.findUniqueOrThrow({ where: { id: p1 } });
        const gone = await owner.person.findUniqueOrThrow({ where: { id: p2 } });
        expect(gone.deletedAt).not.toBeNull();
        expect(gone.mergedIntoId).toBe(p1);
        expect(gone.emailPrimary).toBeNull();
        expect(kept.emails).toEqual({ primary: `rick@${domain}`, additional: [`rick.h-${stamp}@gmail.com`] });
        expect(kept).toMatchObject({ city: 'Austin', jobTitle: 'CEO', ownerId: second });

        const notes = await owner.noteTarget.findMany({ where: { targetType: 'person', targetId: { in: [p1, p2] } } });
        expect(notes).toHaveLength(2);
        expect(notes.every((n) => n.targetId === p1)).toBe(true);
        expect(
            (
                await owner.biginImportLink.findFirstOrThrow({
                    where: { workspaceId: workspace, externalId: `zcrm_${stamp}` },
                })
            ).localId,
        ).toBe(p1);
        expect(await owner.biginContactReuse.findFirstOrThrow({ where: { workspaceId: workspace } })).toMatchObject({
            previousPersonId: p1,
            newPersonId: p3,
        });

        const transfer = await owner.ownershipTransfer.findFirstOrThrow({
            where: { workspaceId: workspace, recordId: p1 },
        });
        expect(transfer).toMatchObject({ status: 'forced', fromMemberId: adminMember, toMemberId: second });
        const merged = await owner.timelineActivity.findMany({
            where: { workspaceId: workspace, kind: 'person.merged' },
        });
        expect(merged.map((t) => t.targetId).sort()).toEqual([p1, p2].sort());
        expect(
            await owner.timelineActivity.count({
                where: { targetType: 'person', targetId: p2, kind: { not: 'person.merged' } },
            }),
        ).toBe(0);

        // The other workspace's duplicates are untouched.
        const others = await owner.person.findMany({ where: { id: { in: [otherA, otherB] } } });
        expect(others.every((p) => p.deletedAt === null && p.mergedIntoId === null)).toBe(true);
        expect(await owner.ownershipTransfer.count({ where: { workspaceId: other } })).toBe(0);
    });

    it('is idempotent: a second run finds no auto group and merges nothing; review stays until asked', async () => {
        const again = await dedupe.run(workspace, { apply: true });
        expect(again.tiers.auto.groups).toBe(0);
        expect(again.merged).toBe(0);
        expect(again.groups).toEqual([expect.objectContaining({ tier: 'review', outcome: 'listed' })]);
        expect((await owner.person.findUniqueOrThrow({ where: { id: p3 } })).deletedAt).toBeNull();

        const review = await dedupe.run(workspace, { apply: true, includeReview: true });
        expect(review.merged).toBe(1);
        expect((await owner.person.findUniqueOrThrow({ where: { id: p3 } })).mergedIntoId).toBe(p1);
        expect((await dedupe.detect(workspace)).length).toBe(0);
        expect(await dedupe.merge(workspace, [p1, p2, p3], true)).toBeNull();
    });
});
