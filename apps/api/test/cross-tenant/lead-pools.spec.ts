import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import { PrismaClient } from '@prisma/client';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { parseEnv } from '../../src/config/env';
import { verifyAddress } from '../support/mail';

interface Browser {
    cookie: string;
    csrf: string;
    workspace: string;
}

function browserFrom(res: Response): Browser {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    const workspace = (res.body as { workspace: { id: string } }).workspace.id;
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf, workspace };
}

/**
 * Lead pools: workspaces sharing one set of leads. A primary email one has as a customer or prospect
 * (the point of contact of an open or won deal) cannot be saved in another, either way round, and the
 * refusal names only the workspace that has it. A cold lead may be saved in both; a lost deal or the
 * trash holds nothing; a workspace outside the pool is untouched.
 */
describe('lead pools', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const pinionName = `Pinion ${stamp}`;
    const lexisName = `Lexis ${stamp}`;
    let pinion: Browser;
    let lexis: Browser;
    let outside: Browser;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(`/api/w/${who.workspace}${path}`).set('Cookie', who.cookie),
        post: (path: string) =>
            http().post(`/api/w/${who.workspace}${path}`).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) =>
            http().patch(`/api/w/${who.workspace}${path}`).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) =>
            http().delete(`/api/w/${who.workspace}${path}`).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const signup = async (who: string, workspaceName: string) => {
        const email = `${who}-${stamp}@example.test`;
        const res = await http().post('/api/auth/signup').send({ email, password, workspaceName }).expect(201);
        await verifyAddress(app, http, email);
        return browserFrom(res);
    };
    const person = (address: string) => ({
        nameFirst: 'Dana',
        nameLast: 'Lead',
        emails: { primary: address, additional: [] },
    });

    /** A person saved with an open deal they are the point of contact of: a prospect. */
    const prospect = async (who: Browser, address: string) => {
        const saved = await as(who).post('/people').send(person(address)).expect(201);
        const personId = (saved.body as { id: string }).id;
        const company = await as(who)
            .post('/companies')
            .send({ name: `Co ${address}` })
            .expect(201);
        const deal = await as(who)
            .post('/opportunities')
            .send({
                name: `Deal ${address}`,
                pointOfContactId: personId,
                companyId: (company.body as { id: string }).id,
            })
            .expect(201);
        return { personId, dealId: (deal.body as { id: string }).id };
    };
    const lostStage = async (who: Browser) => {
        const res = await as(who).get('/pipelines').expect(200);
        const pipelines = res.body as { stages: { id: string; kind: string }[] }[];
        return pipelines[0]!.stages.find((st) => st.kind === 'lost')!.id;
    };

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        pinion = await signup('pinion', pinionName);
        lexis = await signup('lexis', lexisName);
        outside = await signup('outside', `Outside ${stamp}`);
        const pool = await owner.leadPool.create({ data: { name: `pool-${stamp}` } });
        await owner.workspace.updateMany({
            where: { id: { in: [pinion.workspace, lexis.workspace] } },
            data: { leadPoolId: pool.id },
        });
    });

    afterAll(async () => {
        await app.close();
        await owner.$disconnect();
    });

    it("a customer or prospect of one workspace is refused in the other, by the workspace's name only", async () => {
        const address = `held-${stamp}@x.test`;
        await prospect(pinion, address);

        const check = await as(lexis)
            .get(`/people/address-check?email=${encodeURIComponent(address)}`)
            .expect(200);
        expect(check.body).toEqual({
            available: false,
            holder: { ownerName: null, trashed: false, workspaceName: pinionName },
        });
        const refused = await as(lexis).post('/people').send(person(address.toUpperCase())).expect(409);
        expect(JSON.stringify(refused.body)).toContain(`already a lead in ${pinionName}`);
    });

    it('a cold lead may be saved in both', async () => {
        const address = `cold-${stamp}@x.test`;
        await as(pinion).post('/people').send(person(address)).expect(201);
        const check = await as(lexis)
            .get(`/people/address-check?email=${encodeURIComponent(address)}`)
            .expect(200);
        expect(check.body).toEqual({ available: true, holder: null });
        await as(lexis).post('/people').send(person(address)).expect(201);
    });

    it('holds both ways, and on a changed address too', async () => {
        const address = `lexis-first-${stamp}@x.test`;
        await prospect(lexis, address);
        await as(pinion).post('/people').send(person(address)).expect(409);

        const other = await as(pinion)
            .post('/people')
            .send(person(`free-${stamp}@x.test`))
            .expect(201);
        const moved = await as(pinion)
            .patch(`/people/${(other.body as { id: string }).id}`)
            .send({ emails: { primary: address, additional: [] } })
            .expect(409);
        expect(JSON.stringify(moved.body)).toContain(`already a lead in ${lexisName}`);
    });

    it('a lost deal holds nothing', async () => {
        const address = `lost-${stamp}@x.test`;
        const { dealId } = await prospect(pinion, address);
        const lost = await lostStage(pinion);
        await as(pinion)
            .post(`/opportunities/${dealId}/move`)
            .send({ stageId: lost, close: { lostReason: 'went with a competitor' } })
            .expect(201);
        await as(lexis).post('/people').send(person(address)).expect(201);
    });

    it('a workspace outside the pool is untouched', async () => {
        await as(outside)
            .post('/people')
            .send(person(`held-${stamp}@x.test`))
            .expect(201);
        const check = await as(outside)
            .get(`/people/address-check?email=${encodeURIComponent(`lexis-first-${stamp}@x.test`)}`)
            .expect(200);
        expect(check.body).toEqual({ available: true, holder: null });
    });

    it('a person in the trash holds nothing, and comes back only while the address is free', async () => {
        const address = `trashed-${stamp}@x.test`;
        const { personId } = await prospect(pinion, address);
        await as(pinion)
            .delete(`/people/${personId}`)
            .expect((res) => expect(res.status).toBeLessThan(300));

        await prospect(lexis, address);
        const refused = await as(pinion).post(`/people/${personId}/restore`).expect(409);
        expect(JSON.stringify(refused.body)).toContain(`already a lead in ${lexisName}`);
    });
});
