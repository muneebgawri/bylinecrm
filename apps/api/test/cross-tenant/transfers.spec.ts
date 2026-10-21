import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    DOMAIN_EVENT_TYPES,
    SESSION_COOKIE,
    type NotificationsView,
    type TransferView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

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
 * Ownership transfers (OWN-1, #200): a record changes hands only through a transfer. Its owner offers
 * it and the receiver accepts or declines; a manager moves it at once. A company moves with its people
 * and open deals, both parties are told, and the move is announced for integrations.
 */
describe('OWN-1 ownership transfers (FR-CRMS-17) and the manager role (FR-CRMS-18)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let mia: Browser;
    let workspace: string;
    let anaId: string;
    let benId: string;
    let company: string;
    let person: string;
    let deal: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const inbox = async (who: Browser): Promise<NotificationsView> =>
        (await as(who).get(w('/notifications')).expect(200)).body as NotificationsView;
    const ownerOf = async (path: string, who = admin): Promise<string | null> =>
        ((await as(who).get(w(path)).expect(200)).body as { ownerId: string | null }).ownerId;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);

        const adminEmail = `own-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Own ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        const roles = (await as(admin).get(w('/roles')).expect(200)).body as {
            id: string;
            name: string;
            isSystem: boolean;
            capabilities: string[];
        }[];
        const member = roles.find((r) => r.name === 'member')!;
        const manager = roles.find((r) => r.name === 'manager')!;
        expect(manager, 'FR-CRMS-18: a new workspace has a manager system role').toBeDefined();
        expect(manager.isSystem).toBe(true);
        expect(manager.capabilities).toContain('record:transfer');
        expect(member.capabilities).not.toContain('record:transfer');

        const join = async (email: string, roleId: string) => {
            const invite = await as(admin).post(w('/invites')).send({ email, roleId }).expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(`own-ana-${stamp}@example.test`, member.id);
        ben = await join(`own-ben-${stamp}@example.test`, member.id);
        mia = await join(`own-mia-${stamp}@example.test`, manager.id);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === `own-ana-${stamp}@example.test`)!.id;
        benId = members.find((m) => m.email === `own-ben-${stamp}@example.test`)!.id;

        company = (
            (
                await as(ana)
                    .post(w('/companies'))
                    .send({ name: `Ortiz ${stamp}`, domain: `ortiz-${stamp}.test` })
                    .expect(201)
            ).body as { id: string }
        ).id;
        person = (
            (
                await as(ana)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Dana',
                        nameLast: 'Ortiz',
                        emails: { primary: `dana@ortiz-${stamp}.test`, additional: [] },
                        companyId: company,
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
        deal = (
            (
                await as(ana)
                    .post(w('/opportunities'))
                    .send({ name: `Ortiz launch ${stamp}`, currency: 'USD', companyId: company })
                    .expect(201)
            ).body as { id: string }
        ).id;
        await settle(app);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('FR-CRMS-17: a member cannot hand a record over by editing its owner — 422 USE_TRANSFER', async () => {
        const res = await as(ana)
            .patch(w(`/people/${person}`))
            .send({ ownerId: benId });
        expect(res.status).toBe(422);
        expect(JSON.stringify(res.body)).toContain('USE_TRANSFER');
        expect(await ownerOf(`/people/${person}`)).toBe(anaId);
    });

    it('FR-CRMS-17: only the owner may propose; the receiver is told; one open proposal per record', async () => {
        const stranger = await as(ben)
            .post(w('/transfers'))
            .send({ object: 'person', recordId: person, toMemberId: benId });
        expect(stranger.status).toBe(403);

        const proposed = await as(ana)
            .post(w('/transfers'))
            .send({ object: 'person', recordId: person, toMemberId: benId, reason: 'Ben already knows them' });
        expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
        const transfer = proposed.body as TransferView;
        expect(transfer.status).toBe('proposed');
        expect(transfer.from?.memberId).toBe(anaId);
        expect(transfer.moved).toEqual([]);

        const again = await as(ana)
            .post(w('/transfers'))
            .send({ object: 'person', recordId: person, toMemberId: benId });
        expect(again.status).toBe(409);

        const bell = await inbox(ben);
        const told = bell.items.find((n) => n.kind === 'transfer_proposed');
        expect(told?.transfer?.id).toBe(transfer.id);
        expect(told?.transfer?.reason).toBe('Ben already knows them');
        expect(await ownerOf(`/people/${person}`), 'nothing moves until accepted').toBe(anaId);

        // Ana sees her offer; Ben his; a stranger to it sees nothing of it (admins see all).
        expect(((await as(ana).get(w('/transfers')).expect(200)).body as TransferView[]).map((t) => t.id)).toContain(
            transfer.id,
        );
        expect(((await as(ben).get(w('/transfers')).expect(200)).body as TransferView[]).map((t) => t.id)).toContain(
            transfer.id,
        );

        // Only Ben decides.
        expect((await as(ana).post(w(`/transfers/${transfer.id}/accept`))).status).toBe(403);
        const declined = await as(ben)
            .post(w(`/transfers/${transfer.id}/decline`))
            .send({ note: 'Not my patch' });
        expect(declined.status).toBe(201);
        expect((declined.body as TransferView).status).toBe('declined');
        expect((await inbox(ana)).items.some((n) => n.kind === 'transfer_declined')).toBe(true);
        expect((await as(ben).post(w(`/transfers/${transfer.id}/accept`))).status, 'decided once').toBe(409);
    });

    it('FR-CRMS-17: accepting moves the whole unit — the person, their company and its open deals', async () => {
        const proposed = (
            await as(ana)
                .post(w('/transfers'))
                .send({ object: 'person', recordId: person, toMemberId: benId })
                .expect(201)
        ).body as TransferView;
        const accepted = await as(ben).post(w(`/transfers/${proposed.id}/accept`));
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
        const done = accepted.body as TransferView;
        expect(done.status).toBe('accepted');
        expect(done.moved.map((t) => `${t.type}:${t.id}`).sort()).toEqual(
            [`company:${company}`, `person:${person}`, `opportunity:${deal}`].sort(),
        );
        expect(await ownerOf(`/people/${person}`)).toBe(benId);
        expect(await ownerOf(`/companies/${company}`)).toBe(benId);
        expect(await ownerOf(`/opportunities/${deal}`)).toBe(benId);
        expect((await inbox(ana)).items.some((n) => n.kind === 'transfer_accepted')).toBe(true);
        await settle(app);

        // The record's history, and the timeline entry on each moved record.
        const history = (
            await as(ben)
                .get(w(`/transfers?object=person&recordId=${person}`))
                .expect(200)
        ).body as TransferView[];
        expect(history.map((t) => t.status)).toEqual(['accepted', 'declined']);
        const timeline = (
            await as(admin)
                .get(w(`/timeline?target=company:${company}`))
                .expect(200)
        ).body as {
            items: { kind: string }[];
        };
        expect(timeline.items.map((e) => e.kind)).toContain('linked-transfer.completed');
    });

    it('FR-CRMS-17: a record cannot go back to the member it left within the cooling period; the error says when it unlocks', async () => {
        const put = (who: Browser) =>
            http().put(w('/ownership/settings')).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf);
        // The default, readable by any member; only a manager (or admin) changes it.
        expect((await as(ana).get(w('/ownership/settings')).expect(200)).body).toEqual({ transferCoolingDays: 14 });
        expect((await put(ana).send({ transferCoolingDays: 0 })).status).toBe(403);
        expect((await put(mia).send({ transferCoolingDays: 91 })).status).toBe(400);

        // The previous test moved the unit from Ana to Ben. Offering it straight back is refused — the company, and
        // the deal that moved with it.
        const back = await as(ben)
            .post(w('/transfers'))
            .send({ object: 'company', recordId: company, toMemberId: anaId });
        expect(back.status, JSON.stringify(back.body)).toBe(409);
        const body = back.body as {
            code: string;
            message: string;
            details: { unlocksAt: string; coolingDays: number };
        };
        expect(body.code).toBe('conflict.transfer_cooling');
        expect(body.details.coolingDays).toBe(14);
        const unlocks = new Date(body.details.unlocksAt).getTime();
        expect(unlocks).toBeGreaterThan(Date.now() + 13 * 86_400_000);
        expect(unlocks).toBeLessThanOrEqual(Date.now() + 14 * 86_400_000);
        expect(body.message).toContain(body.details.unlocksAt.slice(0, 10));
        expect(
            (await as(ben).post(w('/transfers')).send({ object: 'opportunity', recordId: deal, toMemberId: anaId }))
                .status,
        ).toBe(409);

        // A proposal made while the period was off cannot be accepted by Ana once it is back on.
        await put(mia).send({ transferCoolingDays: 0 }).expect(200);
        const offer = (
            await as(ben)
                .post(w('/transfers'))
                .send({ object: 'opportunity', recordId: deal, toMemberId: anaId })
                .expect(201)
        ).body as TransferView;
        await put(mia).send({ transferCoolingDays: 14 }).expect(200);
        const accept = await as(ana).post(w(`/transfers/${offer.id}/accept`));
        expect(accept.status).toBe(409);
        expect((accept.body as { code: string; message: string }).message).toMatch(/away from you/);
        await as(ben)
            .post(w(`/transfers/${offer.id}/cancel`))
            .send({})
            .expect(201);
        expect(await ownerOf(`/opportunities/${deal}`)).toBe(benId);
    });

    it('FR-CRMS-18: a manager moves a record at once; both parties are told; the transfer says it was forced', async () => {
        const forced = await as(mia)
            .post(w('/transfers'))
            .send({ object: 'company', recordId: company, toMemberId: anaId, reason: 'Rebalancing' });
        expect(forced.status, JSON.stringify(forced.body)).toBe(201);
        const t = forced.body as TransferView;
        expect(t.status).toBe('forced');
        expect(t.decidedAt).not.toBeNull();
        expect(await ownerOf(`/companies/${company}`)).toBe(anaId);
        expect(await ownerOf(`/people/${person}`)).toBe(anaId);
        expect((await inbox(ana)).items.some((n) => n.kind === 'transfer_received' && n.transfer?.id === t.id)).toBe(
            true,
        );
        expect((await inbox(ben)).items.some((n) => n.kind === 'transfer_taken' && n.transfer?.id === t.id)).toBe(true);

        // A manager may also set the owner directly, which the member could not.
        await as(mia)
            .patch(w(`/opportunities/${deal}`))
            .send({ ownerId: benId })
            .expect(200);
        expect(await ownerOf(`/opportunities/${deal}`)).toBe(benId);
    });

    it('announces transfers in the event catalogue, for webhooks and the NewswireOS adapter', () => {
        expect(DOMAIN_EVENT_TYPES).toContain('transfer.completed');
        expect(DOMAIN_EVENT_TYPES).toContain('transfer.proposed');
    });
});
