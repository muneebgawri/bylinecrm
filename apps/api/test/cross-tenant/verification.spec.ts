import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    EMAIL_VERIFICATION_DEFAULTS,
    SESSION_COOKIE,
    type EmailVerificationSettingsView,
    type EmailVerificationView,
    type EnrolmentBatchResult,
    type SequenceView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { DNS_PORT } from '../../src/sending-pool/dns.port';
import { SequenceRunner } from '../../src/sequences/sequence-runner';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The free verification layer (P3-5, FR-CRMS-14, FR-CRMS-16) end to end, against the in-memory DNS:
 * the one enrolment check refuses an invalid or unverifiable address and flags a risky one; a result
 * is kept per workspace and address and reused until it is older than the workspace's age (90 days
 * unless set); `unknown` is never kept; the step runner checks again before every send; a person's
 * result can be read and re-run; and one workspace never sees another's results or settings.
 */
describe('FR-CRMS-14 / FR-CRMS-16 email verification', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let runner: SequenceRunner;
    const dns = new FakeDns();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const good = `good-${stamp}.example`;
    let admin: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let seq: SequenceView;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;

    let n = 0;
    async function person(email: string | null, who = admin, ws = workspace): Promise<string> {
        n += 1;
        const res = await as(who)
            .post(w('/people', ws))
            .send({
                nameFirst: `V${n}`,
                nameLast: 'Test',
                source: 'test list',
                country: 'US',
                emails: { primary: email, additional: [] },
            });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return (res.body as { id: string }).id;
    }
    const preview = async (personIds: string[]) => {
        const res = await as(admin)
            .post(w(`/sequences/${seq.id}/enrolments/preview`))
            .send({ personIds });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as EnrolmentBatchResult;
    };
    const stored = (address: string, ws = workspace) =>
        owner.emailVerification.findUnique({ where: { workspaceId_address: { workspaceId: ws, address } } });
    const lookups = () => dns.mxLookups.length;

    beforeAll(async () => {
        dns.setMx(good, `mx.${good}`);
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(DNS_PORT)
            .useValue(dns)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        runner = app.get(SequenceRunner);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`ver-admin-${stamp}@example.com`, `Ver ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `ver-other-${stamp}@example.com`,
            `Other ver ${stamp}`,
        ));
        await as(admin)
            .put(w('/settings/mail'))
            .send({
                postalAddress: { line1: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
                defaultSenderName: null,
                unsubscribeFooterText: 'You received this because we think it is relevant.',
            })
            .expect(200);
        const tpl = await as(admin)
            .post(w('/templates'))
            .send({
                name: 'Intro',
                kind: 'outreach',
                subject: 'Hello',
                body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi.' }] }] },
            });
        expect(tpl.status, JSON.stringify(tpl.body)).toBe(201);
        const created = await as(admin)
            .post(w('/sequences'))
            .send({ name: `Ver ${stamp}`, timeZone: 'UTC', window: { startMinute: 0, endMinute: 1440, days: 127 } });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        seq = created.body as SequenceView;
        await as(admin)
            .put(w(`/sequences/${seq.id}/steps`))
            .send({ steps: [{ kind: 'email', templateId: (tpl.body as { id: string }).id }] })
            .expect(200);
        await as(admin)
            .post(w(`/sequences/${seq.id}/activate`))
            .expect(200);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('FR-CRMS-14 (#165): the one enrolment check refuses an invalid, disposable or unverifiable address, flags a role address, and enrols a valid one', async () => {
        dns.setMx(`web-${stamp}.example`);
        dns.setMx(`null-${stamp}.example`, '.');
        dns.setMx('mailinator.com', 'mx.mailinator.com');
        dns.setMx(`down-${stamp}.example`, `mx.down-${stamp}.example`);
        dns.failMx(`down-${stamp}.example`);
        const valid = await person(`jane-${stamp}@${good}`);
        const noDomain = await person(`jane-${stamp}@gone-${stamp}.example`);
        const noMx = await person(`jane-${stamp}@web-${stamp}.example`);
        const nullMx = await person(`jane-${stamp}@null-${stamp}.example`);
        const disposable = await person(`jane-${stamp}@mailinator.com`);
        const role = await person(`info@${good}`);
        const unverifiable = await person(`jane-${stamp}@down-${stamp}.example`);

        const all = [valid, noDomain, noMx, nullMx, disposable, role, unverifiable];
        const result = await preview(all);
        const enrolled = await as(admin)
            .post(w(`/sequences/${seq.id}/enrolments`))
            .send({ personIds: all });
        expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
        // The preview is the decision the enrol makes.
        expect(enrolled.body).toEqual(result);

        expect(result.enrolled.sort()).toEqual([valid, role].sort());
        const reason = (id: string) => result.refused.find((r) => r.personId === id);
        expect(reason(noDomain)).toMatchObject({
            code: 'email.invalid',
            message: expect.stringContaining('No such domain'),
        });
        expect(reason(noMx)).toMatchObject({ code: 'email.invalid', message: expect.stringContaining('mail server') });
        expect(reason(nullMx)).toMatchObject({ code: 'email.invalid' });
        // #165: a throwaway inbox is never worth a cold email — refused, not warned about.
        expect(reason(disposable)).toMatchObject({
            code: 'email.invalid',
            message: expect.stringContaining('mailinator.com'),
        });
        // `unknown` is not valid and does not enrol.
        expect(reason(unverifiable)).toMatchObject({
            code: 'email.unverified',
            message: expect.stringContaining('Could not verify'),
        });
        expect(result.warnings).toEqual([
            { personId: role, code: 'email.risky', message: expect.stringContaining('info@') },
        ]);
        expect(await stored(`jane-${stamp}@${good}`)).toMatchObject({ result: 'valid', source: 'free' });
    });

    it('FR-CRMS-14: a result is kept per address and reused — a second check asks DNS nothing', async () => {
        const address = `reuse-${stamp}@${good}`;
        const a = await person(address);
        await preview([a]);
        const before = lookups();
        const again = await preview([a]);
        expect(again.enrolled).toEqual([a]);
        expect(lookups()).toBe(before);
    });

    it('FR-CRMS-14: a result older than the workspace’s age (90 days unless set) is stale and re-run before the next check', async () => {
        const address = `stale-${stamp}@${good}`;
        const a = await person(address);
        await preview([a]);
        const initial = await as(admin).get(w('/outreach/verification'));
        expect(initial.status).toBe(200);
        expect(initial.body).toEqual({
            maxAgeDays: EMAIL_VERIFICATION_DEFAULTS.maxAgeDays,
            isDefault: true,
            updatedAt: null,
        });
        expect(EMAIL_VERIFICATION_DEFAULTS.maxAgeDays).toBe(90);

        // 60 days old: fresh under the default, no new lookup.
        await owner.emailVerification.update({
            where: { workspaceId_address: { workspaceId: workspace, address } },
            data: { verifiedAt: new Date(Date.now() - 60 * DAY_MS) },
        });
        let before = lookups();
        await preview([a]);
        expect(lookups()).toBe(before);

        // The workspace shortens the age to 30 days: now stale, and the domain has gone meanwhile.
        const set = await as(admin).put(w('/outreach/verification')).send({ maxAgeDays: 30 });
        expect(set.status, JSON.stringify(set.body)).toBe(200);
        expect(set.body).toMatchObject({ maxAgeDays: 30, isDefault: false });
        expect((set.body as EmailVerificationSettingsView).updatedAt).not.toBeNull();
        dns.noDomain(good);
        before = lookups();
        const result = await preview([a]);
        expect(lookups()).toBe(before + 1);
        expect(result.refused).toEqual([{ personId: a, code: 'email.invalid', message: expect.any(String) }]);
        expect(await stored(address)).toMatchObject({ result: 'invalid', reason: 'no_domain' });
        dns.setMx(good, `mx.${good}`);

        // Out of range or not a number: refused with the field named.
        for (const bad of [0, 366, 1.5, 'soon']) {
            const res = await as(admin).put(w('/outreach/verification')).send({ maxAgeDays: bad });
            expect(res.status, String(bad)).toBe(400);
            expect(JSON.stringify(res.body)).toContain('maxAgeDays');
        }
        await as(admin).put(w('/outreach/verification')).send({ maxAgeDays: 90 }).expect(200);
    });

    it('FR-CRMS-14: an unknown result is never kept — the next check asks again', async () => {
        const domain = `flaky-${stamp}.example`;
        const address = `jane-${stamp}@${domain}`;
        dns.setMx(domain, `mx.${domain}`);
        dns.failMx(domain);
        const a = await person(address);
        expect((await preview([a])).refused[0]).toMatchObject({ code: 'email.unverified' });
        expect(await stored(address)).toMatchObject({ result: 'unknown', reason: 'lookup_failed' });
        dns.failMx(domain, false);
        const before = lookups();
        expect((await preview([a])).enrolled).toEqual([a]);
        expect(lookups()).toBe(before + 1);
        expect(await stored(address)).toMatchObject({ result: 'valid' });
    });

    it('FR-CRMS-14: the runner checks again before an email step — an address gone invalid stops the enrolment; one it cannot verify is tried later', async () => {
        const domain = `later-${stamp}.example`;
        dns.setMx(domain, `mx.${domain}`);
        const a = await person(`jane-${stamp}@${domain}`);
        const b = await person(`john-${stamp}@${domain}`);
        const enrolled = await as(admin)
            .post(w(`/sequences/${seq.id}/enrolments`))
            .send({ personIds: [a, b] });
        expect((enrolled.body as EnrolmentBatchResult).enrolled.sort()).toEqual([a, b].sort());
        const enrolmentOf = (personId: string) =>
            owner.sequenceEnrolment.findUniqueOrThrow({
                where: { sequenceId_personId: { sequenceId: seq.id, personId } },
            });

        // Fresh result, nothing to re-run: the step goes on to the pool (none connected here → rescheduled).
        const now = new Date();
        expect(await runner.run(workspace, (await enrolmentOf(a)).id, now)).toBe('rescheduled');

        // The result aged past the workspace's limit and the domain is gone: the step stops the enrolment.
        await owner.emailVerification.updateMany({
            where: { workspaceId: workspace, address: { endsWith: `@${domain}` } },
            data: { verifiedAt: new Date(Date.now() - 100 * DAY_MS) },
        });
        dns.noDomain(domain);
        const ea = await enrolmentOf(a);
        expect(await runner.run(workspace, ea.id, ea.nextRunAt!)).toBe('stopped');
        expect(await enrolmentOf(a)).toMatchObject({
            status: 'stopped',
            stopReason: 'invalid_address',
            stopDetail: expect.stringContaining(domain),
        });

        // DNS cannot answer: the step is tried again later, never dropped and never sent unverified.
        dns.setMx(domain, `mx.${domain}`);
        dns.failMx(domain);
        const eb = await enrolmentOf(b);
        expect(await runner.run(workspace, eb.id, eb.nextRunAt!)).toBe('rescheduled');
        const after = await enrolmentOf(b);
        expect(after.status).toBe('active');
        expect(after.nextRunAt!.getTime()).toBeGreaterThan(eb.nextRunAt!.getTime());
        dns.failMx(domain, false);
    });

    it('FR-CRMS-14: a person’s verification is readable on their record and can be re-run on demand', async () => {
        const address = `read-${stamp}@${good}`;
        const a = await person(address);
        const none = await as(admin).get(w(`/people/${a}/verification`));
        expect(none.status).toBe(200);
        expect(none.body).toEqual({ address, verification: null });

        const ran = await as(admin).post(w(`/people/${a}/verification`));
        expect(ran.status, JSON.stringify(ran.body)).toBe(200);
        const view = ran.body as EmailVerificationView;
        expect(view).toMatchObject({ address, result: 'valid', reason: 'deliverable', source: 'free', stale: false });
        expect(Date.parse(view.verifiedAt)).toBeGreaterThan(Date.now() - 60_000);
        expect((await as(admin).get(w(`/people/${a}/verification`))).body).toEqual({ address, verification: view });

        // Re-running asks again even though the result is fresh.
        const before = lookups();
        await as(admin)
            .post(w(`/people/${a}/verification`))
            .expect(200);
        expect(lookups()).toBe(before + 1);

        const noAddress = await person(null);
        expect((await as(admin).get(w(`/people/${noAddress}/verification`))).body).toEqual({
            address: null,
            verification: null,
        });
        expect((await as(admin).post(w(`/people/${noAddress}/verification`))).status).toBe(409);
        expect((await as(admin).get(w('/people/00000000-0000-4000-8000-000000000000/verification'))).status).toBe(404);
    });

    it('keeps results and settings to their workspace: another workspace neither reads them nor shares them', async () => {
        const address = `shared-${stamp}@${good}`;
        const mine = await person(address);
        await as(admin)
            .post(w(`/people/${mine}/verification`))
            .expect(200);
        await as(admin).put(w('/outreach/verification')).send({ maxAgeDays: 45 }).expect(200);

        expect((await as(otherAdmin).get(w(`/people/${mine}/verification`, otherWorkspace))).status).toBe(404);
        expect((await as(otherAdmin).get(w('/outreach/verification', otherWorkspace))).body).toMatchObject({
            maxAgeDays: 90,
            isDefault: true,
        });
        // The same address in the other workspace is verified for that workspace: its own row, its own lookup.
        const theirs = await person(address, otherAdmin, otherWorkspace);
        const before = lookups();
        await as(otherAdmin)
            .post(w(`/people/${theirs}/verification`, otherWorkspace))
            .expect(200);
        expect(lookups()).toBe(before + 1);
        expect(await owner.emailVerification.count({ where: { address } })).toBe(2);
        expect(await stored(address, otherWorkspace)).toMatchObject({ workspaceId: otherWorkspace });
        await as(admin).put(w('/outreach/verification')).send({ maxAgeDays: 90 }).expect(200);
    });
});
