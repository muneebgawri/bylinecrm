import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { BYLINE_SIGNATURE_HEADER, signWebhook } from '@byline/contract';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
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
 * BYL-1 (#207): BylineAI's WEBHOOK connector posts leads to `/api/w/:id/inbound/byline`, signed with the workspace's
 * secret. A lead is placed by OWN-2: its company's owner, else the round-robin list, else the Leads queue (unowned).
 * Idempotent on `lead_id`; answered in BylineAI's `{status}` shape. Nothing crosses workspaces.
 */
describe('BYL-1 BylineAI lead receiver (FR-CRMS-20 ownership)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const emails = {
        admin: `byl-admin-${stamp}@example.com`,
        ana: `byl-ana-${stamp}@example.com`,
        mia: `byl-mia-${stamp}@example.com`,
        other: `byl-other-${stamp}@example.com`,
    };
    let admin: Browser;
    let ana: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaId: string;
    let miaId: string;
    const secret = `byline-secret-${stamp}`;
    const otherSecret = `byline-other-${stamp}`;

    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const deliver = (body: unknown, { id = workspace, key = secret }: { id?: string; key?: string | null } = {}) => {
        const raw = JSON.stringify(body);
        const req = http().post(w('/inbound/byline', id)).set('content-type', 'application/json');
        if (key) req.set(BYLINE_SIGNATURE_HEADER, signWebhook(key, raw));
        return req.send(raw);
    };
    const lead = (n: string, email: string, extra: Record<string, unknown> = {}) => ({
        lead_id: `lead-${n}-${stamp}`,
        email,
        source_key: 'prweb',
        ...extra,
    });
    const person = (id: string) =>
        owner.person.findUniqueOrThrow({
            where: { id },
            select: { ownerId: true, companyId: true, source: true, jobTitle: true },
        });
    const companyOf = (id: string) =>
        owner.company.findUniqueOrThrow({ where: { id }, select: { ownerId: true, domain: true } });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, id: workspace } = await signUp(emails.admin, `Byl ${stamp}`));
        ({ browser: otherAdmin, id: otherWorkspace } = await signUp(emails.other, `Byl other ${stamp}`));

        const roles = (await as(admin).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const join = async (email: string, role: string) => {
            const invite = await as(admin)
                .post(w('/invites'))
                .send({ email, roleId: roles.find((r) => r.name === role)!.id })
                .expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(emails.ana, SYSTEM_ROLES.member);
        await join(emails.mia, SYSTEM_ROLES.member);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === emails.ana)!.id;
        miaId = members.find((m) => m.email === emails.mia)!.id;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('the link, an admin’s', () => {
        it('needs the secret the first time; is not a member’s to read', async () => {
            await as(admin).put(w('/integrations/byline')).send({}).expect(400);
            await as(ana).get(w('/integrations/byline')).expect(403);
        });

        it('refuses a round-robin member from another workspace', async () => {
            const others = (await as(otherAdmin).get(w('/members', otherWorkspace)).expect(200)).body as {
                id: string;
            }[];
            await as(admin)
                .put(w('/integrations/byline'))
                .send({ secret, roundRobinMemberIds: [others[0]!.id] })
                .expect(400);
        });

        it('keeps the secret encrypted and never shows it back', async () => {
            const res = await as(admin)
                .put(w('/integrations/byline'))
                .send({ secret, roundRobinMemberIds: [anaId, miaId] })
                .expect(200);
            expect(res.body).toMatchObject({ configured: true, roundRobinMemberIds: [anaId, miaId] });
            expect(res.body.webhookUrl).toContain(`/api/w/${workspace}/inbound/byline`);
            expect(JSON.stringify(res.body)).not.toContain(secret);
            const row = await owner.bylineSettings.findUniqueOrThrow({ where: { workspaceId: workspace } });
            expect(row.secretCiphertext).not.toContain(secret);
        });
    });

    describe('a delivery', () => {
        it('unsigned, or signed with another secret, is refused and reads nothing', async () => {
            await deliver(lead('u', `u-${stamp}@nosign.test`), { key: null }).expect(401);
            await deliver(lead('u', `u-${stamp}@nosign.test`), { key: 'not-the-secret-at-all' }).expect(401);
            expect(
                await owner.person.count({ where: { workspaceId: workspace, emailPrimary: `u-${stamp}@nosign.test` } }),
            ).toBe(0);
        });

        it('to a workspace with no link is not found', async () => {
            await deliver(lead('n', `n-${stamp}@x.test`), { id: otherWorkspace }).expect(404);
            await deliver(lead('n', `n-${stamp}@x.test`), { id: 'not-a-uuid' }).expect(404);
        });

        it('that is not a lead is rejected in BylineAI’s shape', async () => {
            const res = await deliver({ lead_id: `bad-${stamp}`, email: 'nope' }).expect(200);
            expect(res.body).toEqual({ status: 'rejected', reason: 'email is missing or malformed' });
        });
    });

    describe('placing a lead (OWN-2)', () => {
        let acmePerson: string;

        it('at a company a member owns: theirs, linked to it, sourced byline:<source_key>', async () => {
            const company = await as(ana)
                .post(w('/companies'))
                .send({ name: `Acme ${stamp}`, domain: `acme-${stamp}.test` })
                .expect(201);
            const res = await deliver(
                lead('acme', `dana@acme-${stamp}.test`, { first_name: 'Dana', last_name: 'Ortiz', country: 'gb' }),
            ).expect(200);
            expect(res.body).toMatchObject({ status: 'ingested' });
            acmePerson = (res.body as { personId: string }).personId;
            expect(await person(acmePerson)).toMatchObject({
                ownerId: anaId,
                companyId: (company.body as { id: string }).id,
                source: 'byline:prweb',
            });
        });

        it('redelivered: duplicate, the same person, nothing new', async () => {
            const res = await deliver(lead('acme', `dana@acme-${stamp}.test`)).expect(200);
            expect(res.body).toEqual({ status: 'duplicate', personId: acmePerson });
            expect(
                await owner.person.count({
                    where: { workspaceId: workspace, emailPrimary: `dana@acme-${stamp}.test` },
                }),
            ).toBe(1);
        });

        it('a new lead for someone already in the CRM: duplicate, owner kept, blanks filled', async () => {
            const res = await deliver(lead('acme-2', `dana@acme-${stamp}.test`, { job_title: 'Editor' })).expect(200);
            expect(res.body).toEqual({ status: 'duplicate', personId: acmePerson });
            expect(await person(acmePerson)).toMatchObject({ ownerId: anaId, jobTitle: 'Editor' });
        });

        it('at companies nobody owns: dealt in turn, each company made and given to its member', async () => {
            const first = await deliver(lead('rr1', `a@one-${stamp}.test`, { company_name: 'One' })).expect(200);
            const second = await deliver(lead('rr2', `b@two-${stamp}.test`)).expect(200);
            const p1 = await person((first.body as { personId: string }).personId);
            const p2 = await person((second.body as { personId: string }).personId);
            expect(new Set([p1.ownerId, p2.ownerId])).toEqual(new Set([anaId, miaId]));
            expect(await companyOf(p1.companyId!)).toEqual({ ownerId: p1.ownerId, domain: `one-${stamp}.test` });

            // The next lead from the first company follows its owner; the turn does not move.
            const again = await deliver(lead('rr3', `c@one-${stamp}.test`)).expect(200);
            expect(await person((again.body as { personId: string }).personId)).toMatchObject({
                ownerId: p1.ownerId,
                companyId: p1.companyId,
            });
            const third = await deliver(lead('rr4', `d@three-${stamp}.test`)).expect(200);
            expect((await person((third.body as { personId: string }).personId)).ownerId).toBe(p1.ownerId);
        });

        it('with no round-robin list, and free mail: unowned, in the Leads queue, no company', async () => {
            await as(admin).put(w('/integrations/byline')).send({ roundRobinMemberIds: [] }).expect(200);
            const res = await deliver(lead('q', `queue.${stamp}@gmail.com`, { source_key: undefined })).expect(200);
            expect(await person((res.body as { personId: string }).personId)).toMatchObject({
                ownerId: null,
                companyId: null,
                source: 'byline',
            });
            const settings = (await as(admin).get(w('/integrations/byline')).expect(200)).body as {
                lastDeliveryResult: string;
            };
            expect(settings.lastDeliveryResult).toBe('ingested');
        });
    });

    describe('across workspaces', () => {
        it('one workspace’s secret does not open another’s receiver, and a lead id is each workspace’s own', async () => {
            await as(otherAdmin)
                .put(w('/integrations/byline', otherWorkspace))
                .send({ secret: otherSecret })
                .expect(200);
            await deliver(lead('x', `x@cross-${stamp}.test`), { key: otherSecret }).expect(401);

            const theirs = await deliver(lead('acme', `dana@acme-${stamp}.test`), {
                id: otherWorkspace,
                key: otherSecret,
            }).expect(200);
            expect(theirs.body).toMatchObject({ status: 'ingested' });
            const theirPerson = (theirs.body as { personId: string }).personId;
            expect((await owner.person.findUniqueOrThrow({ where: { id: theirPerson } })).workspaceId).toBe(
                otherWorkspace,
            );
            // Neither sees the other's person.
            await as(admin)
                .get(w(`/people/${theirPerson}`))
                .expect(404);
            await as(otherAdmin)
                .get(w(`/people/${theirPerson}`, otherWorkspace))
                .expect(200);
            // Nor the other's link.
            await as(otherAdmin).get(w('/integrations/byline')).expect(403);
        });
    });
});
