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
    releaseDepartedOwners,
    TRANSFER_REASON_DEPARTED_TO_COMPANY_OWNER,
} from '../../src/cli/release-departed-owners';
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
 * `release-departed-owners.js`: a member who has left holds records nobody works. Each person goes to the active
 * owner of their company, with the departed member's open deals with them; else to nobody. Each open deal still the
 * departed member's goes to its company's active owner, else its contact's, else to nobody.
 */
describe('release-departed-owners: a departed member’s records go to the company owner, else nobody', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let workspace: string;
    let adminId: string;
    let benId: string;
    /** Ben's person at the admin's company, with Ben's open deal there. */
    let atAdmins: string;
    let dealAtAdmins: string;
    /** Ben's person with no company, the contact of Ben's deal at Ben's own company. */
    let alone: string;
    let dealAlone: string;
    /** Ben's closed deal: history, it keeps its owner. */
    let closed: string;
    /** Ben's company: once Ben has left, nobody active owns it. */
    let bens: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const personOwner = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { ownerId: true } })).ownerId;
    const dealOwner = async (dealId: string) =>
        (await owner.opportunity.findUniqueOrThrow({ where: { id: dealId }, select: { ownerId: true } })).ownerId;
    const run = (apply: boolean, batch?: number) => releaseDepartedOwners(app, workspace, { apply, batch });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const adminEmail = `rdo-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Rdo ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;
        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const manager = roles.find((r) => r.name === 'manager')!.id;
        const benEmail = `rdo-ben-${stamp}@example.test`;
        const invite = await as(admin).post(w('/invites')).send({ email: benEmail, roleId: manager }).expect(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password })
            .expect(201);
        await verifyAddress(app, http, benEmail);
        const ben = browserFrom(joined);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        adminId = members.find((m) => m.email === adminEmail)!.id;
        benId = members.find((m) => m.email === benEmail)!.id;

        const company = async (who: Browser, name: string) =>
            id(
                await as(who)
                    .post(w('/companies'))
                    .send({ name: `${name} ${stamp}`, domain: `${name}-${stamp}.test` })
                    .expect(201),
            );
        const admins = await company(admin, 'admins');
        bens = await company(ben, 'bens');
        atAdmins = id(
            await as(ben)
                .post(w('/people'))
                .send({
                    nameFirst: 'At',
                    emails: { primary: `at@admins-${stamp}.test`, additional: [] },
                    ownerId: benId,
                })
                .expect(201),
        );
        alone = id(
            await as(ben)
                .post(w('/people'))
                .send({ nameFirst: 'Alone', emails: { primary: `alone@nowhere-${stamp}.test`, additional: [] } })
                .expect(201),
        );
        const deal = async (name: string, companyId: string, contact: string) =>
            id(
                await as(ben)
                    .post(w('/opportunities'))
                    .send({ name, currency: 'USD', companyId, pointOfContactId: contact, ownerId: benId })
                    .expect(201),
            );
        dealAtAdmins = await deal('At admins', admins, atAdmins);
        dealAlone = await deal('Alone', bens, alone);
        closed = await deal('Closed', admins, atAdmins);
        // The seed's shape whatever the create rules placed: Ben holds all of it; then Ben leaves.
        await owner.person.updateMany({ where: { id: { in: [atAdmins, alone] } }, data: { ownerId: benId } });
        await owner.person.update({ where: { id: atAdmins }, data: { companyId: admins } });
        await owner.opportunity.updateMany({
            where: { id: { in: [dealAtAdmins, dealAlone, closed] } },
            data: { ownerId: benId },
        });
        await owner.opportunity.update({ where: { id: closed }, data: { closedAt: new Date() } });
        await owner.workspaceMember.update({ where: { id: benId }, data: { leftAt: new Date() } });
    });

    afterAll(async () => {
        await app?.close();
    });

    it('estimates what it would do, changing nothing', async () => {
        const expected = {
            people: 2,
            peopleToCompanyOwner: 1,
            dealsWithPeople: 1,
            peopleReleased: 1,
            deals: 2,
            dealsToCompanyOwner: 1,
            dealsToContactOwner: 0,
            dealsReleased: 1,
            dealsKept: 0,
            failed: 0,
        };
        expect(await run(false)).toEqual(expected);
        expect(await run(false, 1)).toEqual(expected);
        await expect(run(false, 0)).rejects.toThrow('batch');
        expect(await personOwner(atAdmins)).toBe(benId);
    });

    it('moves a person to their company’s owner with the deals held with them; releases the rest', async () => {
        expect(await run(true, 1)).toEqual({
            people: 2,
            peopleToCompanyOwner: 1,
            dealsWithPeople: 1,
            peopleReleased: 1,
            deals: 1,
            dealsToCompanyOwner: 0,
            dealsToContactOwner: 0,
            dealsReleased: 1,
            dealsKept: 0,
            failed: 0,
        });
        expect(await personOwner(atAdmins)).toBe(adminId);
        expect(await dealOwner(dealAtAdmins)).toBe(adminId);
        expect(await personOwner(alone)).toBeNull();
        expect(await dealOwner(dealAlone), 'its company is the departed member’s: nobody').toBeNull();
        expect(await dealOwner(closed), 'a closed deal is history').toBe(benId);
        const moved = await owner.ownershipTransfer.findFirstOrThrow({
            where: { object: 'person', recordId: atAdmins },
        });
        expect(moved).toMatchObject({
            fromMemberId: benId,
            toMemberId: adminId,
            status: 'forced',
            reason: TRANSFER_REASON_DEPARTED_TO_COMPANY_OWNER,
        });
        expect(await owner.notification.count({ where: { transferId: moved.id } })).toBe(0);
    });

    it('re-running changes nothing', async () => {
        const none = {
            people: 0,
            peopleToCompanyOwner: 0,
            dealsWithPeople: 0,
            peopleReleased: 0,
            deals: 0,
            dealsToCompanyOwner: 0,
            dealsToContactOwner: 0,
            dealsReleased: 0,
            dealsKept: 0,
            failed: 0,
        };
        expect(await run(false)).toEqual(none);
        expect(await run(true)).toEqual(none);
    });

    it('--deals-of hands an active member’s open deals on by the same rule, keeping those it gives back', async () => {
        // The admin's deal at a company nobody active owns, its contact nobody's: released. The admin's deal at their
        // own company (moved with its contact above): the rule gives it back, so it is kept.
        const orphan = id(
            await as(admin)
                .post(w('/opportunities'))
                .send({ name: 'Orphan', currency: 'USD', companyId: bens, pointOfContactId: alone, ownerId: adminId })
                .expect(201),
        );
        await owner.opportunity.update({ where: { id: orphan }, data: { ownerId: adminId } });
        const of = (apply: boolean) => releaseDepartedOwners(app, workspace, { apply, dealsOf: adminId });
        const expected = {
            people: 0,
            peopleToCompanyOwner: 0,
            dealsWithPeople: 0,
            peopleReleased: 0,
            deals: 2,
            dealsToCompanyOwner: 0,
            dealsToContactOwner: 0,
            dealsReleased: 1,
            dealsKept: 1,
            failed: 0,
        };
        expect(await of(false)).toEqual(expected);
        expect(await dealOwner(orphan)).toBe(adminId);
        expect(await of(true)).toEqual(expected);
        expect(await dealOwner(orphan)).toBeNull();
        expect(await dealOwner(dealAtAdmins)).toBe(adminId);
        expect(await personOwner(atAdmins), 'people are not touched').toBe(adminId);
        expect(await of(true)).toMatchObject({ deals: 1, dealsReleased: 0, dealsKept: 1 });
        await expect(releaseDepartedOwners(app, workspace, { apply: false, dealsOf: benId })).rejects.toThrow(
            'active member',
        );
    });
});
