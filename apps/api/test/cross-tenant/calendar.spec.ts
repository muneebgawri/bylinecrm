import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    GOOGLE_CALENDAR_SCOPE,
    PERSONAL_MAILBOX_SCOPES,
    SESSION_COOKIE,
    SYSTEM_ROLES,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { CALENDAR_RETRY_ATTEMPTS } from '../../src/calendar/calendar.constants';
import { CalendarSyncService, type CalendarRunResult } from '../../src/calendar/calendar-sync.service';
import { GOOGLE_CALENDAR_PORT } from '../../src/calendar/google-calendar.port';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleCalendar } from '../support/fake-google-calendar';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { verifyAddress } from '../support/mail';
import { eventLog, settle, type EventLog } from '../support/outbox';

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

interface Person {
    id: string;
    nameFirst: string;
    nameLast: string;
    source: string | null;
    ownerId: string | null;
    companyId: string | null;
    emails: { primary: string | null };
}
interface Meeting {
    id: string;
    countsFor: string[];
    title: string;
    status: string;
    hostMemberId: string;
    conferenceUrl: string | null;
    members: { memberId: string; responseStatus: string }[];
    attendees: {
        address: string;
        personId: string | null;
        memberId: string | null;
        leadCreated: boolean;
        leadSuggested: boolean;
    }[];
}
interface KpiRow {
    member: { memberId: string };
    awaitingCustomer: number;
    suggestedLeads: number;
    booked: number;
    held: number;
    upcoming: number;
    cancelled: number;
    peopleMet: number;
    newLeads: number;
}
interface Activity {
    kind: string;
    target: { type: string; id: string };
    linked: { type: string; id: string } | null;
    properties: { linked?: { name: string }; meeting?: { title: string; conferenceUrl: string | null } };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Calendar sync end to end (CAL-1) against an in-memory Google: a personal mailbox's connect asks for the
 * calendar's read-only scope beside Gmail's; a calendar the grant reads is imported — the meetings with
 * someone outside the workspace, each once per workspace however many members' calendars hold it — and
 * every outside attendee who is no one yet becomes a lead the calendar's owner owns. A meeting is on the
 * timeline of every record it concerns and moves deals by the `meeting.booked` rule; it counts towards its
 * members' KPIs. Colleagues, rooms, webinars, out-of-office blocks and declined meetings are passed over.
 * One workspace never sees another's meetings, KPIs or calendar state.
 */
describe('calendar sync', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let sync: CalendarSyncService;
    let log: EventLog;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const calendar = new FakeGoogleCalendar(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const home = `pinion-${stamp}.example`;
    const acme = `acme-${stamp}.example`;
    const adminEmail = `cal-admin@${home}`;
    const memberEmail = `cal-member-${stamp}@member-${stamp}.example`;
    const otherEmail = `cal-other-${stamp}@other-${stamp}.example`;
    const dana = `dana@${acme}`;
    const riley = `riley@${acme}`;
    const prospect = `prospect.${stamp}@gmail.com`;
    const vendor = `val@supplier-${stamp}.example`;

    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let memberMemberId: string;
    let adminMailbox: string;
    let memberMailbox: string;
    let danaId: string;
    let acmeId: string;
    let dealId: string;
    let meetingStage: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };

    async function connect(who: Browser, ws: string, email: string, scopes: readonly string[]): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...scopes],
        });
        const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }

    async function personByEmail(email: string): Promise<Person | undefined> {
        const row = await owner.person.findFirst({ where: { workspaceId: workspace, emailPrimary: email } });
        if (!row) return undefined;
        return (await as(admin).get(w(`/people/${row.id}`))).body as Person;
    }

    async function kpis(who: Browser, ws = workspace): Promise<Response> {
        const from = new Date(Date.now() - 7 * DAY).toISOString();
        const to = new Date(Date.now() + 7 * DAY).toISOString();
        return as(who).get(w(`/meetings/kpis?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, ws));
    }

    const rowOf = (res: Response, memberId: string) =>
        (res.body as { rows: KpiRow[] }).rows.find((r) => r.member.memberId === memberId)!;

    async function meetings(who: Browser = admin, query = ''): Promise<Meeting[]> {
        const res = await as(who).get(w(`/meetings${query}`));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body as { items: Meeting[] }).items;
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(GOOGLE_CALENDAR_PORT)
            .useValue(calendar)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        sync = app.get(CalendarSyncService);
        log = await eventLog(app, 'meeting.*');

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Calendar ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other calendar ${stamp}`));

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
        const seats = await owner.workspaceMember.findMany({
            where: { workspaceId: workspace },
            select: { id: true, user: { select: { email: true } } },
        });
        adminMemberId = seats.find((s) => s.user.email === adminEmail)!.id;
        memberMemberId = seats.find((s) => s.user.email === memberEmail)!.id;

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `333-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            const put = await http()
                .put(w('/mail/oauth-client', ws))
                .set('Cookie', who.cookie)
                .set(CSRF_HEADER, who.csrf)
                .send({ clientId, clientSecret: secret });
            expect(put.status).toBe(200);
        }
        adminMailbox = await connect(admin, workspace, adminEmail, PERSONAL_MAILBOX_SCOPES);
        // The member unticks the calendar on Google's consent screen: their mailbox works without it.
        memberMailbox = await connect(member, workspace, memberEmail, GMAIL_SCOPES);
        await connect(otherAdmin, otherWorkspace, otherEmail, PERSONAL_MAILBOX_SCOPES);

        // Acme, Dana at Acme whom nobody owns yet, an open deal with Dana, and a rule: meeting booked → Meeting.
        acmeId = (
            (
                await as(admin)
                    .post(w('/companies'))
                    .send({ name: `Acme ${stamp}`, domain: acme })
            ).body as {
                id: string;
            }
        ).id;
        const person = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Reyes',
                emails: { primary: dana, additional: [] },
                companyId: acmeId,
                ownerId: null,
            });
        expect(person.status, JSON.stringify(person.body)).toBe(201);
        danaId = (person.body as { id: string }).id;
        const pipeline = (
            (await as(admin).get(w('/pipelines'))).body as { id: string; stages: { id: string; name: string }[] }[]
        )[0]!;
        meetingStage = pipeline.stages.find((s) => s.name === 'Meeting')!.id;
        const rule = await as(admin)
            .post(w(`/pipelines/${pipeline.id}/rules`))
            .send({ event: 'meeting.booked', toStageId: meetingStage });
        expect(rule.status, JSON.stringify(rule.body)).toBe(201);
        dealId = (
            (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `Acme deal ${stamp}`, companyId: acmeId, pointOfContactId: danaId })
            ).body as { id: string }
        ).id;
        await settle(app);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('connecting', () => {
        it('a personal mailbox’s connect asks for the calendar’s read-only scope beside Gmail’s; a pool’s does not', async () => {
            const personal = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
            const scopes = new URL((personal.body as { authorizeUrl: string }).authorizeUrl).searchParams
                .get('scope')!
                .split(' ');
            expect(scopes.sort()).toEqual([...PERSONAL_MAILBOX_SCOPES].sort());
            const pool = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'pool' });
            const poolScopes = new URL((pool.body as { authorizeUrl: string }).authorizeUrl).searchParams
                .get('scope')!
                .split(' ');
            expect(poolScopes).not.toContain(GOOGLE_CALENDAR_SCOPE);
        });

        it('the setup screen lists the calendar scope for the consent screen', async () => {
            const view = await as(admin).get(w('/mail/oauth-client'));
            expect((view.body as { scopes: string[] }).scopes).toContain(GOOGLE_CALENDAR_SCOPE);
        });

        it('a mailbox connected without the calendar is not read, and says so', async () => {
            const result = await sync.syncCalendar(workspace, memberMailbox, noWait);
            expect(result.mode).toBe('skipped');
            expect(calendar.callsFor(memberEmail)).toBe(0);
            const state = await as(member).get(w(`/mailboxes/${memberMailbox}/calendar`));
            expect(state.status).toBe(200);
            expect(state.body).toMatchObject({
                granted: false,
                status: 'failed',
                lastError: { code: 'calendar_not_granted' },
            });
        });
    });

    describe('the first read', () => {
        let result: CalendarRunResult;
        const guests = (n: number) =>
            Array.from({ length: n }, (_, i) => ({ email: `guest${i}@webinar-${stamp}.example` }));

        beforeAll(async () => {
            await log.reset();
            calendar.put(adminEmail, {
                id: 'intro',
                summary: 'Acme intro',
                start: new Date(Date.now() - 3 * DAY),
                created: new Date(Date.now() - 5 * DAY),
                guests: [
                    { email: dana, displayName: 'Dana Reyes' },
                    { email: riley, displayName: 'Riley Chen' },
                    { email: `lee@${home}` }, // a colleague who is not a member yet
                    { email: `room@resource.calendar.google.com`, resource: true },
                ],
            });
            calendar.put(adminEmail, {
                id: 'standup',
                summary: 'Standup',
                start: new Date(Date.now() - DAY),
                guests: [{ email: memberEmail }],
            });
            calendar.put(adminEmail, {
                id: 'webinar',
                summary: 'Webinar',
                start: new Date(Date.now() - 2 * DAY),
                guests: guests(30),
            });
            calendar.put(adminEmail, {
                id: 'ooo',
                summary: 'Away',
                start: new Date(Date.now() + DAY),
                eventType: 'outOfOffice',
            });
            calendar.put(adminEmail, {
                id: 'interview',
                summary: 'Interview elsewhere',
                start: new Date(Date.now() + DAY),
                organizer: `recruiter@elsewhere-${stamp}.example`,
                guests: [{ email: `recruiter@elsewhere-${stamp}.example`, displayName: 'A Recruiter' }],
                visibility: 'private',
            });
            calendar.put(adminEmail, {
                id: 'declined',
                summary: 'Pitch I declined',
                start: new Date(Date.now() + 2 * DAY),
                organizer: `seller@vendor-${stamp}.example`,
                ownResponse: 'declined',
                guests: [{ email: `seller@vendor-${stamp}.example` }],
            });
            calendar.put(adminEmail, {
                id: 'demo',
                summary: 'Demo',
                start: new Date(Date.now() + 5 * DAY),
                guests: [{ email: prospect, displayName: 'Pat Prospect' }],
            });
            // A supplier's call the admin accepted: they were invited, so the supplier is only suggested.
            calendar.put(adminEmail, {
                id: 'vendor-call',
                summary: 'Vendor call',
                start: new Date(Date.now() + 4 * DAY),
                organizer: vendor,
                guests: [{ email: vendor, displayName: 'Val Vendor' }],
            });
            calendar.put(adminEmail, {
                id: 'old',
                summary: 'Long ago',
                start: new Date(Date.now() - 40 * DAY),
                guests: [{ email: dana }],
            });
            result = await sync.syncCalendar(workspace, adminMailbox, noWait);
            await settle(app);
        });

        it('stores the meetings with someone outside the workspace, once, and passes over the rest', async () => {
            expect(result).toMatchObject({
                mode: 'window',
                stored: 3,
                leadsCreated: 1,
                leadsSuggested: 2,
                cancelled: 0,
            });
            // The standup (colleagues only), the webinar (too big), the out-of-office block, the private
            // interview and the declined pitch.
            expect(result.passedOver).toBe(5);
            const list = await meetings();
            expect(list.map((m) => m.title)).toEqual(['Demo', 'Vendor call', 'Acme intro']);
            const intro = list.find((m) => m.title === 'Acme intro')!;
            expect(intro).toMatchObject({
                status: 'confirmed',
                hostMemberId: adminMemberId,
                conferenceUrl: 'https://meet.google.com/intro',
                members: [{ memberId: adminMemberId, responseStatus: 'accepted' }],
            });
            expect(intro.attendees.find((a) => a.address === adminEmail)?.memberId).toBe(adminMemberId);
        });

        it('makes a clear lead — someone at a work domain the owner invited — a person the owner owns, at their company', async () => {
            const lead = await personByEmail(riley);
            expect(lead).toMatchObject({
                nameFirst: 'Riley',
                nameLast: 'Chen',
                source: 'Google Calendar',
                ownerId: adminMemberId,
                companyId: acmeId,
            });
            // At a free-mail domain, or someone who invited the owner: only suggested, not made people.
            expect(await personByEmail(prospect)).toBeUndefined();
            expect(await personByEmail(vendor)).toBeUndefined();
            const demo = (await meetings()).find((m) => m.title === 'Demo')!;
            expect(demo.attendees.find((a) => a.address === prospect)).toMatchObject({
                personId: null,
                leadCreated: false,
                leadSuggested: true,
            });
            // A colleague, a room and the declined pitch's seller never become people.
            expect(await personByEmail(`lee@${home}`)).toBeUndefined();
            expect(await personByEmail(`seller@vendor-${stamp}.example`)).toBeUndefined();
            expect(await personByEmail('guest0@webinar-' + stamp + '.example')).toBeUndefined();
            expect(await personByEmail(`recruiter@elsewhere-${stamp}.example`)).toBeUndefined();
            const intro = (await meetings()).find((m) => m.title === 'Acme intro')!;
            expect(intro.attendees.find((a) => a.address === riley)).toMatchObject({
                personId: lead!.id,
                leadCreated: true,
            });
            expect(intro.attendees.find((a) => a.address === dana)).toMatchObject({
                personId: danaId,
                leadCreated: false,
            });
        });

        it('gives an outside attendee nobody owns to the calendar’s owner', async () => {
            expect((await personByEmail(dana))?.ownerId).toBe(adminMemberId);
        });

        it('announces each meeting once, on the timeline of every record it concerns, and moves the deal by the rule', async () => {
            const booked = (await log.read()).filter((e) => e.type === 'meeting.booked');
            expect(booked).toHaveLength(3);
            const timeline = await as(admin).get(w(`/timeline?target=person:${danaId}&kinds=linked-meeting`));
            const items = (timeline.body as { items: Activity[] }).items;
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({
                kind: 'linked-meeting.booked',
                properties: {
                    linked: { name: 'Acme intro' },
                    meeting: { title: 'Acme intro', conferenceUrl: 'https://meet.google.com/intro' },
                },
            });
            const company = await as(admin).get(w(`/timeline?target=company:${acmeId}&kinds=linked-meeting`));
            expect((company.body as { items: Activity[] }).items.length).toBeGreaterThanOrEqual(1);
            const deal = await as(admin).get(w(`/opportunities/${dealId}`));
            expect((deal.body as { stageId: string }).stageId).toBe(meetingStage);
        });

        it('a second run reads only what changed, and stores nothing twice', async () => {
            const again = await sync.syncCalendar(workspace, adminMailbox, noWait);
            expect(again).toMatchObject({ mode: 'changes', stored: 0, updated: 0, leadsCreated: 0, leadsSuggested: 0 });
            expect(calendar.calls.at(-1)?.updatedMin).not.toBeNull();
            expect(await owner.calendarEvent.count({ where: { workspaceId: workspace } })).toBe(3);
        });
    });

    describe('KPIs', () => {
        it('counts only meetings with a customer of the member’s — a person outside they own — and says what waits', async () => {
            const res = await kpis(admin);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            // The intro counts (Dana and Riley are the admin's); the demo and the vendor call have no customer yet.
            expect(rowOf(res, adminMemberId)).toMatchObject({
                booked: 1,
                held: 1,
                upcoming: 0,
                cancelled: 0,
                peopleMet: 2,
                newLeads: 1,
                awaitingCustomer: 2,
                suggestedLeads: 2,
            });
            expect(rowOf(res, memberMemberId)).toMatchObject({ booked: 0, held: 0, newLeads: 0 });
            const demo = (await meetings()).find((m) => m.title === 'Demo')!;
            expect(demo.countsFor).toEqual([]);
            const intro = (await meetings()).find((m) => m.title === 'Acme intro')!;
            expect(intro.countsFor).toEqual([adminMemberId]);
        });

        it('a member sees only their own row and meetings; asking for another member’s is refused', async () => {
            const res = await kpis(member);
            expect((res.body as { rows: KpiRow[] }).rows.map((r) => r.member.memberId)).toEqual([memberMemberId]);
            expect(await meetings(member)).toEqual([]);
            expect((await as(member).get(w(`/meetings?memberId=${adminMemberId}`))).status).toBe(403);
        });

        it('refuses a period that ends before it starts, or is longer than a year', async () => {
            const at = new Date().toISOString();
            expect(
                (await as(admin).get(w(`/meetings/kpis?from=${encodeURIComponent(at)}&to=${encodeURIComponent(at)}`)))
                    .status,
            ).toBe(400);
            const long = new Date(Date.now() - 400 * DAY).toISOString();
            expect(
                (await as(admin).get(w(`/meetings/kpis?from=${encodeURIComponent(long)}&to=${encodeURIComponent(at)}`)))
                    .status,
            ).toBe(400);
        });
    });

    describe('suggested leads', () => {
        interface Suggestion {
            memberId: string;
            address: string;
            displayName: string;
            meetings: { title: string }[];
        }
        const suggestions = async (who: Browser = admin, query = '') =>
            (await as(who).get(w(`/meetings/lead-suggestions${query}`))).body as Suggestion[];

        it('lists the member’s suggestions, one per address with the meetings; nobody else’s', async () => {
            const mine = await suggestions();
            expect(mine.map((s) => [s.address, s.displayName, s.meetings.map((m) => m.title)]).sort()).toEqual(
                [
                    [prospect, 'Pat Prospect', ['Demo']],
                    [vendor, 'Val Vendor', ['Vendor call']],
                ].sort(),
            );
            expect(await suggestions(member)).toEqual([]);
            expect((await as(member).get(w(`/meetings/lead-suggestions?memberId=${adminMemberId}`))).status).toBe(403);
            const theirs = await as(member)
                .post(w('/meetings/lead-suggestions/accept'))
                .send({ address: prospect, memberId: adminMemberId });
            expect(theirs.status).toBe(403);
        });

        it('adding one makes the person the member’s — and the meeting with them counts', async () => {
            const res = await as(admin).post(w('/meetings/lead-suggestions/accept')).send({ address: prospect });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const person = await personByEmail(prospect);
            expect(person).toMatchObject({
                id: (res.body as { personId: string }).personId,
                nameFirst: 'Pat',
                ownerId: adminMemberId,
                source: 'Google Calendar',
            });
            expect(rowOf(await kpis(admin), adminMemberId)).toMatchObject({
                booked: 2,
                upcoming: 1,
                newLeads: 2,
                awaitingCustomer: 1,
                suggestedLeads: 1,
            });
            expect(
                (await as(admin).post(w('/meetings/lead-suggestions/accept')).send({ address: prospect })).status,
            ).toBe(404);
        });

        it('“not a lead” is remembered: the address is not suggested again, and its meetings do not count', async () => {
            const res = await as(admin).post(w('/meetings/lead-suggestions/dismiss')).send({ address: vendor });
            expect(res.status).toBe(204);
            calendar.put(adminEmail, {
                id: 'vendor-call-2',
                summary: 'Vendor follow-up',
                start: new Date(Date.now() + 6 * DAY),
                organizer: vendor,
                guests: [{ email: vendor, displayName: 'Val Vendor' }],
            });
            const run = await sync.syncCalendar(workspace, adminMailbox, noWait);
            expect(run).toMatchObject({ stored: 1, leadsCreated: 0, leadsSuggested: 0 });
            expect(await suggestions()).toEqual([]);
            expect(await personByEmail(vendor)).toBeUndefined();
            expect(rowOf(await kpis(admin), adminMemberId)).toMatchObject({ awaitingCustomer: 2, suggestedLeads: 0 });
        });
    });

    describe('a second member’s calendar', () => {
        it('once connected with the calendar, adds their copy of a shared meeting without a second meeting', async () => {
            await log.reset();
            memberMailbox = await connect(member, workspace, memberEmail, PERSONAL_MAILBOX_SCOPES);
            calendar.put(memberEmail, {
                id: 'member-intro',
                iCalUID: 'intro@google.com',
                summary: 'Acme intro',
                start: new Date(Date.now() - 3 * DAY),
                organizer: adminEmail,
                guests: [
                    { email: adminEmail },
                    { email: dana, displayName: 'Dana Reyes' },
                    { email: riley, displayName: 'Riley Chen' },
                    { email: `lee@${home}` },
                    { email: `room@resource.calendar.google.com`, resource: true },
                ],
            });
            const result = await sync.syncCalendar(workspace, memberMailbox, noWait);
            expect(result).toMatchObject({ stored: 1, leadsCreated: 0 });
            expect(
                await owner.calendarEvent.count({ where: { workspaceId: workspace, icalUid: 'intro@google.com' } }),
            ).toBe(1);
            expect((await log.read()).filter((e) => e.type === 'meeting.booked')).toEqual([]);
            const res = await kpis(admin);
            // Attended by both, but Dana and Riley are the admin's customers: it counts for the admin alone.
            expect(rowOf(res, memberMemberId)).toMatchObject({ booked: 0, held: 0, peopleMet: 0, awaitingCustomer: 1 });
            expect(rowOf(res, adminMemberId)).toMatchObject({ booked: 2, held: 1 });
            expect((await meetings(member)).map((m) => m.title)).toEqual(['Acme intro']);
        });

        it('a guest’s calendar that hides the other guests never takes them, or their leads, off the meeting', async () => {
            calendar.hideGuests(memberEmail, 'member-intro');
            await sync.syncCalendar(workspace, memberMailbox, noWait);
            const intro = (await meetings()).find((m) => m.title === 'Acme intro')!;
            expect(intro.attendees.map((a) => a.address)).toEqual(expect.arrayContaining([dana, riley]));
            expect(rowOf(await kpis(admin), adminMemberId)).toMatchObject({ newLeads: 2, peopleMet: 2 });
        });

        it('assigning a customer to the member moves the meeting’s credit to them', async () => {
            const moved = await as(admin)
                .patch(w(`/people/${danaId}`))
                .send({ ownerId: memberMemberId });
            expect(moved.status, JSON.stringify(moved.body)).toBe(200);
            const res = await kpis(admin);
            expect(rowOf(res, memberMemberId)).toMatchObject({ held: 1, peopleMet: 1, awaitingCustomer: 0 });
            // Riley is still the admin's: the intro counts for both now.
            expect(rowOf(res, adminMemberId)).toMatchObject({ held: 1, peopleMet: 1 });
        });
    });

    describe('changes', () => {
        it('a meeting called off is cancelled once, on its records’ timelines, and stops counting as to come', async () => {
            await log.reset();
            calendar.cancel(adminEmail, 'demo');
            const result = await sync.syncCalendar(workspace, adminMailbox, noWait);
            expect(result.cancelled).toBe(1);
            await settle(app);
            const cancelled = (await log.read()).filter((e) => e.type === 'meeting.cancelled');
            expect(cancelled).toHaveLength(1);
            const lead = await personByEmail(prospect);
            const timeline = await as(admin).get(w(`/timeline?target=person:${lead!.id}&kinds=linked-meeting`));
            // Pat became a person after the demo was booked: the cancellation is on their timeline.
            expect((timeline.body as { items: Activity[] }).items.map((a) => a.kind)).toEqual([
                'linked-meeting.cancelled',
            ]);
            expect(rowOf(await kpis(admin), adminMemberId)).toMatchObject({ upcoming: 0, cancelled: 1 });
            // Read again: nothing new.
            expect((await sync.syncCalendar(workspace, adminMailbox, noWait)).cancelled).toBe(0);
        });

        it('a person someone deleted is not brought back by a later meeting', async () => {
            const lead = await personByEmail(riley);
            expect((await as(admin).delete(w(`/people/${lead!.id}`))).status).toBe(204);
            calendar.put(adminEmail, {
                id: 'follow-up',
                summary: 'Follow-up',
                start: new Date(Date.now() + 3 * DAY),
                guests: [{ email: riley, displayName: 'Riley Chen' }],
            });
            const result = await sync.syncCalendar(workspace, adminMailbox, noWait);
            expect(result).toMatchObject({ stored: 1, leadsCreated: 0 });
            const followUp = (await meetings()).find((m) => m.title === 'Follow-up')!;
            expect(followUp.attendees.find((a) => a.address === riley)).toMatchObject({
                personId: null,
                leadCreated: false,
            });
            expect(await owner.person.count({ where: { workspaceId: workspace, emailPrimary: riley } })).toBe(1);
        });

        it('a Calendar API the Google Cloud project has not turned on is an admin’s step, not a reconnect', async () => {
            calendar.failNext(memberEmail, 403, 1, 'accessNotConfigured');
            const result = await sync.syncCalendar(workspace, memberMailbox, noWait);
            expect(result.mode).toBe('skipped');
            const state = await as(member).get(w(`/mailboxes/${memberMailbox}/calendar`));
            expect(state.body).toMatchObject({ granted: true, lastError: { code: 'calendar_api_disabled' } });
        });

        it('a calendar scope withdrawn in the Google account stops the read, and the mailbox keeps working', async () => {
            google.narrowGrantFor(memberEmail, [...GMAIL_SCOPES]);
            const result = await sync.syncCalendar(workspace, memberMailbox, noWait);
            expect(result.mode).toBe('skipped');
            const state = await as(member).get(w(`/mailboxes/${memberMailbox}/calendar`));
            // The mailbox stops claiming the calendar, so the tick stops reading it and the page offers to connect it.
            expect(state.body).toMatchObject({
                granted: false,
                status: 'failed',
                lastError: { code: 'calendar_not_granted' },
            });
            const mailbox = await as(member).get(w(`/mailboxes/${memberMailbox}`));
            expect(mailbox.body).toMatchObject({ status: 'connected', grantedScopes: [...GMAIL_SCOPES] });
        });

        it('a throttled read is retried, and a failure past the retries is recorded and thrown for the queue', async () => {
            calendar.failNext(adminEmail, 429, 1);
            await expect(sync.syncCalendar(workspace, adminMailbox, noWait)).resolves.toMatchObject({
                mode: 'changes',
            });
            calendar.failNext(adminEmail, 503, CALENDAR_RETRY_ATTEMPTS);
            await expect(sync.syncCalendar(workspace, adminMailbox, noWait)).rejects.toThrow();
            const state = await as(admin).get(w(`/mailboxes/${adminMailbox}/calendar`));
            expect(state.body).toMatchObject({ status: 'failed', lastError: { code: 'calendar.backendError' } });
        });
    });

    describe('isolation', () => {
        it('another workspace sees none of these meetings, KPIs or calendar state', async () => {
            expect((await as(otherAdmin).get(w('/meetings', otherWorkspace))).body).toMatchObject({ items: [] });
            const theirs = await kpis(otherAdmin, otherWorkspace);
            expect((theirs.body as { rows: KpiRow[] }).rows.every((r) => r.booked === 0 && r.held === 0)).toBe(true);
            expect((await as(otherAdmin).get(w('/meetings'))).status).toBe(403);
            expect((await as(otherAdmin).get(w(`/mailboxes/${adminMailbox}/calendar`, otherWorkspace))).status).toBe(
                404,
            );
            expect(await owner.calendarEvent.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        });
    });
});
