import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { assignDealOwners, TRANSFER_REASON_DEAL_OWNER_FILL } from '../../src/cli/assign-deal-owners';
import { mergeDuplicateDeals, TRANSFER_REASON_DUPLICATE_DEAL } from '../../src/cli/merge-duplicate-deals';
import { PAGE_TITLE_NAME, renamePageTitleCompanies } from '../../src/cli/rename-page-title-companies';
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
 * Two clean-ups of what the import left: companies named for their site's page title, and open deals with no owner.
 */
describe('clean-up jobs: page-title company names and unowned open deals', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let workspace: string;
    let adminId: string;
    let anaId: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const company = async (name: string, domain?: string) =>
        id(
            await as(admin)
                .post(w('/companies'))
                .send({ name, ...(domain ? { domain } : {}) })
                .expect(201),
        );
    const companyRow = (companyId: string) =>
        owner.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, deletedAt: true } });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const adminEmail = `cuj-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Cuj ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;
        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const manager = roles.find((r) => r.name === 'manager')!.id;
        const anaEmail = `cuj-ana-${stamp}@example.test`;
        const invite = await as(admin).post(w('/invites')).send({ email: anaEmail, roleId: manager }).expect(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password })
            .expect(201);
        await verifyAddress(app, http, anaEmail);
        ana = browserFrom(joined);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        adminId = members.find((m) => m.email === adminEmail)!.id;
        anaId = members.find((m) => m.email === anaEmail)!.id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('knows a page title from a company name', () => {
        for (const name of ['Home', 'Coming Soon', 'Index of /', 'Just another WordPress site', '404 Not Found']) {
            expect(PAGE_TITLE_NAME.test(name), name).toBe(true);
        }
        for (const name of ['Home Depot', 'Welcome Break', 'Acme', 'Test Kitchen Ltd', 'GoDaddy']) {
            expect(PAGE_TITLE_NAME.test(name), name).toBe(false);
        }
    });

    describe('rename-page-title-companies', () => {
        let home: string;
        let nowhere: string;
        let real: string;
        let emptyRelay: string;
        let usedRelay: string;
        const run = (apply: boolean) =>
            renamePageTitleCompanies(app, workspace, {
                apply,
                deleteEmpty: [`relay-empty-${stamp}.test`, `relay-used-${stamp}.test`],
            });
        const expected = { pageTitled: 2, renamed: 1, noDomain: 1, deleted: 1, notEmpty: 1, failed: 0 };

        beforeAll(async () => {
            home = await company('Home', `home-${stamp}.test`);
            nowhere = await company('Coming Soon');
            real = await company(`Acme ${stamp}`, `acme-${stamp}.test`);
            emptyRelay = await company('Relay', `relay-empty-${stamp}.test`);
            usedRelay = await company('Relay too', `relay-used-${stamp}.test`);
            await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'Dana',
                    emails: { primary: `dana-${stamp}@example.test`, additional: [] },
                    companyId: usedRelay,
                })
                .expect(201);
        });

        it('estimates, changing nothing', async () => {
            expect(await run(false)).toEqual(expected);
            expect((await companyRow(home)).name).toBe('Home');
            expect((await companyRow(emptyRelay)).deletedAt).toBeNull();
        });

        it('renames a page-titled company to its domain and deletes a listed company only when it is empty', async () => {
            expect(await run(true)).toEqual(expected);
            expect((await companyRow(home)).name).toBe(`home-${stamp}.test`);
            expect((await companyRow(nowhere)).name, 'no domain to be named for').toBe('Coming Soon');
            expect((await companyRow(real)).name).toBe(`Acme ${stamp}`);
            expect((await companyRow(emptyRelay)).deletedAt).not.toBeNull();
            expect((await companyRow(usedRelay)).deletedAt, 'it has a person').toBeNull();
        });

        it('changes nothing run again', async () => {
            expect(await run(true)).toEqual({ ...expected, pageTitled: 1, renamed: 0, deleted: 0 });
        });
    });

    describe('assign-deal-owners', () => {
        let filled: string;
        let elsewhere: string;
        let orphan: string;
        const run = (apply: boolean) => assignDealOwners(app, workspace, { apply, batch: 1 });
        const dealOwner = async (dealId: string) =>
            (await owner.opportunity.findUniqueOrThrow({ where: { id: dealId }, select: { ownerId: true } })).ownerId;
        let loose: string;
        const expected = {
            deals: 3,
            assigned: 2,
            toCompanyOwner: 1,
            toContactOwner: 1,
            toMemberInMail: 0,
            nobodyToGive: 1,
            owners: 2,
            mostToOne: 1,
            failed: 0,
        };

        beforeAll(async () => {
            const person = async (who: Browser, local: string, companyId: string) =>
                id(
                    await as(who)
                        .post(w('/people'))
                        .send({
                            nameFirst: local,
                            emails: { primary: `${local}-${stamp}@example.test`, additional: [] },
                            companyId,
                        })
                        .expect(201),
                );
            const deal = async (name: string, pointOfContactId: string, companyId: string) => {
                const made = id(
                    await as(admin)
                        .post(w('/opportunities'))
                        .send({ name, currency: 'USD', pointOfContactId, companyId })
                        .expect(201),
                );
                await owner.opportunity.update({ where: { id: made }, data: { ownerId: null } });
                return made;
            };
            // Nobody's company, Ana's contact: the deal is Ana's to have.
            const open = await company(`Open ${stamp}`, `open-${stamp}.test`);
            await owner.company.update({ where: { id: open }, data: { ownerId: null } });
            filled = await deal('Fill me', await person(ana, 'ana-contact', open), open);
            // The admin's company, Ana's contact: a deal with a company is its owner's.
            const admins = await company(`Admins ${stamp}`, `admins-${stamp}.test`);
            elsewhere = await deal('Leave me', await person(ana, 'ana-elsewhere', admins), admins);
            // A contact nobody owns.
            loose = await person(admin, 'loose', open);
            await owner.person.update({ where: { id: loose }, data: { ownerId: null } });
            orphan = await deal('Nobody’s', loose, open);
        });

        it('estimates, changing nothing', async () => {
            expect(await run(false)).toEqual(expected);
            expect(await dealOwner(filled)).toBeNull();
        });

        it('gives an unowned open deal to its contact’s owner, silently and on its ownership history', async () => {
            expect(await run(true)).toEqual(expected);
            expect(await dealOwner(filled)).toBe(anaId);
            expect(await dealOwner(elsewhere), 'the company’s owner').toBe(adminId);
            expect(await dealOwner(orphan)).toBeNull();
            const fill = await owner.ownershipTransfer.findFirstOrThrow({
                where: { object: 'opportunity', recordId: filled },
            });
            expect(fill).toMatchObject({
                fromMemberId: null,
                toMemberId: anaId,
                status: 'forced',
                reason: TRANSFER_REASON_DEAL_OWNER_FILL,
            });
            expect(await owner.notification.count({ where: { transferId: fill.id } })).toBe(0);
        });

        it('changes nothing run again', async () => {
            expect(await run(true)).toEqual({
                ...expected,
                deals: 1,
                assigned: 0,
                toCompanyOwner: 0,
                toContactOwner: 0,
                owners: 0,
                mostToOne: 0,
            });
        });

        it('--by-mail gives a deal nobody could be given, and its contact, to the member in mail with the contact', async () => {
            const byMail = (apply: boolean) => assignDealOwners(app, workspace, { apply, byMailDays: 30 });
            expect(await byMail(false), 'nobody is in mail with them').toMatchObject({ assigned: 0, nobodyToGive: 1 });
            // Ana wrote to the contact last week.
            const sentAt = new Date(Date.now() - 7 * 86_400_000);
            const thread = await owner.mailThread.create({
                data: { workspaceId: workspace, subject: 'Hello', lastMessageAt: sentAt },
            });
            const message = await owner.mailMessage.create({
                data: {
                    workspaceId: workspace,
                    threadId: thread.id,
                    identityKey: `cuj-${stamp}`,
                    direction: 'outbound',
                    fromAddress: `cuj-ana-${stamp}@example.test`,
                    sentAt,
                    subject: 'Hello',
                },
            });
            await owner.mailParticipant.createMany({
                data: [
                    {
                        workspaceId: workspace,
                        messageId: message.id,
                        role: 'from',
                        address: `cuj-ana-${stamp}@example.test`,
                        memberId: anaId,
                    },
                    {
                        workspaceId: workspace,
                        messageId: message.id,
                        role: 'to',
                        address: `loose-${stamp}@example.test`,
                        personId: loose,
                    },
                ],
            });
            expect(await byMail(true)).toMatchObject({ deals: 1, assigned: 1, toMemberInMail: 1, nobodyToGive: 0 });
            expect(await dealOwner(orphan)).toBe(anaId);
            expect(
                (await owner.person.findUniqueOrThrow({ where: { id: loose }, select: { ownerId: true } })).ownerId,
            ).toBe(anaId);
            expect((await byMail(true)).deals).toBe(0);
        });
    });
    describe('merge-duplicate-deals', () => {
        let oldest: string;
        let twin: string;
        let anasTwin: string;
        let worked: string;
        let adminsOwn: string;
        let anasOwn: string;
        const run = (apply: boolean) => mergeDuplicateDeals(app, workspace, { apply });
        const row = (dealId: string) =>
            owner.opportunity.findUniqueOrThrow({ where: { id: dealId }, select: { ownerId: true, deletedAt: true } });
        const expected = {
            groups: 2,
            deals: 6,
            removed: 3,
            keptGivenOwner: 0,
            leftWithContent: 0,
            groupsOfSeveralOwners: 1,
            failed: 0,
        };

        beforeAll(async () => {
            const home = await company(`Dupes ${stamp}`, `dupes-${stamp}.test`);
            await owner.company.update({ where: { id: home }, data: { ownerId: null } });
            const person = async (local: string) =>
                id(
                    await as(admin)
                        .post(w('/people'))
                        .send({
                            nameFirst: local,
                            emails: { primary: `${local}-${stamp}@example.test`, additional: [] },
                            companyId: home,
                        })
                        .expect(201),
                );
            const deal = async (name: string, pointOfContactId: string, ownerId: string | null, daysAgo: number) => {
                const made = id(
                    await as(admin)
                        .post(w('/opportunities'))
                        .send({ name, currency: 'USD', pointOfContactId, companyId: home })
                        .expect(201),
                );
                await owner.opportunity.update({
                    where: { id: made },
                    data: { ownerId, createdAt: new Date(Date.now() - daysAgo * 86_400_000) },
                });
                return made;
            };
            // One contact, one name, four open deals: three nobody's, one Ana's and worked (a task on it).
            const dana = await person('dupe-dana');
            oldest = await deal('Dana Deal', dana, null, 40);
            twin = await deal('dana deal ', dana, null, 30);
            anasTwin = await deal('Dana Deal', dana, anaId, 20);
            worked = await deal('Dana Deal', dana, anaId, 10);
            await as(ana)
                .post(w('/tasks'))
                .send({ title: 'Call Dana', targets: [{ type: 'opportunity', id: worked }] })
                .expect(201);
            // Another contact: the same deal twice, the admin's and Ana's — whose it is is not the job's call.
            const eli = await person('dupe-eli');
            adminsOwn = await deal('Eli Deal', eli, adminId, 5);
            anasOwn = await deal('Eli Deal', eli, anaId, 4);
        });

        it('estimates, changing nothing', async () => {
            expect(await run(false)).toEqual(expected);
            expect((await row(twin)).deletedAt).toBeNull();
        });

        it('keeps the deal that carries something, removes the empty duplicates, leaves a group of several owners', async () => {
            // The one Ana worked is kept; the three empty ones go, hers included.
            expect(await run(true)).toEqual(expected);
            expect((await row(worked)).deletedAt).toBeNull();
            for (const gone of [oldest, twin, anasTwin]) expect((await row(gone)).deletedAt).not.toBeNull();
            expect((await row(adminsOwn)).deletedAt).toBeNull();
            expect((await row(anasOwn)).deletedAt).toBeNull();
        });

        it('gives a kept deal that is nobody’s the one owner its duplicates name', async () => {
            const home = await company(`Dupes two ${stamp}`, `dupes-two-${stamp}.test`);
            await owner.company.update({ where: { id: home }, data: { ownerId: null } });
            const fay = id(
                await as(admin)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Fay',
                        emails: { primary: `dupe-fay-${stamp}@example.test`, additional: [] },
                        companyId: home,
                    })
                    .expect(201),
            );
            const make = async (ownerId: string | null, createdAt: Date) => {
                const made = id(
                    await as(admin)
                        .post(w('/opportunities'))
                        .send({ name: 'Fay Deal', currency: 'USD', pointOfContactId: fay, companyId: home })
                        .expect(201),
                );
                await owner.opportunity.update({ where: { id: made }, data: { ownerId, createdAt } });
                return made;
            };
            const first = await make(null, new Date(Date.now() - 9 * 86_400_000));
            const anas = await make(anaId, new Date(Date.now() - 3 * 86_400_000));
            expect(await run(true)).toMatchObject({ removed: 1, keptGivenOwner: 1, failed: 0 });
            expect(await row(first)).toMatchObject({ ownerId: anaId, deletedAt: null });
            expect((await row(anas)).deletedAt).not.toBeNull();
            const fill = await owner.ownershipTransfer.findFirstOrThrow({
                where: { object: 'opportunity', recordId: first },
            });
            expect(fill).toMatchObject({ toMemberId: anaId, reason: TRANSFER_REASON_DUPLICATE_DEAL });
            expect(await run(true)).toMatchObject({ removed: 0, keptGivenOwner: 0 });
        });
    });
});
