import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, PERSONAL_MAILBOX_SCOPES, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { CalendarSyncService } from '../../src/calendar/calendar-sync.service';
import { GOOGLE_CALENDAR_PORT } from '../../src/calendar/google-calendar.port';
import { RateLimiter } from '../../src/auth/rate-limiter.service';
import { slotlineHookRateKey } from '../../src/calendar/slotline/slotline.constants';
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

interface Settings {
    configured: boolean;
    hookUrl: string | null;
    lastDeliveryResult: string | null;
    unmatchedOrganizers: number;
    lastUnmatchedOrganizer: string | null;
}
interface Meeting {
    id: string;
    title: string;
    status: string;
    startsAt: string;
    bookedVia: string;
    slotlineUrl: string | null;
    hostMemberId: string;
    members: { memberId: string; responseStatus: string }[];
    attendees: { address: string; personId: string | null; leadCreated: boolean }[];
}
interface KpiRow {
    member: { memberId: string };
    booked: number;
    bookedViaSlotline: number;
    held: number;
    upcoming: number;
    cancelled: number;
    newLeads: number;
}

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'slotline-webhook-secret-for-tests';

/**
 * Slotline bookings end to end (CAL-2): the workspace's booking site posts signed webhook deliveries to a public
 * hook; each booking becomes its organiser's copy of the meeting, with the same rules as a Google Calendar
 * meeting — the booker a lead the organiser owns, `meeting.booked` once — and is one meeting with the Google
 * event Slotline writes for it. A forged, replayed or misdirected delivery stores nothing it should not.
 */
describe('Slotline bookings', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let log: EventLog;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const calendar = new FakeGoogleCalendar(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const home = `pinion-sl-${stamp}.example`;
    const adminEmail = `admin@${home}`;
    const memberEmail = `member-${stamp}@member-sl-${stamp}.example`;
    /** The member's personal mailbox is at another address than their sign-in: Slotline uses this one. */
    const memberMailboxEmail = `rep-${stamp}@sales-sl-${stamp}.example`;
    const otherEmail = `other@other-sl-${stamp}.example`;
    const booker = `booker@client-${stamp}.example`;
    const start = new Date(Date.now() + 3 * DAY);

    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let memberMemberId: string;
    let adminMailbox: string;
    let hookPath: string;
    let otherHookPath: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;

    /** A delivery as Slotline sends it: the JSON bytes, signed with the webhook's secret. */
    function deliver(path: string, body: unknown, secret = SECRET) {
        const raw = JSON.stringify(body);
        const signature = createHmac('sha256', secret).update(raw).digest('hex');
        return http()
            .post(path)
            .set('content-type', 'application/json')
            .set('x-cal-signature-256', signature)
            .send(raw);
    }

    function booking(trigger: string, overrides: Record<string, unknown> = {}) {
        return {
            triggerEvent: trigger,
            createdAt: new Date().toISOString(),
            payload: {
                uid: `uid-${stamp}`,
                iCalUID: `ical-${stamp}@Slotline`,
                title: 'Intro call',
                startTime: start.toISOString(),
                endTime: new Date(start.getTime() + 30 * 60_000).toISOString(),
                status: 'ACCEPTED',
                videoCallData: { url: 'https://video.example/room' },
                organizer: { email: adminEmail, name: 'Admin', timeZone: 'UTC' },
                attendees: [{ email: booker, name: 'Bea Booker', timeZone: 'UTC' }],
                ...overrides,
            },
        };
    }

    async function meetings(who: Browser = admin, ws = workspace): Promise<Meeting[]> {
        const res = await as(who).get(w('/meetings', ws));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body as { items: Meeting[] }).items;
    }

    async function kpiRow(memberId: string): Promise<KpiRow> {
        const from = encodeURIComponent(new Date(Date.now() - 7 * DAY).toISOString());
        const to = encodeURIComponent(new Date(Date.now() + 7 * DAY).toISOString());
        const res = await as(admin).get(w(`/meetings/kpis?from=${from}&to=${to}`));
        return (res.body as { rows: KpiRow[] }).rows.find((r) => r.member.memberId === memberId)!;
    }

    async function settings(who: Browser = admin, ws = workspace): Promise<Settings> {
        return (await as(who).get(w('/integrations/slotline', ws))).body as Settings;
    }

    async function connect(who: Browser, ws: string, email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose: 'personal' });
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...PERSONAL_MAILBOX_SCOPES],
        });
        const callback = await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
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
        log = await eventLog(app, 'meeting.*', 'person.created');
        await app.get(RateLimiter).clear(slotlineHookRateKey('::ffff:127.0.0.1'));

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Slotline ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other slotline ${stamp}`));
        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        await verifyAddress(app, http, memberEmail);
        member = browserFrom(joined);
        const seats = await owner.workspaceMember.findMany({
            where: { workspaceId: workspace },
            select: { id: true, user: { select: { email: true } } },
        });
        adminMemberId = seats.find((s) => s.user.email === adminEmail)!.id;
        memberMemberId = seats.find((s) => s.user.email === memberEmail)!.id;

        const clientId = `444-a${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, `GOCSPX-sl-${stamp}`, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin)
            .put(w('/mail/oauth-client'))
            .send({ clientId, clientSecret: `GOCSPX-sl-${stamp}` })
            .expect(200);
        adminMailbox = await connect(admin, workspace, adminEmail);
        await connect(member, workspace, memberMailboxEmail);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('setting it up', () => {
        it('an admin sets the booking site and the secret, and gets the hook URL; a member may not', async () => {
            expect(await settings()).toMatchObject({ configured: false, hookUrl: null });
            const noSecret = await as(admin)
                .put(w('/integrations/slotline'))
                .send({ baseUrl: 'https://bookings.example.com' });
            expect(noSecret.status).toBe(400);
            const shortSecret = await as(admin)
                .put(w('/integrations/slotline'))
                .send({ baseUrl: 'https://bookings.example.com', secret: 'short' });
            expect(shortSecret.status).toBe(400);
            const plain = await as(admin)
                .put(w('/integrations/slotline'))
                .send({ baseUrl: 'http://bookings.example.com', secret: SECRET });
            expect(plain.status).toBe(400);
            const put = await as(admin)
                .put(w('/integrations/slotline'))
                .send({ baseUrl: 'https://bookings.example.com/some/path', secret: SECRET });
            expect(put.status, JSON.stringify(put.body)).toBe(200);
            const view = put.body as Settings & { baseUrl: string };
            expect(view).toMatchObject({ configured: true, baseUrl: 'https://bookings.example.com' });
            expect(JSON.stringify(view)).not.toContain(SECRET);
            hookPath = new URL(view.hookUrl!).pathname;
            expect(hookPath).toMatch(/^\/api\/hooks\/slotline\/[A-Za-z0-9_-]{40,}$/);
            expect((await as(member).get(w('/integrations/slotline'))).status).toBe(403);

            const other = await as(otherAdmin)
                .put(w('/integrations/slotline', otherWorkspace))
                .send({ baseUrl: 'https://bookings.other.example', secret: `${SECRET}-other` });
            otherHookPath = new URL((other.body as Settings).hookUrl!).pathname;
        });
    });

    describe('deliveries', () => {
        it('refuses a delivery that is not signed with the secret, and a token that is no workspace’s', async () => {
            expect((await deliver(hookPath, booking('BOOKING_CREATED'), 'not-the-secret-at-all')).status).toBe(401);
            expect((await deliver('/api/hooks/slotline/not-a-token', booking('BOOKING_CREATED'))).status).toBe(404);
            // Another workspace's URL with this workspace's secret: its own secret is what counts.
            expect((await deliver(otherHookPath, booking('BOOKING_CREATED'))).status).toBe(401);
            expect(
                await owner.calendarEvent.count({ where: { workspaceId: { in: [workspace, otherWorkspace] } } }),
            ).toBe(0);
            expect(await settings()).toMatchObject({ lastDeliveryResult: 'bad_signature' });
        });

        it('answers Slotline’s ping', async () => {
            const res = await deliver(hookPath, {
                triggerEvent: 'PING',
                createdAt: new Date().toISOString(),
                payload: {},
            });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ result: 'ping' });
        });

        it('a booking is its organiser’s meeting, booked via Slotline; the booker becomes their lead', async () => {
            await log.reset();
            const res = await deliver(hookPath, booking('BOOKING_CREATED'));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual({ result: 'stored' });
            const [meeting] = await meetings();
            expect(meeting).toMatchObject({
                title: 'Intro call',
                status: 'confirmed',
                bookedVia: 'slotline',
                slotlineUrl: `https://bookings.example.com/booking/uid-${stamp}`,
                hostMemberId: adminMemberId,
                members: [{ memberId: adminMemberId, responseStatus: 'accepted' }],
            });
            expect(meeting!.attendees.find((a) => a.address === booker)).toMatchObject({ leadCreated: true });
            const lead = await owner.person.findFirst({ where: { workspaceId: workspace, emailPrimary: booker } });
            expect(lead).toMatchObject({
                nameFirst: 'Bea',
                nameLast: 'Booker',
                source: 'Slotline',
                ownerId: adminMemberId,
            });
            const events = await log.read();
            expect(events.filter((e) => e.type === 'meeting.booked')).toHaveLength(1);
            expect(await kpiRow(adminMemberId)).toMatchObject({
                booked: 1,
                bookedViaSlotline: 1,
                upcoming: 1,
                newLeads: 1,
            });
        });

        it('a replayed delivery stores nothing twice', async () => {
            await log.reset();
            expect((await deliver(hookPath, booking('BOOKING_CREATED'))).status).toBe(200);
            expect(await log.read()).toEqual([]);
            expect(await owner.calendarEvent.count({ where: { workspaceId: workspace } })).toBe(1);
        });

        it('the Google event Slotline writes for it is the same meeting, counted once', async () => {
            await log.reset();
            calendar.put(adminEmail, {
                id: 'slotline-google-copy',
                iCalUID: `ical-${stamp}@Slotline`,
                summary: 'Intro call',
                start,
                guests: [{ email: booker, displayName: 'Bea Booker' }],
            });
            const result = await app.get(CalendarSyncService).syncCalendar(workspace, adminMailbox, {
                sleep: () => Promise.resolve(),
            });
            expect(result).toMatchObject({ stored: 1, leadsCreated: 0 });
            expect(await owner.calendarEvent.count({ where: { workspaceId: workspace } })).toBe(1);
            expect((await log.read()).filter((e) => e.type === 'meeting.booked')).toEqual([]);
            const [meeting] = await meetings();
            // One member, once, though both their calendar and Slotline hold it.
            expect(meeting!.members).toEqual([
                { memberId: adminMemberId, responseStatus: 'accepted', isOrganizer: true },
            ]);
            expect(meeting!.bookedVia).toBe('slotline');
            expect(await kpiRow(adminMemberId)).toMatchObject({ booked: 1, upcoming: 1 });
        });

        it('a reschedule moves the meeting; it stays one meeting', async () => {
            const later = new Date(start.getTime() + DAY);
            const res = await deliver(
                hookPath,
                booking('BOOKING_RESCHEDULED', {
                    uid: `uid2-${stamp}`,
                    rescheduleUid: `uid-${stamp}`,
                    startTime: later.toISOString(),
                    endTime: new Date(later.getTime() + 30 * 60_000).toISOString(),
                }),
            );
            expect(res.status).toBe(200);
            const [meeting] = await meetings();
            expect(new Date(meeting!.startsAt).getTime()).toBe(later.getTime());
            expect(meeting!.slotlineUrl).toBe(`https://bookings.example.com/booking/uid2-${stamp}`);
            expect(await owner.calendarEvent.count({ where: { workspaceId: workspace } })).toBe(1);
        });

        it('a cancellation calls the meeting off at once, once — and the calendar’s stale copy does not bring it back', async () => {
            await log.reset();
            const res = await deliver(hookPath, booking('BOOKING_CANCELLED', { uid: `uid2-${stamp}` }));
            expect(res.body).toEqual({ result: 'cancelled' });
            expect((await meetings())[0]).toMatchObject({ status: 'cancelled' });
            // The Google event is still in the calendar for a moment: a read does not reopen the meeting.
            calendar.put(adminEmail, {
                id: 'slotline-google-copy',
                iCalUID: `ical-${stamp}@Slotline`,
                summary: 'Intro call',
                start,
                guests: [{ email: booker }],
            });
            await app
                .get(CalendarSyncService)
                .syncCalendar(workspace, adminMailbox, { sleep: () => Promise.resolve() });
            expect((await meetings())[0]).toMatchObject({ status: 'cancelled' });
            expect((await deliver(hookPath, booking('BOOKING_CANCELLED', { uid: `uid2-${stamp}` }))).status).toBe(200);
            await settle(app);
            expect((await log.read()).filter((e) => e.type === 'meeting.cancelled')).toHaveLength(1);
            expect(await kpiRow(adminMemberId)).toMatchObject({ upcoming: 0, cancelled: 1 });
        });

        it('a member is found by their personal mailbox’s address when Slotline knows them by it', async () => {
            const res = await deliver(
                hookPath,
                booking('BOOKING_CREATED', {
                    uid: `uid-m-${stamp}`,
                    iCalUID: `ical-m-${stamp}@Slotline`,
                    organizer: { email: memberMailboxEmail, name: 'Rep' },
                    attendees: [{ email: `second@client-${stamp}.example`, name: 'Second Client' }],
                }),
            );
            expect(res.body).toEqual({ result: 'stored' });
            expect(await kpiRow(memberMemberId)).toMatchObject({ booked: 1, bookedViaSlotline: 1, newLeads: 1 });
        });

        it('a booking no member organised is counted and left', async () => {
            const res = await deliver(
                hookPath,
                booking('BOOKING_CREATED', {
                    uid: `uid-x-${stamp}`,
                    iCalUID: `ical-x-${stamp}@Slotline`,
                    organizer: { email: `stranger@nowhere-${stamp}.example` },
                }),
            );
            expect(res.body).toEqual({ result: 'unmatched' });
            expect(await settings()).toMatchObject({
                unmatchedOrganizers: 1,
                lastUnmatchedOrganizer: `stranger@nowhere-${stamp}.example`,
            });
            expect(
                await owner.calendarEvent.count({
                    where: { workspaceId: workspace, icalUid: `ical-x-${stamp}@Slotline` },
                }),
            ).toBe(0);
        });
    });

    describe('rotation and isolation', () => {
        it('a rotated URL stops the old one at once', async () => {
            const rotated = (await as(admin).post(w('/integrations/slotline/rotate')).send({})).body as Settings;
            const newPath = new URL(rotated.hookUrl!).pathname;
            expect(newPath).not.toBe(hookPath);
            expect((await deliver(hookPath, { triggerEvent: 'PING', payload: {} })).status).toBe(404);
            expect((await deliver(newPath, { triggerEvent: 'PING', payload: {} })).status).toBe(200);
        });

        it('the other workspace sees none of these meetings, and its own hook stores only into itself', async () => {
            expect(await meetings(otherAdmin, otherWorkspace)).toEqual([]);
            const res = await deliver(
                otherHookPath,
                booking('BOOKING_CREATED', { organizer: { email: adminEmail } }),
                `${SECRET}-other`,
            );
            // This workspace's admin is no member there.
            expect(res.body).toEqual({ result: 'unmatched' });
            expect(await owner.calendarEvent.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        });
    });
});
