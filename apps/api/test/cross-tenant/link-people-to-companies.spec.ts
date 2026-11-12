import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { linkPeopleToCompanies } from '../../src/cli/link-people-to-companies';
import { PrismaService } from '../../src/infra/prisma.service';
import { verifyAddress } from '../support/mail';

interface Browser {
    cookie: string;
    csrf: string;
}

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

/**
 * `link-people-to-companies.js` (OWN-2): a person with no company is read as at the company their address's domain
 * names, though their record says nothing. The job writes that link — to the company that has the domain, else to a
 * new one named for it, which then takes its first saver as owner — and leaves free mail alone.
 */
describe('link-people-to-companies: a person with no company joins the one at their address’s domain (OWN-2)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let workspace: string;
    let anaId: string;
    /** The admin's company, which has the `known` domain. */
    let known: string;
    let atKnown: string;
    /** Two people at a domain no company has: Ana's first, then Ben's. */
    let anaFresh: string;
    let benFresh: string;
    let atGmail: string;
    let atProvider: string;
    const fresh = `fresh-${stamp}.test`;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const companyOf = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { companyId: true } })).companyId;
    const run = (apply: boolean) => linkPeopleToCompanies(app, workspace, { apply });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const adminEmail = `lpc-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Lpc ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        // Managers: they place records where they choose, as the import did, so the seed is the import's shape —
        // people with an address at a company's domain and no company.
        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const manager = roles.find((r) => r.name === 'manager')!.id;
        const join = async (email: string) => {
            const invite = await as(admin).post(w('/invites')).send({ email, roleId: manager }).expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(`lpc-ana-${stamp}@example.test`);
        ben = await join(`lpc-ben-${stamp}@example.test`);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === `lpc-ana-${stamp}@example.test`)!.id;

        const person = async (who: Browser, address: string) =>
            id(
                await as(who)
                    .post(w('/people'))
                    .send({ nameFirst: address.split('@')[0], emails: { primary: address, additional: [] } })
                    .expect(201),
            );
        known = id(
            await as(admin)
                .post(w('/companies'))
                .send({ name: `Known ${stamp}`, domain: `known-${stamp}.test` })
                .expect(201),
        );
        atKnown = await person(ana, `dana@known-${stamp}.test`);
        anaFresh = await person(ana, `first@${fresh}`);
        benFresh = await person(ben, `later@${fresh}`);
        atGmail = await person(ana, `lpc-${stamp}@gmail.com`);
        atProvider = await person(ana, `lpc-${stamp}@comcast.net`);
        for (const p of [atKnown, anaFresh, benFresh, atGmail, atProvider]) expect(await companyOf(p)).toBeNull();
    });

    afterAll(async () => {
        await app?.close();
    });

    const expected = {
        people: 3,
        domains: 2,
        joined: 1,
        created: 1,
        joinedNew: 2,
        createdShared: 1,
        failed: 0,
        ownersFilled: 1,
    };

    it('estimates what it would link and make, changing nothing', async () => {
        expect(await run(false)).toEqual(expected);
        for (const p of [atKnown, anaFresh, benFresh]) expect(await companyOf(p)).toBeNull();
        expect(await owner.company.count({ where: { workspaceId: workspace, domain: fresh } })).toBe(0);
    });

    it('links each person to the company at their domain, making one named for the domain where there is none', async () => {
        expect(await run(true)).toEqual(expected);
        expect(await companyOf(atKnown)).toBe(known);
        const made = await owner.company.findFirstOrThrow({ where: { workspaceId: workspace, domain: fresh } });
        expect(made).toMatchObject({ name: fresh, createdBy: { kind: 'import', id: null } });
        expect(await companyOf(anaFresh)).toBe(made.id);
        expect(await companyOf(benFresh)).toBe(made.id);
        expect(made.ownerId, 'the first saver’s, as any company the import left without an owner').toBe(anaId);
        expect(await companyOf(atGmail), 'free mail names no company').toBeNull();
        expect(await companyOf(atProvider), 'nor does a consumer provider’s domain').toBeNull();
    });

    it('keeps its changes in BylineCRM: on the records’ history, never sent to a webhook', async () => {
        const events = await owner.outboxEvent.findMany({
            where: {
                workspaceId: workspace,
                type: 'person.updated',
                payload: { path: ['recordId'], equals: benFresh },
            },
            select: { payload: true },
        });
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({ internal: true, actor: { kind: 'import' } });
    });

    it('changes nothing run again', async () => {
        expect(await run(true)).toEqual({
            people: 0,
            domains: 0,
            joined: 0,
            created: 0,
            joinedNew: 0,
            createdShared: 0,
            failed: 0,
            ownersFilled: 0,
        });
    });
});
