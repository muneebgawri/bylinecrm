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
import { duplicatePairs, mergeCompany } from '../../src/records/merge-companies';
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
 * OWN-2e (#201): companies saved twice under one registrable domain before OWN-2c (`inter.ikea.com` beside
 * `ikea.com`) are merged into the kept company — everything attached moves, the kept company fills its gaps,
 * the duplicate goes to the trash — and another workspace's companies are never touched.
 */
describe('OWN-2e merging companies saved twice (FR-CRMS-20)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const root = `ikea-${stamp}.test`;
    let workspace: string;
    let other: string;
    let admin: { cookie: string; csrf: string };
    let kept: string;
    let dup: string;
    let otherDup: string;

    const as = (who: { cookie: string; csrf: string }) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = workspace) => `/api/w/${ws}${path}`;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        const signUp = async (email: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(`merge-${stamp}@example.test`));
        const otherSignup = await signUp(`merge-other-${stamp}@example.test`);
        other = otherSignup.id;

        const company = async (name: string, domain: string, who = admin, ws = workspace) =>
            ((await as(who).post(w('/companies', ws)).send({ name, domain }).expect(201)).body as { id: string }).id;
        kept = await company('IKEA', root);
        // Saved before domains were compared by registrable domain: written past the API's rule.
        dup = await company('IKEA Inter', `placeholder-${stamp}.test`);
        await owner.$executeRaw`UPDATE companies SET domain = ${`inter.${root}`}, logo_url = 'https://logo.test/i.png' WHERE id = ${dup}::uuid`;
        const keptOther = await company('IKEA', root, otherSignup.browser, other);
        otherDup = await company('IKEA Inter', `placeholder-o-${stamp}.test`, otherSignup.browser, other);
        await owner.$executeRaw`UPDATE companies SET domain = ${`inter.${root}`} WHERE id = ${otherDup}::uuid`;
        expect(keptOther).toBeTruthy();

        await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Ana', companyId: dup, emails: { primary: `ana@inter.${root}`, additional: [] } })
            .expect(201);
        await as(admin)
            .post(w('/opportunities'))
            .send({ name: 'Inter deal', currency: 'USD', companyId: dup })
            .expect(201);
        await as(admin)
            .post(w('/notes'))
            .send({
                title: 'On both',
                targets: [
                    { type: 'company', id: dup },
                    { type: 'company', id: kept },
                ],
            })
            .expect(201);
        await as(admin)
            .post(w('/notes'))
            .send({ title: 'On the duplicate', targets: [{ type: 'company', id: dup }] })
            .expect(201);
        await settle(app);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('FR-CRMS-20: pairs each duplicate with the company on the registrable domain, one workspace at a time', async () => {
        const pairs = await duplicatePairs(owner, workspace);
        expect(pairs).toEqual([
            expect.objectContaining({ workspaceId: workspace, duplicateId: dup, keptId: kept, keptDomain: root }),
        ]);
    });

    it('FR-CRMS-20: moves everything to the kept company, fills its gaps, trashes the duplicate, and leaves the other workspace alone', async () => {
        const [pair] = await duplicatePairs(owner, workspace);
        const counts = await owner.$transaction((tx) => mergeCompany(tx, pair!));
        expect(counts).toMatchObject({ people: 1, deals: 1, noteLinks: 1 });

        const people = await owner.person.findMany({
            where: { workspaceId: workspace, companyId: { in: [kept, dup] } },
        });
        expect(people.map((p) => p.companyId)).toEqual([kept]);
        expect(
            (await owner.opportunity.findFirstOrThrow({ where: { workspaceId: workspace, name: 'Inter deal' } }))
                .companyId,
        ).toBe(kept);
        const links = await owner.noteTarget.findMany({
            where: { targetType: 'company', targetId: { in: [kept, dup] } },
        });
        expect(links.every((l) => l.targetId === kept)).toBe(true);
        expect(links).toHaveLength(2);
        expect(await owner.timelineActivity.count({ where: { targetType: 'company', targetId: dup } })).toBe(0);

        const keptRow = await owner.company.findUniqueOrThrow({ where: { id: kept } });
        expect(keptRow.logoUrl).toBe('https://logo.test/i.png');
        expect((await owner.company.findUniqueOrThrow({ where: { id: dup } })).deletedAt).not.toBeNull();
        expect((await owner.company.findUniqueOrThrow({ where: { id: otherDup } })).deletedAt).toBeNull();
        expect(await duplicatePairs(owner, workspace)).toEqual([]);

        // The kept company reads as one record with the moved people and deal.
        const viaApi = (await as(admin).get(w(`/people?q=Ana`)).expect(200)).body as { items: { companyId: string }[] };
        expect(viaApi.items[0]?.companyId).toBe(kept);
    });
});
