import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    type NotificationsView,
    type OwnershipConflictView,
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
 * Company-domain ownership (OWN-2, #201): whoever saves a company first owns its leads. Another member who
 * saves a person at it — by its domain, or by naming it — is refused by name and may save the lead for the
 * owner instead; a deal with it is the owner's; its domain cannot be taken by a second company. Account
 * managers who see only their own records are told whose it is all the same.
 */
describe('OWN-2 company-domain ownership (FR-CRMS-20)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `ortiz-${stamp}.test`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let mia: Browser;
    let workspace: string;
    let anaId: string;
    let benId: string;
    let company: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const person = (local: string, extra: Record<string, unknown> = {}) => ({
        nameFirst: local,
        emails: { primary: `${local}@${domain}`, additional: [] },
        ...extra,
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);

        const adminEmail = `own2-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Own2 ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        // Account managers see only their own records — the case the rule must still reach.
        const am = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'account manager',
                recordScope: 'own',
                capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit'],
            })
            .expect(201);
        const join = async (email: string, roleId: string) => {
            const invite = await as(admin).post(w('/invites')).send({ email, roleId }).expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(`own2-ana-${stamp}@example.test`, (am.body as { id: string }).id);
        ben = await join(`own2-ben-${stamp}@example.test`, (am.body as { id: string }).id);
        mia = await join(`own2-mia-${stamp}@example.test`, roles.find((r) => r.name === 'manager')!.id);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === `own2-ana-${stamp}@example.test`)!.id;
        benId = members.find((m) => m.email === `own2-ben-${stamp}@example.test`)!.id;

        company = (
            (
                await as(ana)
                    .post(w('/companies'))
                    .send({ name: `Ortiz ${stamp}`, domain })
                    .expect(201)
            ).body as { id: string }
        ).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('FR-CRMS-20: the owner’s person at the company’s domain is linked to it', async () => {
        const res = await as(ana).post(w('/people')).send(person('dana')).expect(201);
        expect(res.body).toMatchObject({ companyId: company, ownerId: anaId });
    });

    it('FR-CRMS-20: another member saving a person at that domain is refused, by name, though they cannot see the company', async () => {
        const res = await as(ben).post(w('/people')).send(person('sam'));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            code: 'conflict.company_owned',
            details: { companyId: company, ownerMemberId: anaId },
        });
        expect((res.body as { message: string }).message).toContain(`Ortiz ${stamp}`);
    });

    it('FR-CRMS-20: a free-mail address is nobody’s company, and is saved as usual', async () => {
        await as(ben)
            .post(w('/people'))
            .send({ nameFirst: 'Lee', emails: { primary: `lee-${stamp}@gmail.com`, additional: [] } })
            .expect(201);
    });

    it('FR-CRMS-20: “save for the owner” makes the person the owner’s, at the company, and tells them', async () => {
        const res = await as(ben)
            .post(w('/people'))
            .send(person('sam', { handToOwner: true }));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body).toMatchObject({ ownerId: anaId, companyId: company });
        await settle(app);
        const bell = (await as(ana).get(w('/notifications')).expect(200)).body as NotificationsView;
        const told = bell.items.find((n) => n.kind === 'transfer_received');
        expect(told?.transfer?.recordId).toBe((res.body as { id: string }).id);
        const history = (
            await as(ana)
                .get(w(`/transfers?object=person&recordId=${(res.body as { id: string }).id}`))
                .expect(200)
        ).body as TransferView[];
        expect(history[0]).toMatchObject({ status: 'forced', from: { memberId: benId }, to: { memberId: anaId } });
    });

    it('FR-CRMS-20: a second company with the domain, or a domain the company has as its other one, is refused', async () => {
        const dup = await as(ben).post(w('/companies')).send({ name: 'Ortiz again', domain });
        expect(dup.status).toBe(409);
        expect(dup.body).toMatchObject({ code: 'conflict.company_owned' });

        await as(ana)
            .post(w(`/companies/${company}/domains`))
            .send({ domain: `ortiz-${stamp}.co.uk` })
            .expect(201);
        expect(
            (
                await as(ben)
                    .post(w(`/companies/${company}/domains`))
                    .send({ domain: `x-${stamp}.test` })
            ).status,
        ).toBe(404);
        const viaOther = await as(ben)
            .post(w('/people'))
            .send({ nameFirst: 'Kim', emails: { primary: `kim@ortiz-${stamp}.co.uk`, additional: [] } });
        expect(viaOther.status).toBe(409);
        const second = await as(ben)
            .post(w('/companies'))
            .send({ name: 'Ortiz UK', domain: `ortiz-${stamp}.co.uk` });
        expect(second.status).toBe(409);
    });

    it('FR-CRMS-20: a manager places records where they choose, and reads what disagrees with the rule', async () => {
        const placed = await as(mia)
            .post(w('/people'))
            .send(person('raj', { ownerId: benId }));
        expect(placed.status, JSON.stringify(placed.body)).toBe(201);
        expect((await as(ana).get(w('/ownership/conflicts'))).status).toBe(403);
        const report = (await as(mia).get(w('/ownership/conflicts')).expect(200)).body as OwnershipConflictView[];
        expect(report).toContainEqual(
            expect.objectContaining({
                object: 'person',
                recordId: (placed.body as { id: string }).id,
                companyId: company,
                companyOwnerMemberId: anaId,
                recordOwnerMemberId: benId,
            }),
        );
    });

    it('FR-CRMS-20: a deal with the company is the company owner’s; its contact’s company is the default', async () => {
        const sam = (
            (
                await as(ben)
                    .post(w('/people'))
                    .send({ nameFirst: 'Ola', emails: { primary: `ola-${stamp}@other-${stamp}.test`, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
        const noCompany = await as(ben)
            .post(w('/opportunities'))
            .send({ name: 'Ben deal', currency: 'USD', pointOfContactId: sam });
        expect(noCompany.status, 'OWN-2b: a deal is with a company').toBe(422);
        expect(JSON.stringify(noCompany.body)).toContain('companyId');
        const dana = ((await as(ana).get(w(`/people?q=dana`)).expect(200)).body as { items: { id: string }[] })
            .items[0]!.id;
        const deal = await as(ana)
            .post(w('/opportunities'))
            .send({ name: 'Ortiz deal', currency: 'USD', pointOfContactId: dana });
        expect(deal.status, JSON.stringify(deal.body)).toBe(201);
        expect(deal.body).toMatchObject({ companyId: company, ownerId: anaId });
    });

    it('FR-CRMS-20: a manager resolves conflicts in one step: each record moves to the company’s owner', async () => {
        const before = (await as(mia).get(w('/ownership/conflicts')).expect(200)).body as OwnershipConflictView[];
        const raj = before.find((c) => c.recordOwnerMemberId === benId && c.object === 'person')!;
        expect(raj).toBeDefined();
        const denied = await as(ana)
            .post(w('/ownership/conflicts/resolve'))
            .send({ items: [{ object: 'person', recordId: raj.recordId }] });
        expect(denied.status).toBe(403);
        const res = await as(mia)
            .post(w('/ownership/conflicts/resolve'))
            .send({
                items: [
                    { object: 'person', recordId: raj.recordId },
                    { object: 'person', recordId: company },
                ],
            });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body).toEqual({ resolved: [raj.recordId], skipped: [company] });
        const after = (await as(mia).get(w('/ownership/conflicts')).expect(200)).body as OwnershipConflictView[];
        expect(after.map((c) => c.recordId)).not.toContain(raj.recordId);
        const moved = (
            await as(ana)
                .get(w(`/people/${raj.recordId}`))
                .expect(200)
        ).body as { ownerId: string };
        expect(moved.ownerId).toBe(anaId);
    });

    it('FR-CRMS-20 (OWN-2c): www., any subdomain, a scheme or a path is the same company; domains are stored registrable', async () => {
        for (const variant of [
            `www.${domain}`,
            `uk.${domain}`,
            `https://mail.${domain}/about`,
            `HTTP://${domain.toUpperCase()}`,
        ]) {
            const res = await as(ben).post(w('/companies')).send({ name: 'Ortiz again', domain: variant });
            expect(res.status, variant).toBe(409);
            expect(res.body).toMatchObject({ code: 'conflict.company_owned', details: { companyId: company } });
        }
        const fresh = await as(ana)
            .post(w('/companies'))
            .send({ name: `Fresh ${stamp}`, domain: `https://eu.Fresh-${stamp}.test/` })
            .expect(201);
        expect((fresh.body as { domain: string }).domain).toBe(`fresh-${stamp}.test`);
    });

    it('FR-CRMS-20 (OWN-2c): a person writing from a subdomain is at the company', async () => {
        const res = await as(ben)
            .post(w('/people'))
            .send({ nameFirst: 'Ute', emails: { primary: `ute@eu.${domain}`, additional: [] } });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'conflict.company_owned', details: { companyId: company } });
    });
});
