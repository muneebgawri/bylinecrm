import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import {
    assignCompanyOwners,
    TRANSFER_REASON_COMPANY_OWNER,
    TRANSFER_REASON_COMPANY_OWNER_FILL,
} from '../../src/cli/assign-company-owners';
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
 * `assign-company-owners.js` (OWN-2d): the import left companies with no owner and their people owned by whoever
 * saved them. The job gives each such company the owner of its first saved person and, asked to, moves the rest of
 * its people — with the open deals they are the contact of — to that owner through the transfer service.
 */
describe('assign-company-owners: companies take the owner their people name (OWN-2d)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let workspace: string;
    let adminId: string;
    let anaId: string;
    let benId: string;
    /** The import's company: no owner; Ana's person first, then Ben's, with Ben's open deal. */
    let imported: string;
    let anasPerson: string;
    let bensPerson: string;
    let bensDeal: string;
    /** A company with no owner and no people: nothing to read an owner from. */
    let empty: string;
    /** The admin's own company, with a person of Ben's at it. */
    let admins: string;
    let bensOther: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const companyOwner = async (companyId: string) =>
        (await owner.company.findUniqueOrThrow({ where: { id: companyId }, select: { ownerId: true } })).ownerId;
    const personOwner = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { ownerId: true } })).ownerId;
    const dealOwner = async (dealId: string) =>
        (await owner.opportunity.findUniqueOrThrow({ where: { id: dealId }, select: { ownerId: true } })).ownerId;
    const run = (apply: boolean, reassignPeople: boolean) =>
        assignCompanyOwners(app, workspace, { apply, reassignPeople });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const adminEmail = `aco-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Aco ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        // Managers: they place records where they choose, as the import did, so the seed is the import's shape.
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
        ana = await join(`aco-ana-${stamp}@example.test`);
        ben = await join(`aco-ben-${stamp}@example.test`);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        adminId = members.find((m) => m.email === adminEmail)!.id;
        anaId = members.find((m) => m.email === `aco-ana-${stamp}@example.test`)!.id;
        benId = members.find((m) => m.email === `aco-ben-${stamp}@example.test`)!.id;

        const company = async (who: Browser, name: string, unowned: boolean) => {
            const made = id(
                await as(who)
                    .post(w('/companies'))
                    .send({ name: `${name} ${stamp}`, domain: `${name}-${stamp}.test` })
                    .expect(201),
            );
            if (unowned) await owner.company.update({ where: { id: made }, data: { ownerId: null } });
            return made;
        };
        const person = async (who: Browser, local: string, companyId: string) =>
            id(
                await as(who)
                    .post(w('/people'))
                    .send({
                        nameFirst: local,
                        emails: { primary: `${local}@${stamp}.test`, additional: [] },
                        companyId,
                    })
                    .expect(201),
            );

        imported = await company(admin, 'imported', true);
        anasPerson = await person(ana, 'ana-first', imported);
        bensPerson = await person(ben, 'ben-later', imported);
        bensDeal = id(
            await as(ben)
                .post(w('/opportunities'))
                .send({ name: 'Ben deal', currency: 'USD', pointOfContactId: bensPerson, companyId: imported })
                .expect(201),
        );
        empty = await company(admin, 'empty', true);
        admins = await company(admin, 'admins', false);
        bensOther = await person(ben, 'ben-elsewhere', admins);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('estimates: the companies to fill and the people and deals to move, changing nothing', async () => {
        expect(await run(false, true)).toEqual({
            companies: 1,
            assigned: 1,
            companiesTouched: 2,
            peopleMoved: 2,
            dealsMoved: 1,
        });
        expect(await companyOwner(imported)).toBeNull();
        expect(await companyOwner(empty)).toBeNull();
        expect(await personOwner(bensPerson)).toBe(benId);
    });

    it('fills each unowned company with the owner of its first saved person, on its ownership history, silently', async () => {
        expect(await run(true, false)).toEqual({
            companies: 1,
            assigned: 1,
            companiesTouched: 0,
            peopleMoved: 0,
            dealsMoved: 0,
        });
        expect(await companyOwner(imported)).toBe(anaId);
        expect(await companyOwner(empty), 'no people: nothing to read an owner from').toBeNull();
        expect(await companyOwner(admins)).toBe(adminId);
        expect(await personOwner(bensPerson), 'people stay put without --reassign-people').toBe(benId);
        const fill = await owner.ownershipTransfer.findFirstOrThrow({
            where: { object: 'company', recordId: imported },
        });
        expect(fill).toMatchObject({
            fromMemberId: null,
            toMemberId: anaId,
            status: 'forced',
            reason: TRANSFER_REASON_COMPANY_OWNER_FILL,
        });
        expect(await owner.notification.count({ where: { transferId: fill.id } })).toBe(0);
        expect(
            await owner.outboxEvent.count({
                where: {
                    workspaceId: workspace,
                    type: 'company.updated',
                    payload: { path: ['recordId'], equals: imported },
                },
            }),
        ).toBe(1);
    });

    it('--reassign-people moves each person whose owner differs to the company’s owner, with their open deals, as a transfer', async () => {
        expect(await run(true, true)).toEqual({
            companies: 0,
            assigned: 0,
            companiesTouched: 2,
            peopleMoved: 2,
            dealsMoved: 1,
        });
        expect(await personOwner(anasPerson)).toBe(anaId);
        expect(await personOwner(bensPerson)).toBe(anaId);
        expect(await dealOwner(bensDeal)).toBe(anaId);
        expect(await personOwner(bensOther)).toBe(adminId);
        const moved = await owner.ownershipTransfer.findFirstOrThrow({
            where: { object: 'person', recordId: bensPerson },
        });
        expect(moved).toMatchObject({
            fromMemberId: benId,
            toMemberId: anaId,
            status: 'forced',
            reason: TRANSFER_REASON_COMPANY_OWNER,
        });
        expect(moved.moved).toEqual(
            expect.arrayContaining([
                { type: 'person', id: bensPerson },
                { type: 'opportunity', id: bensDeal },
            ]),
        );
        expect(await owner.notification.count({ where: { transferId: moved.id } })).toBe(0);
        const events = await owner.outboxEvent.findMany({
            where: {
                workspaceId: workspace,
                type: { in: ['transfer.completed', 'person.updated', 'opportunity.updated'] },
            },
            select: { type: true, payload: true },
        });
        const of = (type: string, recordId: string) =>
            events.filter((e) => e.type === type && (e.payload as { recordId: string }).recordId === recordId);
        expect(of('transfer.completed', moved.id)).toHaveLength(1);
        expect(of('person.updated', bensPerson)).toHaveLength(1);
        expect(of('opportunity.updated', bensDeal)).toHaveLength(1);
    });

    it('re-running changes nothing', async () => {
        expect(await run(false, true)).toEqual({
            companies: 0,
            assigned: 0,
            companiesTouched: 0,
            peopleMoved: 0,
            dealsMoved: 0,
        });
        expect(await run(true, true)).toEqual({
            companies: 0,
            assigned: 0,
            companiesTouched: 0,
            peopleMoved: 0,
            dealsMoved: 0,
        });
    });
});
