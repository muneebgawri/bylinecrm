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
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

type Browser = { cookie: string; csrf: string };

function browserFrom(res: Response): Browser {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

interface FeedItem {
    kind: string;
    toStage: string | null;
    actor: { kind: string; member: { id: string; name: string | null } | null };
    deal: { id: string; name: string; canOpen: boolean; owner: { id: string } | null };
}

/**
 * The live deal feed: everyone sees what the team does with deals, past their own owner scope, as headlines only —
 * a deal the caller may not open says so. An import's entries stay out, and so does every other workspace.
 */
describe('live deal feed', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let workspace: string;
    let admin: Browser;
    let rep: Browser;
    let leads: Browser;
    let other: Browser;
    let otherWorkspace: string;
    let adminDeal: string;
    let repDeal: string;
    let repMember: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = workspace) => `/api/w/${ws}${path}`;
    const feed = async (who: Browser, ws = workspace) =>
        ((await as(who).get(w('/deal-feed', ws)).expect(200)).body as { items: FeedItem[] }).items;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `feed-admin-${stamp}@example.test`, password, workspaceName: 'Feed Co' })
            .expect(201);
        await verifyAddress(app, http, `feed-admin-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `feed-other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        await verifyAddress(app, http, `feed-other-${stamp}@example.test`);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'rep',
                capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit'],
                recordScope: 'own',
            })
            .expect(201);
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `feed-rep-${stamp}@example.test`, roleId: (role.body as { id: string }).id })
            .expect(201);
        rep = browserFrom(
            await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201),
        );
        await verifyAddress(app, http, `feed-rep-${stamp}@example.test`);
        // A role with no deal capability at all (prod's "Leads Manager"): the feed is still everyone's.
        const leadsRole = await as(admin)
            .post(w('/roles'))
            .send({ name: 'leads', capabilities: ['record:read', 'record:write'], recordScope: 'own' })
            .expect(201);
        const leadsInvite = await as(admin)
            .post(w('/invites'))
            .send({ email: `feed-leads-${stamp}@example.test`, roleId: (leadsRole.body as { id: string }).id })
            .expect(201);
        leads = browserFrom(
            await http()
                .post(`/api/auth/invites/${(leadsInvite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201),
        );
        await verifyAddress(app, http, `feed-leads-${stamp}@example.test`);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        repMember = members.find((m) => m.email === `feed-rep-${stamp}@example.test`)!.id;

        const pipeline = (
            (await as(admin).get(w('/pipelines')).expect(200)).body as {
                stages: { id: string; name: string }[];
            }[]
        )[0]!;
        const contacted = pipeline.stages.find((s) => s.name === 'Contacted')!.id;
        // A deal is with a company: one each, made by whoever adds the deal.
        const company = async (who: Browser, ws = workspace) =>
            (
                (
                    await as(who)
                        .post(w('/companies', ws))
                        .send({ name: `Acme ${stamp}` })
                        .expect(201)
                ).body as {
                    id: string;
                }
            ).id;
        const adminCompany = await company(admin);
        const repCompany = await company(rep);
        const otherCompany = await company(other, otherWorkspace);

        adminDeal = (
            (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `Admin deal ${stamp}`, companyId: adminCompany })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await as(admin)
            .post(w(`/opportunities/${adminDeal}/move`))
            .send({ stageId: contacted })
            .expect(201);
        repDeal = (
            (
                await as(rep)
                    .post(w('/opportunities'))
                    .send({ name: `Rep deal ${stamp}`, companyId: repCompany })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await as(other)
            .post(w('/opportunities', otherWorkspace))
            .send({ name: `Other deal ${stamp}`, companyId: otherCompany })
            .expect(201);
        await settle(app);

        // What an import wrote is history, not team activity.
        await owner.timelineActivity.create({
            data: {
                workspaceId: workspace,
                targetType: 'opportunity',
                targetId: adminDeal,
                kind: 'deal.won',
                happenedAt: new Date(),
                actor: { kind: 'import', id: null },
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    it('an own-scoped member sees a teammate’s deals as headlines, and only their own as openable', async () => {
        const items = await feed(rep);
        const adminEntries = items.filter((i) => i.deal.id === adminDeal);
        expect(adminEntries.map((i) => i.kind).sort()).toEqual(['created', 'stage']);
        expect(adminEntries.every((i) => !i.deal.canOpen && i.deal.name === `Admin deal ${stamp}`)).toBe(true);
        expect(adminEntries.find((i) => i.kind === 'stage')?.toStage).toBe('Contacted');

        const repEntry = items.find((i) => i.deal.id === repDeal)!;
        expect(repEntry).toMatchObject({ kind: 'created', deal: { canOpen: true, owner: { id: repMember } } });
        expect(repEntry.actor).toMatchObject({ kind: 'member', member: { id: repMember } });

        // The feed tells the headline; opening the deal is still refused.
        expect((await as(rep).get(w(`/opportunities/${adminDeal}`))).status).toBe(404);
    });

    it('is shown to a member without deal:read, who can open none of it', async () => {
        const items = await feed(leads);
        expect(items.some((i) => i.deal.id === adminDeal)).toBe(true);
        expect(items.some((i) => i.deal.id === repDeal)).toBe(true);
        expect(items.every((i) => !i.deal.canOpen)).toBe(true);
    });

    it('leaves out what an import wrote and every other workspace', async () => {
        const items = await feed(admin);
        expect(items.some((i) => i.kind === 'won')).toBe(false);
        expect(items.every((i) => i.deal.canOpen)).toBe(true);
        expect(items.some((i) => i.deal.name === `Other deal ${stamp}`)).toBe(false);
        expect((await feed(other, otherWorkspace)).map((i) => i.deal.name)).toEqual([`Other deal ${stamp}`]);
    });
});
