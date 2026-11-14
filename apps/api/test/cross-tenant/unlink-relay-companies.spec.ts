import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { parseArgs, unlinkRelayCompanies } from '../../src/cli/unlink-relay-companies';
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
 * #383: a colleague's or an automated sender's address is nobody's contact. The API refuses such a person on create
 * and on edit; `retire-non-contacts.js` retires the ones that got in before the rule, through the people service's
 * own delete, keeping any a deal points at or that carries notes or tasks.
 */
describe('unlink-relay-companies: a domain that names no company makes none', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let relay: string;
    let relayWithDeal: string;
    let real: string;
    let otherRelay: string;
    const aliases: string[] = [];
    let colleagueAtReal: string;
    let elsewhere: string;

    const as = (who: Browser) => ({
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const id = (res: Response) => (res.body as { id: string }).id;
    const company = async (who: Browser, ws: string, name: string, domain: string | null) => {
        const made = id(
            await as(who)
                .post(`/api/w/${ws}/companies`)
                .send({ name: `${name} ${stamp}` })
                .expect(201),
        );
        // As the import left it: the domain the rule would refuse today.
        if (domain) await owner.company.update({ where: { id: made }, data: { domain } });
        return made;
    };
    const personAt = async (who: Browser, ws: string, name: string, companyId: string) => {
        const made = id(
            await as(who)
                .post(`/api/w/${ws}/people`)
                .send({
                    nameFirst: name,
                    emails: { primary: `${name.toLowerCase()}-${stamp}@contact.test`, additional: [] },
                })
                .expect(201),
        );
        await owner.person.update({ where: { id: made }, data: { companyId } });
        return made;
    };
    const signup = async (email: string, name: string) => {
        const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, email);
        return { who: browserFrom(res), ws: (res.body as { workspace: { id: string } }).workspace.id };
    };
    const companyOf = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { companyId: true } })).companyId;
    const trashed = async (companyId: string) =>
        (await owner.company.findUniqueOrThrow({ where: { id: companyId }, select: { deletedAt: true } })).deletedAt !==
        null;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer());
        owner = app.get(PrismaService);
        ({ who: admin, ws: workspace } = await signup(`relay-admin-${stamp}@example.test`, `Relay ${stamp}`));
        ({ who: other, ws: otherWorkspace } = await signup(
            `relay-other-${stamp}@example.test`,
            `Relay other ${stamp}`,
        ));

        relay = await company(admin, workspace, 'Email4pr', 'email4pr.com');
        for (const n of ['Ann', 'Ben', 'Cy']) aliases.push(await personAt(admin, workspace, n, relay));
        relayWithDeal = await company(admin, workspace, 'Hubspot relay', 'hubspotemail.net');
        await as(admin)
            .post(`/api/w/${workspace}/opportunities`)
            .send({ name: `Deal ${stamp}`, currency: 'USD', companyId: relayWithDeal })
            .expect(201);
        real = await company(admin, workspace, 'Acme', `acme-${stamp}.test`);
        colleagueAtReal = await personAt(admin, workspace, 'Dee', real);
        otherRelay = await company(other, otherWorkspace, 'Email4pr', 'email4pr.com');
        elsewhere = await personAt(other, otherWorkspace, 'Eve', otherRelay);
    });

    afterAll(async () => {
        await app.close();
    });

    it('reads its flags', () => {
        expect(parseArgs(['acme', '--estimate'])).toEqual({ slug: 'acme', apply: false });
        expect(parseArgs(['acme', '--apply'])).toEqual({ slug: 'acme', apply: true });
        expect(parseArgs(['acme'])).toBeNull();
        expect(parseArgs(['acme', '--apply', '--estimate'])).toBeNull();
        expect(parseArgs(['acme', '--estimate', '--domain', 'Email4PR.com'])).toEqual({
            slug: 'acme',
            apply: false,
            domain: 'email4pr.com',
        });
        expect(parseArgs(['acme', '--apply', '--domain'])).toBeNull();
    });

    it('keeps to one domain when asked: the other relay company is not touched', async () => {
        expect(await unlinkRelayCompanies(app, workspace, { apply: false, domain: 'email4pr.com' })).toEqual({
            companies: 1,
            people: 3,
            trashed: 0,
            keptForDeals: 0,
        });
    });

    it('estimates without writing', async () => {
        const report = await unlinkRelayCompanies(app, workspace, { apply: false });
        expect(report).toEqual({ companies: 2, people: 3, trashed: 0, keptForDeals: 0 });
        for (const p of aliases) expect(await companyOf(p)).toBe(relay);
    });

    it('takes the people off, keeps their owner, trashes the empty company and keeps one a deal names', async () => {
        const owners = await owner.person.findMany({
            where: { id: { in: aliases } },
            select: { id: true, ownerId: true },
        });
        const report = await unlinkRelayCompanies(app, workspace, { apply: true });
        expect(report).toEqual({ companies: 2, people: 3, trashed: 1, keptForDeals: 1 });
        for (const p of aliases) expect(await companyOf(p)).toBeNull();
        const after = await owner.person.findMany({
            where: { id: { in: aliases } },
            select: { id: true, ownerId: true },
        });
        expect(after).toEqual(expect.arrayContaining(owners));
        expect(await trashed(relay)).toBe(true);
        expect(
            (await owner.company.findUniqueOrThrow({ where: { id: relay }, select: { deletedReason: true } }))
                .deletedReason,
        ).toBe('wrong_details');
        expect(await trashed(relayWithDeal)).toBe(false);
        // Each person's change is on their record, as any edit is.
        const updated = await owner.outboxEvent.findMany({
            where: { workspaceId: workspace, type: 'person.updated' },
            select: { payload: true },
        });
        const touched = new Set(updated.map((e) => (e.payload as { recordId: string }).recordId));
        for (const p of aliases) expect(touched.has(p), p).toBe(true);
        // A real company and another workspace are not this run's.
        expect(await companyOf(colleagueAtReal)).toBe(real);
        expect(await trashed(real)).toBe(false);
        expect(await companyOf(elsewhere)).toBe(otherRelay);
        expect(await trashed(otherRelay)).toBe(false);
    });

    it('is idempotent: a rerun finds only the company a deal still names', async () => {
        expect(await unlinkRelayCompanies(app, workspace, { apply: true })).toEqual({
            companies: 1,
            people: 0,
            trashed: 0,
            keptForDeals: 1,
        });
    });
});
