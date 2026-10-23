import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    REPUTATION_DEFAULTS,
    SESSION_COOKIE,
    SYSTEM_ROLES,
    type RichText,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
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

interface Draft {
    id: string;
    personId: string;
    dealId: string | null;
    content: Record<string, unknown>;
    version: number;
}
interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
    details?: Record<string, unknown>;
}
const body = (...content: object[]): RichText => ({ type: 'doc', content }) as RichText;
const para = (...content: object[]) => ({ type: 'paragraph', content });
const t = (text: string) => ({ type: 'text', text });
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;

/**
 * Composer drafts and cc/bcc to any address, end to end. A draft is its author's alone — another member of the
 * workspace, and another workspace, can neither list, read, save nor discard it — one per composer (a person's,
 * a person's on a deal), saved over a named version (`409` when another tab saved first), and deleted by the send
 * or schedule it was written for, in the send's own transaction; a refused send keeps it. Every cc and bcc
 * address passes the recipient guard (suppression, another member's lead or company) and counts toward the
 * mailbox's budget as `to` does; an address not in the CRM is sent to as it is and never made a person.
 */
describe('mail drafts, and cc/bcc to any address', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const adminEmail = `dr-admin-${stamp}@example.com`;
    const memberEmail = `dr-member-${stamp}@example.com`;
    const otherEmail = `dr-other-${stamp}@example.com`;
    const adminDomain = `adminco-${stamp}.test`;

    let adminMailbox: string;
    let memberMailbox: string;
    let danaId: string;
    let eveAddress: string;
    let dealId: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const err = (res: Response) => res.body as ApiError;

    async function connect(who: Browser, ws: string, email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }

    /** A person; `ownerId: null` is nobody's lead, left out the creator's (the admin's). */
    async function person(first: string, address: string, owned = false): Promise<string> {
        const res = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: first,
                nameLast: 'Test',
                emails: { primary: address, additional: [] },
                ...(owned ? {} : { ownerId: null }),
            });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return (res.body as { id: string }).id;
    }

    async function draft(who: Browser, input: Record<string, unknown>): Promise<Draft> {
        const res = await as(who).post(w('/mail/drafts')).send(input);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body as Draft;
    }

    const message = (extra: Record<string, unknown> = {}, who: Browser = member) =>
        as(who)
            .post(w('/mail/send'))
            .send({
                mailboxId: who === member ? memberMailbox : adminMailbox,
                personId: danaId,
                subject: `Hello ${stamp}`,
                body: body(para(t('Hi.'))),
                ...extra,
            });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Drafts ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other drafts ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        await verifyAddress(app, http, memberEmail);
        member = browserFrom(joined);

        const clientId = `555-dr${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-dr-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        adminMailbox = await connect(admin, workspace, adminEmail);
        memberMailbox = await connect(member, workspace, memberEmail);

        danaId = await person('Dana', `dana-${stamp}@acme.example`);
        // The admin's own lead, and a company whose domain is theirs.
        eveAddress = `eve-${stamp}@elsewhere.example`;
        await person('Eve', eveAddress, true);
        const company = await as(admin)
            .post(w('/companies'))
            .send({ name: `Admin Co ${stamp}`, domain: adminDomain });
        expect(company.status, JSON.stringify(company.body)).toBe(201);
        const deal = await as(admin)
            .post(w('/opportunities'))
            .send({ name: `Deal ${stamp}`, companyId: (company.body as { id: string }).id });
        expect(deal.status, JSON.stringify(deal.body)).toBe(201);
        dealId = (deal.body as { id: string }).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('drafts', () => {
        it('saves the composer’s state, lists it on the person, and keeps it its author’s alone', async () => {
            const content = {
                mailboxId: memberMailbox,
                cc: [{ address: `pat-${stamp}@client.example` }],
                bcc: [{ address: `me-${stamp}@agency.example` }],
                subject: 'Half written',
                body: body(para(t('Dear Dana,'))),
                followUps: [{ sendAt: null, body: body(para(t('Nudge.'))) }],
            };
            const d = await draft(member, { personId: danaId, content });
            expect(d).toMatchObject({ personId: danaId, dealId: null, version: 1, content });

            const mine = await as(member).get(w(`/mail/drafts?target=person:${danaId}`));
            expect(mine.status).toBe(200);
            expect((mine.body as { items: Draft[] }).items.map((x) => x.id)).toEqual([d.id]);

            // Another member of the workspace — an admin — sees nothing of it, and can touch none of it.
            const theirs = await as(admin).get(w(`/mail/drafts?target=person:${danaId}`));
            expect((theirs.body as { items: Draft[] }).items).toEqual([]);
            expect((await as(admin).get(w(`/mail/drafts/${d.id}`))).status).toBe(404);
            expect(
                (
                    await as(admin)
                        .put(w(`/mail/drafts/${d.id}`))
                        .send({ version: 1, content: {} })
                ).status,
            ).toBe(404);
            expect((await as(admin).delete(w(`/mail/drafts/${d.id}`))).status).toBe(404);
            // Another workspace, neither.
            expect((await as(otherAdmin).get(w(`/mail/drafts/${d.id}`, otherWorkspace))).status).toBe(404);
            expect((await as(otherAdmin).delete(w(`/mail/drafts/${d.id}`, otherWorkspace))).status).toBe(404);
            expect((await as(otherAdmin).get(w(`/mail/drafts?target=person:${danaId}`, otherWorkspace))).status).toBe(
                404,
            );

            expect((await as(member).get(w(`/mail/drafts/${d.id}`))).body).toMatchObject({ version: 1, content });
            await as(member)
                .delete(w(`/mail/drafts/${d.id}`))
                .expect(204);
        });

        it('is one per composer: a second for the same person is 409 naming the first; a deal’s is its own', async () => {
            const first = await draft(admin, { personId: danaId, content: { subject: 'One' } });
            const again = await as(admin)
                .post(w('/mail/drafts'))
                .send({ personId: danaId, content: { subject: 'Two' } });
            expect(again.status).toBe(409);
            expect(err(again).details).toMatchObject({ draftId: first.id, version: 1 });

            const onDeal = await draft(admin, { personId: danaId, dealId, content: { subject: 'About the deal' } });
            expect(onDeal.dealId).toBe(dealId);
            const deals = await as(admin).get(w(`/mail/drafts?target=opportunity:${dealId}`));
            expect((deals.body as { items: Draft[] }).items.map((x) => x.id)).toEqual([onDeal.id]);
            await as(admin)
                .delete(w(`/mail/drafts/${first.id}`))
                .expect(204);
            await as(admin)
                .delete(w(`/mail/drafts/${onDeal.id}`))
                .expect(204);
        });

        it('saves over the version named, and refuses a save over a version another tab replaced', async () => {
            const d = await draft(member, { personId: danaId, content: { subject: 'v1' } });
            const tabA = await as(member)
                .put(w(`/mail/drafts/${d.id}`))
                .send({ version: 1, content: { subject: 'from tab A' } });
            expect(tabA.status).toBe(200);
            expect(tabA.body).toMatchObject({ version: 2, content: { subject: 'from tab A' } });

            const tabB = await as(member)
                .put(w(`/mail/drafts/${d.id}`))
                .send({ version: 1, content: { subject: 'from tab B' } });
            expect(tabB.status).toBe(409);
            expect(err(tabB).details).toMatchObject({ draftId: d.id, version: 2 });
            expect((await as(member).get(w(`/mail/drafts/${d.id}`))).body).toMatchObject({
                version: 2,
                content: { subject: 'from tab A' },
            });

            // Saving what is there already writes nothing: the version stays.
            const same = await as(member)
                .put(w(`/mail/drafts/${d.id}`))
                .send({ version: 2, content: { subject: 'from tab A' } });
            expect(same.body).toMatchObject({ version: 2 });
            await as(member)
                .delete(w(`/mail/drafts/${d.id}`))
                .expect(204);
        });

        it('a draft for a person the caller cannot read, or another workspace’s, is refused', async () => {
            const res = await as(otherAdmin)
                .post(w('/mail/drafts', otherWorkspace))
                .send({ personId: danaId, content: {} });
            expect(res.status).toBe(404);
        });

        it('sending deletes the draft it was written in; a refused send keeps it', async () => {
            const d = await draft(member, { personId: danaId, content: { subject: 'To send' } });
            const refused = await message({ draftId: d.id, cc: [{ address: eveAddress }] });
            expect(refused.status).toBe(422);
            expect((await as(member).get(w(`/mail/drafts/${d.id}`))).status).toBe(200);

            const sent = await message({ draftId: d.id });
            expect(sent.status, JSON.stringify(sent.body)).toBe(202);
            expect((await as(member).get(w(`/mail/drafts/${d.id}`))).status).toBe(404);
        });

        it('scheduling deletes it too, follow-ups and all', async () => {
            const d = await draft(member, { personId: danaId, content: { subject: 'Later' } });
            const scheduled = await message({
                draftId: d.id,
                sendAt: inMs(HOUR),
                timeZone: 'Europe/London',
                cc: [{ address: `cc-${stamp}@client.example` }],
                followUps: [{ sendAt: inMs(25 * HOUR), body: body(para(t('Nudge.'))) }],
            });
            expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(202);
            expect((await as(member).get(w(`/mail/drafts/${d.id}`))).status).toBe(404);
            // The queued follow-up carries the same cc.
            const followUpId = (scheduled.body as { followUps: { messageId: string }[] }).followUps[0]!.messageId;
            const followUp = await as(member).get(w(`/mail/messages/${followUpId}`));
            expect((followUp.body as { cc: string[] }).cc).toEqual([`cc-${stamp}@client.example`]);
        });

        it('another member’s draft id in a send is not theirs to delete', async () => {
            const d = await draft(admin, { personId: danaId, content: { subject: 'Admin’s' } });
            const sent = await message({ draftId: d.id });
            expect(sent.status, JSON.stringify(sent.body)).toBe(202);
            expect((await as(admin).get(w(`/mail/drafts/${d.id}`))).status).toBe(200);
            await as(admin)
                .delete(w(`/mail/drafts/${d.id}`))
                .expect(204);
        });
    });

    describe('cc and bcc to any address', () => {
        it('sends to an address not in the CRM as it is, and makes no person of it', async () => {
            const stranger = `stranger-${stamp}@client.example`;
            const sent = await message({
                cc: [{ address: stranger.toUpperCase() }],
                bcc: [{ address: `b-${stamp}@x.example` }],
            });
            expect(sent.status, JSON.stringify(sent.body)).toBe(202);
            const outbound = await as(member).get(
                w(`/mail/messages/${(sent.body as { messageId: string }).messageId}`),
            );
            expect(outbound.body).toMatchObject({ cc: [stranger], bcc: [`b-${stamp}@x.example`] });
            const people = await owner.person.count({
                where: { workspaceId: workspace, emails: { path: ['primary'], equals: stranger } },
            });
            expect(people).toBe(0);
        });

        it('one address is one recipient: in to and cc it stays in to', async () => {
            const sent = await message({ cc: [{ address: `dana-${stamp}@acme.example` }, { personId: danaId }] });
            expect(sent.status, JSON.stringify(sent.body)).toBe(202);
            const outbound = await as(member).get(
                w(`/mail/messages/${(sent.body as { messageId: string }).messageId}`),
            );
            expect(outbound.body).toMatchObject({ to: [`dana-${stamp}@acme.example`], cc: [] });
        });

        it('the recipient guard judges cc: another member’s lead, by address, is refused at cc', async () => {
            const res = await message({ cc: [{ address: eveAddress }] });
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('recipient.guarded');
            expect(err(res).fieldErrors).toEqual([
                { path: 'cc', message: expect.stringContaining(eveAddress) as string },
            ]);
        });

        it('and bcc: an address at a company another member owns is refused at bcc', async () => {
            const res = await message({ bcc: [{ address: `someone@${adminDomain}` }] });
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('recipient.guarded');
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['bcc']);
        });

        it('a suppressed address is refused in cc as in to', async () => {
            const gone = `gone-${stamp}@client.example`;
            await as(admin).post(w('/suppressions')).send({ address: gone }).expect(201);
            const res = await message({ cc: [{ address: gone }] });
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('recipient.suppressed');
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual(['cc']);
        });

        it('cc and bcc count toward the mailbox’s budget of new recipients as to does', async () => {
            await as(admin)
                .put(w('/reputation/settings'))
                .send({ ...REPUTATION_DEFAULTS, dailyNewRecipients: 2, hourlyNewRecipients: 2 })
                .expect(200);
            try {
                const three = await message(
                    {
                        cc: [{ address: `c1-${stamp}@budget.example` }],
                        bcc: [{ address: `b1-${stamp}@budget.example` }],
                    },
                    admin,
                );
                expect(three.status).toBe(422);
                expect(err(three).code).toBe('mailbox.budget_reached');

                const two = await message({ cc: [{ address: `c1-${stamp}@budget.example` }] }, admin);
                expect(two.status, JSON.stringify(two.body)).toBe(202);
                // Dana and the cc'd address are this mailbox's two today: anyone new is over.
                const next = await message({ personId: await person('Ned', `ned-${stamp}@budget.example`) }, admin);
                expect(next.status).toBe(422);
                expect(err(next).code).toBe('mailbox.budget_reached');
            } finally {
                await as(admin).put(w('/reputation/settings')).send(REPUTATION_DEFAULTS).expect(200);
            }
        });
    });
});
