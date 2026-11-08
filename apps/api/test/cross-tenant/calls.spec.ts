import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { QUO_API, QuoApiError, type QuoApi, type QuoCall } from '../../src/calls/quo.port';
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

const KEY = Buffer.from('calls-spec-signing-key-32-bytes!').toString('base64');

/** Asks again, briefly, for what a consumer writes after the request was answered; the last answer when it never comes. */
async function eventually<T>(read: () => Promise<T | null>, tries = 40, gapMs = 250): Promise<T | null> {
    let last: T | null = null;
    for (let i = 0; i < tries; i += 1) {
        last = await read();
        if (last !== null) return last;
        await new Promise((r) => setTimeout(r, gapMs));
    }
    return last;
}

/** Quo as the suite sees it: the admin's user, one webhook, and the calls the test puts there. */
class FakeQuo implements QuoApi {
    calls = new Map<string, QuoCall>();
    deleted: string[] = [];
    constructor(private readonly adminEmail: string) {}
    async listUsers(apiKey: string) {
        if (apiKey !== 'quo-key-good') throw new QuoApiError('unauthorized', 'refused');
        return [
            { id: 'US-admin', email: this.adminEmail, firstName: 'Ad', lastName: 'Min' },
            { id: 'US-stranger', email: 'stranger@quo.example', firstName: 'S', lastName: 'T' },
        ];
    }
    async createWebhook() {
        return { id: 'WH1', key: `whsec_${KEY}` };
    }
    async deleteWebhook(_k: string, id: string) {
        this.deleted.push(id);
    }
    async getCall(_k: string, id: string) {
        return this.calls.get(id) ?? null;
    }
    async listRecordings() {
        return [{ url: 'https://recordings.example/r1.mp3', duration: 90 }];
    }
    async listTranscripts() {
        return [{ dialogue: [{ userId: 'US-admin', content: 'Hello Dana', start: 0, end: 2 }] }];
    }
}

describe('CALL-1 calls with Quo', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `call-admin-${stamp}@example.com`;
    const quo = new FakeQuo(adminEmail);
    let admin: Browser;
    let workspace: string;
    let personId: string;
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const deliver = (body: unknown, key = KEY, at = new Date()) => {
        const raw = JSON.stringify(body);
        const id = `msg_${Math.random().toString(36).slice(2)}`;
        const ts = String(Math.floor(at.getTime() / 1000));
        const sig = createHmac('sha256', Buffer.from(key, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
        return http()
            .post(w('/inbound/quo'))
            .set('content-type', 'application/json')
            .set('webhook-id', id)
            .set('webhook-timestamp', ts)
            .set('webhook-signature', `v1,${sig}`)
            .send(raw);
    };
    const quoCall = (id: string, over: Partial<QuoCall> = {}): QuoCall => ({
        id,
        direction: 'outgoing',
        status: 'completed',
        phoneNumberId: 'PN1',
        actorId: 'US-admin',
        participants: [
            { phoneNumber: '+14155550100', actorId: 'US-admin' },
            { phoneNumber: '+447700900123', actorId: null },
        ],
        createdAt: new Date().toISOString(),
        answeredAt: new Date().toISOString(),
        completedAt: new Date(Date.now() + 90_000).toISOString(),
        duration: 90,
        summary: null,
        voicemail: null,
        ...over,
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(QUO_API)
            .useValue(quo)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Calls ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;
        const person = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Reyes',
                emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
                phones: { primary: { number: '07700900123', countryCode: 'GB' }, additional: [] },
            });
        expect(person.status, JSON.stringify(person.body)).toBe(201);
        personId = (person.body as { id: string }).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('links Quo with a working key: webhook registered, members matched by email, strangers listed', async () => {
        expect((await as(admin).put(w('/integrations/quo')).send({ apiKey: 'quo-key-bad-1234' })).status).toBe(400);
        const res = await as(admin).put(w('/integrations/quo')).send({ apiKey: 'quo-key-good' });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({
            configured: true,
            webhookRegistered: true,
            unmatchedQuoEmails: ['stranger@quo.example'],
        });
        expect((res.body as { matchedMemberIds: string[] }).matchedMemberIds).toHaveLength(1);
        const member = await owner.workspaceMember.findFirstOrThrow({ where: { workspaceId: workspace } });
        expect(member.quoUserId).toBe('US-admin');
    });

    it('refuses a delivery not signed with the webhook’s key, or signed too long ago', async () => {
        quo.calls.set('AC-bad', quoCall('AC-bad'));
        const body = { type: 'call.completed', data: { resource: { id: 'AC-bad' } } };
        expect((await deliver(body, Buffer.from('other').toString('base64'))).status).toBe(401);
        expect((await deliver(body, KEY, new Date(Date.now() - 10 * 60_000))).status).toBe(401);
        expect(await owner.call.count({ where: { workspaceId: workspace } })).toBe(0);
    });

    it('records Quo’s call on the person whose number it was, by the member who made it, on the timeline', async () => {
        quo.calls.set('AC1', quoCall('AC1'));
        const res = await deliver({ type: 'call.completed', data: { resource: { id: 'AC1' } } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toEqual({ result: 'recorded' });
        const call = await owner.call.findFirstOrThrow({ where: { workspaceId: workspace, externalId: 'AC1' } });
        expect(call).toMatchObject({
            provider: 'quo',
            personId,
            direction: 'outbound',
            status: 'answered',
            durationSec: 90,
            toNumber: '+447700900123',
        });
        expect(call.memberId).not.toBeNull();
        // A redelivery changes nothing new; a recording then updates the same row.
        expect((await deliver({ type: 'call.completed', data: { resource: { id: 'AC1' } } })).body).toEqual({
            result: 'updated',
        });
        expect((await deliver({ type: 'call.recording.completed', data: { resource: { id: 'AC1' } } })).body).toEqual({
            result: 'updated',
        });
        const after = await owner.call.findUniqueOrThrow({ where: { id: call.id } });
        expect(after.recordings).toEqual([{ url: 'https://recordings.example/r1.mp3', durationSec: 90 }]);
        expect(await owner.call.count({ where: { workspaceId: workspace, externalId: 'AC1' } })).toBe(1);
        // The timeline is written by the outbox consumer a moment after the delivery was answered.
        const kinds = await eventually(async () => {
            const timeline = await as(admin)
                .get(w(`/timeline?targetType=person&targetId=${personId}&kinds=linked-call`))
                .expect(200);
            const found = ((timeline.body as { items: { kind: string }[] }).items ?? []).map((i) => i.kind);
            return found.includes('linked-call.logged') && found.includes('linked-call.updated') ? found : null;
        });
        expect(kinds).toContain('linked-call.logged');
        expect(kinds).toContain('linked-call.updated');
    });

    it('a call logged from the panel is claimed by Quo’s report of it, keeping the outcome and the note', async () => {
        const logged = await as(admin)
            .post(w('/calls'))
            .send({
                personId,
                direction: 'outbound',
                disposition: 'callback',
                durationSec: 60,
                note: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wants a call Tuesday' }] }],
                },
            });
        expect(logged.status, JSON.stringify(logged.body)).toBe(201);
        const { id, noteId } = logged.body as { id: string; noteId: string | null };
        expect(noteId).not.toBeNull();
        quo.calls.set('AC2', quoCall('AC2'));
        expect((await deliver({ type: 'call.completed', data: { resource: { id: 'AC2' } } })).body).toEqual({
            result: 'updated',
        });
        const row = await owner.call.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({
            provider: 'quo',
            externalId: 'AC2',
            disposition: 'callback',
            noteId,
            durationSec: 90,
        });
        expect(await owner.call.count({ where: { workspaceId: workspace, externalId: 'AC2' } })).toBe(1);
        const list = await as(admin)
            .get(w(`/calls?personId=${personId}`))
            .expect(200);
        expect((list.body as { id: string }[]).map((c) => c.id)).toContain(id);
    });

    it('a call to a number nobody has is kept with no person; unlinking deletes the webhook at Quo', async () => {
        quo.calls.set(
            'AC3',
            quoCall('AC3', {
                participants: [
                    { phoneNumber: '+14155550100', actorId: 'US-admin' },
                    { phoneNumber: '+15559990000', actorId: null },
                ],
            }),
        );
        expect((await deliver({ type: 'call.completed', data: { resource: { id: 'AC3' } } })).body).toEqual({
            result: 'recorded',
        });
        expect(
            (await owner.call.findFirstOrThrow({ where: { workspaceId: workspace, externalId: 'AC3' } })).personId,
        ).toBeNull();
        await http()
            .delete(w('/integrations/quo'))
            .set('Cookie', admin.cookie)
            .set(CSRF_HEADER, admin.csrf)
            .expect(204);
        expect(quo.deleted).toContain('WH1');
        expect((await deliver({ type: 'call.completed', data: { resource: { id: 'AC3' } } })).status).toBe(404);
    });
});
