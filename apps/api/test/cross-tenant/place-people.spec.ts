import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { parseArgs, parsePlacements, placePeople } from '../../src/cli/place-people';
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
describe('place-people: people go to the company a reviewed source names', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let byDomain: string;
    let byName: string;
    let elsewhereSameDomain: string;
    const p: Record<string, string> = {};

    const as = (who: Browser) => ({
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const id = (res: Response) => (res.body as { id: string }).id;
    const signup = async (email: string, name: string) => {
        const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, email);
        return { who: browserFrom(res), ws: (res.body as { workspace: { id: string } }).workspace.id };
    };
    const alias = async (name: string) =>
        id(
            await as(admin)
                .post(`/api/w/${workspace}/people`)
                .send({
                    nameFirst: name,
                    emails: { primary: `${Math.floor(Math.random() * 900000) + 100000}@email4pr.com`, additional: [] },
                })
                .expect(201),
        );
    const companyOf = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { companyId: true } })).companyId;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer());
        owner = app.get(PrismaService);
        let other: Browser;
        ({ who: admin, ws: workspace } = await signup(`place-admin-${stamp}@example.test`, `Place ${stamp}`));
        ({ who: other, ws: otherWorkspace } = await signup(
            `place-other-${stamp}@example.test`,
            `Place other ${stamp}`,
        ));
        byDomain = id(
            await as(admin)
                .post(`/api/w/${workspace}/companies`)
                .send({ name: `Algenesis ${stamp}`, domain: `algenesis-${stamp}.test` })
                .expect(201),
        );
        byName = id(
            await as(admin)
                .post(`/api/w/${workspace}/companies`)
                .send({ name: `Food Tank ${stamp}` })
                .expect(201),
        );
        elsewhereSameDomain = id(
            await as(other)
                .post(`/api/w/${otherWorkspace}/companies`)
                .send({ name: 'Rohirrim', domain: `rohirrim-${stamp}.test` })
                .expect(201),
        );
        for (const n of ['Ann', 'Ben', 'Cy', 'Dee']) p[n] = await alias(n);
    });

    afterAll(async () => {
        await app.close();
    });

    const file = () =>
        [
            'person_id,company_name,company_domain',
            `${p.Ann},Algenesis Labs,https://www.algenesis-${stamp}.test/`,
            `${p.Ben},"Food Tank ${stamp}",`,
            `${p.Cy},Rohirrim,rohirrim-${stamp}.test`,
            `${p.Dee},Rohirrim,rohirrim-${stamp}.test`,
            `00000000-0000-0000-0000-000000000001,Nobody,`,
        ].join('\n');

    it('reads its flags and its file', () => {
        expect(parseArgs(['acme', '--estimate'])).toEqual({ slug: 'acme', apply: false });
        expect(parseArgs(['acme', '--apply'])).toEqual({ slug: 'acme', apply: true });
        expect(parseArgs(['acme'])).toBeNull();
        expect(parsePlacements(file())[0]).toEqual({
            personId: p.Ann,
            companyName: 'Algenesis Labs',
            companyDomain: `algenesis-${stamp}.test`,
        });
        expect(() => parsePlacements('id,name\n')).toThrow('header');
        expect(() => parsePlacements('person_id,company_name,company_domain\nnot-an-id,Acme,')).toThrow('line 2');
    });

    it('estimates without writing', async () => {
        const report = await placePeople(app, workspace, parsePlacements(file()), { apply: false });
        expect(report).toEqual({
            lines: 5,
            unchanged: 0,
            missing: 1,
            atExisting: 2,
            atNew: 2,
            companiesCreated: 1,
            otherOwner: 0,
        });
        expect(await companyOf(p.Ann!)).toBeNull();
    });

    it('places by domain, then by exact name, else at one new company per firm owned by the person’s owner', async () => {
        const report = await placePeople(app, workspace, parsePlacements(file()), { apply: true });
        expect(report).toMatchObject({ atExisting: 2, atNew: 2, companiesCreated: 1, missing: 1 });
        expect(await companyOf(p.Ann!)).toBe(byDomain);
        expect(await companyOf(p.Ben!)).toBe(byName);
        const made = await companyOf(p.Cy!);
        expect(made).not.toBeNull();
        expect(made).not.toBe(elsewhereSameDomain);
        expect(await companyOf(p.Dee!)).toBe(made);
        const company = await owner.company.findUniqueOrThrow({
            where: { id: made! },
            select: { domain: true, ownerId: true, workspaceId: true },
        });
        const cy = await owner.person.findUniqueOrThrow({ where: { id: p.Cy! }, select: { ownerId: true } });
        expect(company).toEqual({ domain: `rohirrim-${stamp}.test`, ownerId: cy.ownerId, workspaceId: workspace });
    });

    it('is idempotent', async () => {
        expect(await placePeople(app, workspace, parsePlacements(file()), { apply: true })).toEqual({
            lines: 5,
            unchanged: 4,
            missing: 1,
            atExisting: 0,
            atNew: 0,
            companiesCreated: 0,
            otherOwner: 0,
        });
    });
});
