import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { BYLINE_API } from '../../src/byline/byline-api.port';
import { EnrichmentRunner } from '../../src/enrichment/enrichment-runner';
import { PrismaService } from '../../src/infra/prisma.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { FakeByline } from '../support/fake-byline';
import { FakeDns } from '../support/fake-dns';
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
 * BYL-2 (#208): BylineAI behind the enrichment source port (P4-2, FR-CRMS-15) and the verifier port (FR-CRMS-16),
 * asked with the workspace's own API key (sealed, never shown back). Budgets are BylineAI's: a spent one is surfaced
 * as BylineAI said it — a failed enrichment answer, a verification that falls back to the free layer. A workspace's
 * key never asks for another's records.
 */
describe('BYL-2 BylineAI enrichment and verification adapters (FR-CRMS-15, FR-CRMS-16)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let runner: EnrichmentRunner;
    const byline = new FakeByline();
    const dns = new FakeDns();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let a: Browser;
    let b: Browser;
    let wsA: string;
    let wsB: string;
    let personA: string;
    let personB: string;
    const keyA = `key-a-${stamp}`;
    const keyB = `key-b-${stamp}`;
    const addressA = `dana@acme-${stamp}.test`;
    const addressB = `lee@globex-${stamp}.test`;

    const w = (path: string, id: string) => `/api/w/${id}${path}`;
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });

    beforeAll(async () => {
        dns.setMx(`acme-${stamp}.test`, `mx.acme-${stamp}.test`);
        dns.setMx(`globex-${stamp}.test`, `mx.globex-${stamp}.test`);
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(BYLINE_API)
            .useValue(byline)
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        runner = app.get(EnrichmentRunner);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: a, id: wsA } = await signUp(`byl2-a-${stamp}@example.com`, `Byl2 A ${stamp}`));
        ({ browser: b, id: wsB } = await signUp(`byl2-b-${stamp}@example.com`, `Byl2 B ${stamp}`));
        const newPerson = async (who: Browser, ws: string, email: string) =>
            (
                (
                    await as(who)
                        .post(w('/people', ws))
                        .send({ nameFirst: 'Test', emails: { primary: email, additional: [] } })
                        .expect(201)
                ).body as { id: string }
            ).id;
        personA = await newPerson(a, wsA, addressA);
        personB = await newPerson(b, wsB, addressB);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('the API link, an admin’s', () => {
        it('needs the key with a first address, and the API before verification', async () => {
            await as(a).put(w('/integrations/byline', wsA)).send({ baseUrl: 'https://byline-a.test' }).expect(400);
            await as(a).put(w('/integrations/byline', wsA)).send({ verifyWithByline: true }).expect(400);
        });

        it('keeps the key sealed and never shows it back; a link may be the API alone', async () => {
            const res = await as(a)
                .put(w('/integrations/byline', wsA))
                .send({ baseUrl: 'https://byline-a.test/some/path', apiKey: keyA, verifyWithByline: true })
                .expect(200);
            expect(res.body).toMatchObject({
                configured: false,
                apiConfigured: true,
                baseUrl: 'https://byline-a.test',
                verifyWithByline: true,
            });
            expect(JSON.stringify(res.body)).not.toContain(keyA);
            const row = await owner.bylineSettings.findUniqueOrThrow({ where: { workspaceId: wsA } });
            expect(row.apiKeyCiphertext).not.toContain(keyA);
            await as(b)
                .put(w('/integrations/byline', wsB))
                .send({ baseUrl: 'https://byline-b.test', apiKey: keyB })
                .expect(200);
        });
    });

    describe('verification (the Verifier port)', () => {
        it('asks BylineAI with the workspace’s key when it is on', async () => {
            byline.verdicts.set(addressA, { verdict: 'valid', reason: null, provider: 'reacher' });
            const res = await as(a)
                .post(w(`/people/${personA}/verification`, wsA))
                .expect(200);
            expect(res.body).toMatchObject({ result: 'valid', source: 'byline' });
            expect(byline.asks.at(-1)).toMatchObject({ kind: 'verify', email: addressA, apiKey: keyA });
        });

        it('stays with the free layer when it is off, and never sends another workspace’s key', async () => {
            const before = byline.asks.length;
            const res = await as(b)
                .post(w(`/people/${personB}/verification`, wsB))
                .expect(200);
            expect(res.body).toMatchObject({ source: 'free' });
            expect(byline.asks.length).toBe(before);
        });

        it('a spent BylineAI budget falls back to the free layer, saying so', async () => {
            byline.spend();
            try {
                const res = await as(a)
                    .post(w(`/people/${personA}/verification`, wsA))
                    .expect(200);
                expect(res.body).toMatchObject({ source: 'free', result: 'valid' });
                expect((res.body as { message: string }).message).toContain('budget');
            } finally {
                byline.refusal = null;
            }
        });

        it('one workspace cannot verify another’s person', async () => {
            await as(b)
                .post(w(`/people/${personA}/verification`, wsB))
                .expect(404);
        });
    });

    describe('enrichment (the EnrichmentSource port)', () => {
        it('records BylineAI’s answers as source byline, asked with the workspace’s key', async () => {
            byline.enrichments.set(addressA, {
                email: addressA,
                person: {
                    firstName: 'Dana',
                    lastName: null,
                    jobTitle: null,
                    country: 'gb',
                    linkedinUrl: null,
                    avatarUrl: null,
                },
                company: null,
                confidence: 0.9,
            });
            const report = await runner.enrich(wsA, 'person', personA, { force: true });
            expect(report.asked).toContain('byline');
            expect(byline.asks.at(-1)).toMatchObject({ kind: 'enrich', email: addressA, apiKey: keyA });
            const answer = await owner.enrichmentAnswer.findFirst({
                where: { workspaceId: wsA, recordId: personA, source: 'byline', field: 'country' },
                orderBy: { askedAt: 'desc' },
            });
            expect(answer).toMatchObject({ status: 'answered', value: 'GB' });
            await runner.enrich(wsB, 'person', personB, { force: true });
            expect(byline.asks.at(-1)).toMatchObject({ kind: 'enrich', email: addressB, apiKey: keyB });
        });

        it('a spent budget is a failed answer with BylineAI’s reason', async () => {
            byline.spend();
            try {
                await runner.enrich(wsA, 'person', personA, { force: true });
            } finally {
                byline.refusal = null;
            }
            const answer = await owner.enrichmentAnswer.findFirst({
                where: { workspaceId: wsA, recordId: personA, source: 'byline', field: 'country' },
                orderBy: { askedAt: 'desc' },
            });
            expect(answer).toMatchObject({ status: 'failed' });
            expect(answer?.note).toContain('budget');
        });
    });
});
