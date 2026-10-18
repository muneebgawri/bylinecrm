import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    BOOKING_LINK_LABEL,
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_SCOPES,
    LOGO_GRACE_DAYS,
    LOGO_MAX_BYTES,
    LOGO_WIDTH,
    SESSION_COOKIE,
    SIGNATURE_STARTER,
    SYSTEM_ROLES,
    type ImportedSignature,
    type MailboxSignatureView,
    type RenderedSignature,
    type RichText,
    type RichTextNode,
    type SignatureProfileView,
    type SignatureSettingsView,
    type WorkspaceLogoView,
} from '@bylinecrm/shared';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { SLOTLINE_API_PORT } from '../../src/calendar/slotline/slotline-api.port';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
import { FakeSlotlineApi } from '../support/fake-slotline-api';
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

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const para = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const v = (path: string): RichTextNode => ({ type: 'variable', attrs: { path } });
const t = (text: string): RichTextNode => ({ type: 'text', text });
const img = (src: string, width?: number): RichTextNode => ({
    type: 'image',
    attrs: { src, alt: 'Badge', ...(width ? { width } : {}) },
});

/** The decoded text and HTML parts of a message the CRM sent, with the wire's CRLF line ends as LF. */
function partsOf(raw: string): { text: string; html: string } {
    const [, ...sections] = raw.split(/\r\n--bylinecrm-[0-9a-f]+(?:--)?\r\n?/);
    const decode = (contentType: string) => {
        const section = sections.find((s) => s.startsWith(`Content-Type: ${contentType}`));
        if (!section) throw new Error(`no ${contentType} part`);
        return Buffer.from(section.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64')
            .toString('utf8')
            .replace(/\r\n/g, '\n');
    };
    return { text: decode('text/plain'), html: decode('text/html') };
}

/**
 * Email signatures (#193) end to end: a workspace default with the logo and the Slotline booking link
 * pre-filled, a mailbox's own signature, an admin's locks, the logo served publicly at an unguessable
 * address, a Gmail signature imported as a draft, and the signature in the mail that goes — after the
 * body of a 1:1 send, per message. One workspace never reads, changes or sends another's signature or
 * logo; one member never another's.
 */
describe('#193 email signatures', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const slotlineApi = new FakeSlotlineApi();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `sig-admin-${stamp}@example.com`;
    const memberEmail = `sig-member-${stamp}@example.com`;
    const otherEmail = `sig-other-${stamp}@example.com`;
    const poolEmail = `sig-pool-${stamp}@example.com`;
    const slotline = 'https://bookings.example.com';

    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let memberId: string;
    let adminMemberId: string;
    let adminMailbox: string;
    let memberMailbox: string;
    let poolMailbox: string;
    let otherMailbox: string;
    let danaId: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };

    async function connect(who: Browser, ws: string, purpose: 'personal' | 'pool', email: string): Promise<string> {
        const start = await as(who).post(w('/mailboxes/connect', ws)).send({ purpose });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email,
            scopes: [...GMAIL_SCOPES],
        });
        await as(who).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const list = await as(who).get(w('/mailboxes', ws));
        return (list.body as { id: string; email: string }[]).find((m) => m.email === email)!.id;
    }

    async function sendAndDeliver(
        who: Browser,
        payload: Record<string, unknown>,
    ): Promise<{ text: string; html: string }> {
        const res = await as(who).post(w('/mail/send')).send(payload);
        expect(res.status, JSON.stringify(res.body)).toBe(202);
        await send.deliver(workspace, (res.body as { messageId: string }).messageId, noWait);
        return partsOf(gmail.sent.at(-1)!.raw);
    }

    const rgba = (width: number, height: number) => {
        const data = Buffer.alloc(width * height * 4);
        for (let i = 0; i < data.length; i += 4) data.set([20, 80, 160, 255], i);
        return data;
    };
    const png = (width: number, height: number) => {
        const image = new PNG({ width, height });
        image.data = rgba(width, height);
        return Promise.resolve(PNG.sync.write(image));
    };
    const jpg = (width: number, height: number) =>
        Buffer.from(jpeg.encode({ width, height, data: rgba(width, height) }, 80).data);
    const pngSize = (bytes: Buffer) => ({ width: PNG.sync.read(bytes).width, height: PNG.sync.read(bytes).height });
    const upload = (who: Browser, ws: string, bytes: Buffer, contentType: string, filename = 'logo.png') =>
        as(who).post(w('/settings/signatures/logo', ws)).attach('file', bytes, { filename, contentType });
    const settings = async (who = admin, ws = workspace) =>
        (await as(who).get(w('/settings/signatures', ws))).body as SignatureSettingsView;
    const putSettings = (body: object, who = admin, ws = workspace) =>
        as(who).put(w('/settings/signatures', ws)).send(body);
    const signatureOf = (mailbox: string, who = admin, ws = workspace) =>
        as(who).get(w(`/mailboxes/${mailbox}/signature`, ws));
    const putSignature = (mailbox: string, body: object, who = admin, ws = workspace) =>
        as(who)
            .put(w(`/mailboxes/${mailbox}/signature`, ws))
            .send(body);
    const putProfile = (id: string, body: object, who = admin, ws = workspace) =>
        as(who)
            .put(w(`/members/${id}/signature-profile`, ws))
            .send(body);

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(SLOTLINE_API_PORT)
            .useValue(slotlineApi)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        send = app.get(MailSendService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Pinion ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other ${stamp}`));

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
        const members = await owner.workspaceMember.findMany({
            where: { workspaceId: workspace },
            include: { user: true },
        });
        memberId = members.find((m) => m.user.email === memberEmail)!.id;
        adminMemberId = members.find((m) => m.user.email === adminEmail)!.id;
        await owner.user.update({ where: { email: memberEmail }, data: { displayName: 'Mia Member' } });

        for (const [who, ws, tag] of [
            [admin, workspace, 'a'],
            [otherAdmin, otherWorkspace, 'b'],
        ] as const) {
            const clientId = `444-${tag}${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
            const secret = `GOCSPX-sig-${tag}-${stamp}`;
            const view = await as(who).get(w('/mail/oauth-client', ws));
            google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
            await as(who).put(w('/mail/oauth-client', ws)).send({ clientId, clientSecret: secret }).expect(200);
        }
        adminMailbox = await connect(admin, workspace, 'personal', adminEmail);
        memberMailbox = await connect(member, workspace, 'personal', memberEmail);
        poolMailbox = await connect(admin, workspace, 'pool', poolEmail);
        otherMailbox = await connect(otherAdmin, otherWorkspace, 'personal', otherEmail);

        danaId = (
            (
                await as(member)
                    .post(w('/people'))
                    .send({
                        nameFirst: 'Dana',
                        nameLast: 'Reyes',
                        emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
                    })
            ).body as { id: string }
        ).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('the workspace default and the two pre-fills', () => {
        it('starts every signature with the logo and the booking link, and only an admin sets the default', async () => {
            const fresh = await settings(member);
            expect(fresh).toMatchObject({
                defaultSignature: null,
                locked: { logo: false, bookingLink: false },
                logo: null,
            });
            expect(fresh.starter).toEqual(SIGNATURE_STARTER);
            const paths = JSON.stringify(fresh.starter);
            expect(paths).toContain('workspace.logo');
            expect(paths).toContain('sender.bookingLink');

            expect(
                (
                    await putSettings(
                        { defaultSignature: SIGNATURE_STARTER, locked: { logo: false, bookingLink: false } },
                        member,
                    )
                ).status,
            ).toBe(403);
            const saved = await putSettings({
                defaultSignature: SIGNATURE_STARTER,
                locked: { logo: false, bookingLink: false },
            });
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            expect((await settings()).defaultSignature).toEqual(SIGNATURE_STARTER);
            // Another workspace's default is its own.
            expect((await settings(otherAdmin, otherWorkspace)).defaultSignature).toBeNull();
        });

        it('refuses what a signature cannot carry: a script, an image off https, a variable it does not know', async () => {
            for (const bad of [
                doc({ type: 'codeBlock', content: [t('alert(1)')] }),
                doc(para(img('http://cdn.example.com/badge.png'))),
                doc(para(img('javascript:alert(1)'))),
                doc(para(v('person.firstName'))),
                doc(para({ ...t('x'), marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] })),
            ]) {
                const res = await putSettings({ defaultSignature: bad, locked: { logo: false, bookingLink: false } });
                expect(res.status, JSON.stringify(bad)).toBe(400);
            }
        });
    });

    describe('the workspace logo', () => {
        let first: WorkspaceLogoView;

        it('an admin uploads it once; it is stored as a PNG at most 300px wide and served without a sign-in', async () => {
            expect((await upload(member, workspace, await png(900, 300), 'image/png')).status).toBe(403);
            const res = await upload(admin, workspace, await png(900, 300), 'image/png');
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            first = res.body as WorkspaceLogoView;
            expect(first).toMatchObject({ width: LOGO_WIDTH, height: 100 });
            expect(first.url).toMatch(/^https?:\/\/[^/]+\/api\/public\/logos\/[A-Za-z0-9_-]{32,}\.png$/);

            const served = await http().get(new URL(first.url).pathname);
            expect(served.status).toBe(200);
            expect(served.headers['content-type']).toBe('image/png');
            expect(served.headers['cache-control']).toContain('public');
            expect(pngSize(served.body as Buffer)).toEqual({ width: LOGO_WIDTH, height: 100 });
            expect((await settings(member)).logo).toEqual(first);
        });

        it('takes PNG or JPEG (stored as PNG), at most 200 KB; SVG is refused', async () => {
            // An admin of another workspace is no member here.
            expect((await upload(admin, otherWorkspace, jpg(600, 200), 'image/jpeg', 'logo.jpg')).status).toBe(403);
            const theirs = await upload(otherAdmin, otherWorkspace, jpg(600, 200), 'image/jpeg', 'logo.jpg');
            expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
            const served = await http().get(new URL((theirs.body as WorkspaceLogoView).url).pathname);
            expect(pngSize(served.body as Buffer)).toEqual({ width: LOGO_WIDTH, height: 100 });

            const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"></svg>');
            expect((await upload(admin, workspace, svg, 'image/svg+xml', 'logo.svg')).status).toBe(415);
            // A file whose bytes are not what it says is not read as anything else.
            expect((await upload(admin, workspace, svg, 'image/png')).status).toBe(422);
            expect((await upload(admin, workspace, Buffer.from('hello'), 'text/plain', 'x.txt')).status).toBe(415);
            const big = Buffer.alloc(LOGO_MAX_BYTES + 1, 1);
            expect((await upload(admin, workspace, big, 'image/png')).status).toBe(413);
            expect((await upload(admin, workspace, Buffer.from('not a png'), 'image/png')).status).toBe(422);
            // Neither changed this workspace's logo.
            expect((await settings()).logo).toEqual(first);
        });

        it('replacing it changes the address; the old one answers for a grace period, then not at all', async () => {
            const res = await upload(admin, workspace, await png(300, 300), 'image/png');
            expect(res.status).toBe(201);
            const second = res.body as WorkspaceLogoView;
            expect(second.url).not.toBe(first.url);
            expect((await http().get(new URL(first.url).pathname)).status).toBe(200);
            await owner.workspaceLogo.updateMany({
                where: { workspaceId: workspace, retiredAt: { not: null } },
                data: { retiredAt: new Date(Date.now() - (LOGO_GRACE_DAYS + 1) * 86_400_000) },
            });
            expect((await http().get(new URL(first.url).pathname)).status).toBe(404);
            expect((await http().get(new URL(second.url).pathname)).status).toBe(200);
            expect((await http().get('/api/public/logos/not-a-token.png')).status).toBe(404);
            // Another workspace cannot remove it.
            expect((await as(otherAdmin).delete(w('/settings/signatures/logo'))).status).toBe(403);
            expect((await settings()).logo).toEqual(second);
        });
    });

    describe('the booking link', () => {
        it('is the member’s Slotline page, set by username — by the member or an admin, never another member', async () => {
            const own = await putProfile(
                memberId,
                { jobTitle: 'Account manager', phone: null, slotlineUsername: 'mia' },
                member,
            );
            expect(own.status, JSON.stringify(own.body)).toBe(200);
            // No Slotline yet: no link.
            expect(own.body as SignatureProfileView).toMatchObject({
                slotlineUsername: 'mia',
                bookingLink: null,
                slotlineConfigured: false,
            });

            await as(admin)
                .put(w('/integrations/slotline'))
                .send({ baseUrl: slotline, secret: `slotline-secret-${stamp}` })
                .expect(200);
            const read = await as(member).get(w(`/members/${memberId}/signature-profile`));
            expect(read.body as SignatureProfileView).toMatchObject({
                bookingLink: `${slotline}/mia`,
                slotlineConfigured: true,
            });

            expect(
                (await putProfile(adminMemberId, { jobTitle: 'Nope', phone: null, slotlineUsername: null }, member))
                    .status,
            ).toBe(403);
            expect((await as(member).get(w(`/members/${adminMemberId}/signature-profile`))).status).toBe(403);
            expect(
                (
                    await putProfile(adminMemberId, {
                        jobTitle: 'Founder',
                        phone: '+92 300 1234567',
                        slotlineUsername: 'matt',
                    })
                ).status,
            ).toBe(200);
            expect(
                (
                    await putProfile(
                        memberId,
                        { jobTitle: 'Account manager', phone: null, slotlineUsername: '../evil' },
                        member,
                    )
                ).status,
            ).toBe(400);
            // An admin sees every member's details in one list, with their names; a member does not.
            const list = await as(admin).get(w('/members/signature-profiles'));
            expect(list.status, JSON.stringify(list.body)).toBe(200);
            expect(list.body as SignatureProfileView[]).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ memberId, name: 'Mia Member', slotlineUsername: 'mia' }),
                    expect.objectContaining({ memberId: adminMemberId, slotlineUsername: 'matt' }),
                ]),
            );
            expect((await as(member).get(w('/members/signature-profiles'))).status).toBe(403);
            expect(
                (
                    (await as(otherAdmin).get(w('/members/signature-profiles', otherWorkspace)))
                        .body as SignatureProfileView[]
                ).map((p) => p.memberId),
            ).not.toContain(memberId);
            // Another workspace's admin reaches no member here.
            expect(
                (await putProfile(memberId, { jobTitle: 'x', phone: null, slotlineUsername: null }, otherAdmin)).status,
            ).toBe(403);
        });
    });

    describe('a mailbox’s signature', () => {
        it('takes the default until it has its own; only its member or an admin reads or changes it', async () => {
            const before = (await signatureOf(memberMailbox, member)).body as MailboxSignatureView;
            expect(before).toMatchObject({
                own: null,
                useDefault: true,
                applies: 'default',
                effective: SIGNATURE_STARTER,
            });

            const mine = doc(
                para(v('sender.fullName')),
                para(t('Pinion Partners')),
                para(v('sender.bookingLink')),
                para(v('workspace.logo')),
            );
            const saved = await putSignature(memberMailbox, { own: mine, useDefault: true }, member);
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            expect(saved.body as MailboxSignatureView).toMatchObject({ applies: 'own', effective: mine });

            // Another member's mailbox: neither read nor changed.
            expect((await signatureOf(adminMailbox, member)).status).toBe(403);
            expect((await putSignature(adminMailbox, { own: mine, useDefault: true }, member)).status).toBe(403);
            // A pool mailbox is the admin's to sign.
            expect((await putSignature(poolMailbox, { own: mine, useDefault: true }, member)).status).toBe(403);
            // Another workspace's mailbox does not exist here, and ours does not exist there.
            expect((await signatureOf(otherMailbox)).status).toBe(404);
            expect((await signatureOf(memberMailbox, otherAdmin, otherWorkspace)).status).toBe(404);
            expect(
                (await putSignature(memberMailbox, { own: null, useDefault: false }, otherAdmin, otherWorkspace))
                    .status,
            ).toBe(404);
            // An admin may set a member's.
            expect((await signatureOf(memberMailbox)).body as MailboxSignatureView).toMatchObject({ applies: 'own' });
        });

        it('a member can switch the default off for their own mailbox', async () => {
            const res = await putSignature(adminMailbox, { own: null, useDefault: false });
            expect(res.body as MailboxSignatureView).toMatchObject({ applies: 'none', effective: null });
            await putSignature(adminMailbox, { own: null, useDefault: true }).expect(200);
        });

        it('a pool mailbox links to the booking page an admin picks, on the Slotline site only', async () => {
            const off = await putSignature(poolMailbox, {
                own: null,
                useDefault: true,
                bookingLink: 'https://evil.example.com/mia',
            });
            expect(off.status).toBe(422);
            const on = await putSignature(poolMailbox, {
                own: null,
                useDefault: true,
                bookingLink: `${slotline}/team`,
            });
            expect(on.status, JSON.stringify(on.body)).toBe(200);
            expect(on.body as MailboxSignatureView).toMatchObject({ bookingLink: `${slotline}/team` });
            // A personal mailbox's link is its member's; it cannot be picked.
            expect(
                (
                    await putSignature(
                        memberMailbox,
                        { own: null, useDefault: true, bookingLink: `${slotline}/x` },
                        member,
                    )
                ).status,
            ).toBe(422);
        });

        it('renders as it would in an email: the logo, the booking link, and no line left empty', async () => {
            const res = await as(member)
                .post(w('/signatures/preview'))
                .send({
                    mailboxId: memberMailbox,
                    signature: doc(
                        para(v('sender.fullName')),
                        para(v('sender.phone')),
                        para(v('sender.bookingLink')),
                        para(v('workspace.logo')),
                    ),
                });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const out = res.body as RenderedSignature;
            const logo = (await settings()).logo!;
            expect(out.html).toContain('Mia Member');
            expect(out.html).toContain(`<a href="${slotline}/mia">${BOOKING_LINK_LABEL}</a>`);
            expect(out.html).toContain(`<img src="${logo.url}" alt="Pinion ${stamp}" width="${logo.width}"`);
            // Mia has no phone: that line is left out, not rendered empty.
            expect(out.html).not.toContain('<p></p>');
            expect(out.text).toBe(`Mia Member\n\n${BOOKING_LINK_LABEL}: ${slotline}/mia`);
        });
    });

    describe('an admin’s locks', () => {
        it('keeps the logo in every signature once locked', async () => {
            const noLogo = doc(para(v('sender.fullName')));
            expect(
                (await putSettings({ defaultSignature: noLogo, locked: { logo: true, bookingLink: false } })).status,
            ).toBe(422);
            await putSettings({
                defaultSignature: SIGNATURE_STARTER,
                locked: { logo: true, bookingLink: false },
            }).expect(200);
            expect((await putSignature(memberMailbox, { own: noLogo, useDefault: true }, member)).status).toBe(422);
            expect((await putSignature(memberMailbox, { own: null, useDefault: false }, member)).status).toBe(422);
            // Per message too: a send cannot drop it.
            const refused = await as(member)
                .post(w('/mail/send'))
                .send({
                    mailboxId: memberMailbox,
                    personId: danaId,
                    subject: 'Hi',
                    body: doc(para(t('Hello'))),
                    signature: null,
                });
            expect(refused.status).toBe(422);
            await putSettings({
                defaultSignature: SIGNATURE_STARTER,
                locked: { logo: false, bookingLink: false },
            }).expect(200);
        });
    });

    describe('in the mail that goes', () => {
        it('a 1:1 send carries the mailbox’s signature after the body, unless the message says otherwise', async () => {
            const logo = (await settings()).logo!;
            const sent = await sendAndDeliver(member, {
                mailboxId: memberMailbox,
                personId: danaId,
                subject: 'Hello',
                body: doc(para(t('Body first.'))),
            });
            expect(sent.html.indexOf('Body first.')).toBeLessThan(sent.html.indexOf('Pinion Partners'));
            expect(sent.html).toContain(`<img src="${logo.url}"`);
            expect(sent.html).toContain(`href="${slotline}/mia"`);
            expect(sent.text).toContain('Body first.\n\n-- \nMia Member');

            const none = await sendAndDeliver(member, {
                mailboxId: memberMailbox,
                personId: danaId,
                subject: 'No signature',
                body: doc(para(t('Just this.'))),
                signature: null,
            });
            expect(none.html).not.toContain('Pinion Partners');
            expect(none.text).not.toContain('-- ');

            const edited = await sendAndDeliver(member, {
                mailboxId: memberMailbox,
                personId: danaId,
                subject: 'Edited',
                body: doc(para(t('Hi.'))),
                signature: doc(para(t('Mia, on the road'))),
            });
            expect(edited.html).toContain('Mia, on the road');
            expect(edited.html).not.toContain('Pinion Partners');
        });

        it('a template preview shows the signature that would apply', async () => {
            const template = await as(admin)
                .post(w('/templates'))
                .send({ name: `Hello ${stamp}`, kind: 'personal', subject: 'Hi', body: doc(para(t('Template body'))) });
            expect(template.status).toBe(201);
            const preview = await as(member)
                .post(w(`/templates/${(template.body as { id: string }).id}/preview`))
                .send({ personId: danaId, mailboxId: memberMailbox });
            expect(preview.status, JSON.stringify(preview.body)).toBe(200);
            const html = (preview.body as { html: string }).html;
            expect(html.indexOf('Template body')).toBeLessThan(html.indexOf('Pinion Partners'));
        });

        it('{{sender.signature}} places it: where the template names it, once, and a P.S. can follow', async () => {
            const offered = (await as(member).get(w('/templates/variables'))).body as { standard: { path: string }[] };
            expect(offered.standard.map((v) => v.path)).toContain('sender.signature');
            const template = await as(admin)
                .post(w('/templates'))
                .send({
                    name: `Placed ${stamp}`,
                    kind: 'personal',
                    subject: 'Hi',
                    body: doc(para(t('Body first.')), para(v('sender.signature')), para(t('P.S. Friday works.'))),
                });
            expect(template.status, JSON.stringify(template.body)).toBe(201);
            const preview = await as(member)
                .post(w(`/templates/${(template.body as { id: string }).id}/preview`))
                .send({ personId: danaId, mailboxId: memberMailbox });
            const html = (preview.body as { html: string }).html;
            expect(html.indexOf('Pinion Partners')).toBeGreaterThan(html.indexOf('Body first.'));
            expect(html.indexOf('Pinion Partners')).toBeLessThan(html.indexOf('P.S. Friday works.'));
            expect(html.split('Pinion Partners')).toHaveLength(2);

            const sent = await sendAndDeliver(member, {
                mailboxId: memberMailbox,
                personId: danaId,
                templateId: (template.body as { id: string }).id,
            });
            expect(sent.html.indexOf('Pinion Partners')).toBeLessThan(sent.html.indexOf('P.S. Friday works.'));
            expect(sent.html.split('Pinion Partners')).toHaveLength(2);
            expect(sent.text).toContain('-- \nMia Member');
        });

        it('a subject cannot carry it: a signature belongs in the body', async () => {
            const res = await as(admin)
                .post(w('/templates'))
                .send({
                    name: `Subject ${stamp}`,
                    kind: 'personal',
                    subject: 'Hi {{sender.signature}}',
                    body: doc(para(t('x'))),
                });
            expect(res.status).toBe(400);
            expect((res.body as { fieldErrors: { path: string }[] }).fieldErrors.map((f) => f.path)).toEqual([
                'subject',
            ]);
        });
    });

    describe('import from Gmail', () => {
        it('copies the mailbox’s Gmail signature into a draft — https images only, nothing executable — and saves nothing', async () => {
            gmail.setSignature(
                memberEmail,
                '<div dir="ltr"><b>Mia Member</b><br>Account manager<br>' +
                    '<a href="https://pinionpartners.co">pinionpartners.co</a><br>' +
                    '<img src="https://cdn.example.com/badge.png" width="900" alt="Badge">' +
                    '<img src="http://cdn.example.com/tracker.gif">' +
                    '<script>alert(1)</script><span onclick="x()">Call me</span></div>',
            );
            const before = (await signatureOf(memberMailbox, member)).body as MailboxSignatureView;
            const res = await as(member).post(w(`/mailboxes/${memberMailbox}/signature/import`));
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            const imported = res.body as ImportedSignature;
            expect(imported.droppedImages).toBe(1);
            const json = JSON.stringify(imported.signature);
            expect(json).toContain('Mia Member');
            expect(json).toContain('"bold"');
            expect(json).toContain('https://pinionpartners.co');
            expect(json).toContain('https://cdn.example.com/badge.png');
            expect(json).toContain('"width":600');
            expect(json).toContain('Call me');
            expect(json).not.toContain('alert');
            expect(json).not.toContain('onclick');
            expect(json).not.toContain('tracker');
            // The draft is saved only when the member saves it.
            expect((await signatureOf(memberMailbox, member)).body).toEqual(before);
            // It is a valid signature as imported.
            await putSignature(memberMailbox, { own: imported.signature, useDefault: true }, member).expect(200);
            await putSignature(memberMailbox, { own: before.own, useDefault: true }, member).expect(200);
        });

        it('only the mailbox’s member or an admin may import, and never across workspaces', async () => {
            expect((await as(member).post(w(`/mailboxes/${adminMailbox}/signature/import`))).status).toBe(403);
            expect(
                (await as(otherAdmin).post(w(`/mailboxes/${memberMailbox}/signature/import`, otherWorkspace))).status,
            ).toBe(404);
        });
    });

    describe('#196 a Slotline event type for the booking link', () => {
        const miaKey = `cal_live_mia_${stamp}_k3y9`;
        const mattKey = `cal_live_matt_${stamp}_x1x2`;
        const type = (slug: string, title: string, hidden: boolean) => ({ slug, title, lengthInMinutes: 15, hidden });
        const putKey = (id: string, apiKey: string, who = member, ws = workspace) =>
            as(who)
                .put(w(`/members/${id}/slotline-key`, ws))
                .send({ apiKey });
        const eventTypes = (id: string, who = member, ws = workspace) =>
            as(who).get(w(`/members/${id}/slotline/event-types`, ws));
        const pick = (id: string, slug: string | null, who = member) =>
            as(who)
                .put(w(`/members/${id}/slotline-event`))
                .send({ slug });
        const profileOf = async (id: string, who = member) =>
            (await as(who).get(w(`/members/${id}/signature-profile`))).body as SignatureProfileView;

        beforeAll(() => {
            slotlineApi.addAccount(miaKey, {
                username: 'mia',
                eventTypes: [type('intro', 'Intro call', false), type('vip-15', 'VIP 15', true)],
            });
            slotlineApi.addAccount(mattKey, { username: 'matt', eventTypes: [type('chat', 'Chat', false)] });
        });

        it('a key Slotline refuses is not stored', async () => {
            const res = await putKey(memberId, 'cal_live_wrong_key');
            expect(res.status).toBe(422);
            expect((await profileOf(memberId)).slotlineKey).toBeNull();
        });

        it('a key Slotline accepts is stored encrypted, shown by its last four only, and sets the username', async () => {
            const res = await putKey(memberId, miaKey);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body as SignatureProfileView).toMatchObject({
                slotlineUsername: 'mia',
                slotlineKey: { last4: 'k3y9' },
            });
            expect(JSON.stringify(res.body)).not.toContain(miaKey);
            const row = await owner.workspaceMember.findUniqueOrThrow({ where: { id: memberId } });
            expect(row.slotlineApiKeyCiphertext).toBeTruthy();
            expect(row.slotlineApiKeyCiphertext).not.toContain(miaKey);
            expect(slotlineApi.calls.at(-1)).toMatchObject({ method: 'me', baseUrl: slotline, keyLast4: 'k3y9' });
        });

        it('lists every event type on the account, hidden ones too, with their links', async () => {
            const res = await eventTypes(memberId);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body).toEqual([
                {
                    slug: 'intro',
                    title: 'Intro call',
                    lengthInMinutes: 15,
                    hidden: false,
                    bookingLink: `${slotline}/mia/intro`,
                },
                {
                    slug: 'vip-15',
                    title: 'VIP 15',
                    lengthInMinutes: 15,
                    hidden: true,
                    bookingLink: `${slotline}/mia/vip-15`,
                },
            ]);
        });

        it('the picked one is what “Book a quick meeting” opens; one not on the account is refused', async () => {
            expect((await pick(memberId, 'not-mine')).status).toBe(422);
            const res = await pick(memberId, 'vip-15');
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body as SignatureProfileView).toMatchObject({
                slotlineEvent: { slug: 'vip-15', title: 'VIP 15' },
                bookingLink: `${slotline}/mia/vip-15`,
            });
            const preview = await as(member)
                .post(w('/signatures/preview'))
                .send({ mailboxId: memberMailbox, signature: doc(para(v('sender.bookingLink'))) });
            expect((preview.body as RenderedSignature).html).toBe(
                `<p><a href="${slotline}/mia/vip-15">${BOOKING_LINK_LABEL}</a></p>`,
            );
        });

        it('a key, a list and a pick are the member’s own: not an admin’s, not another member’s, not another workspace’s', async () => {
            expect((await putKey(memberId, mattKey, admin)).status).toBe(403);
            expect((await eventTypes(memberId, admin)).status).toBe(403);
            expect((await pick(memberId, 'intro', admin)).status).toBe(403);
            expect((await putKey(adminMemberId, miaKey)).status).toBe(403);
            expect((await eventTypes(adminMemberId)).status).toBe(403);
            expect((await as(member).delete(w(`/members/${adminMemberId}/slotline-key`))).status).toBe(403);
            expect((await eventTypes(memberId, otherAdmin)).status).toBe(403);
            // The admin's own key lists the admin's account, never Mia's.
            await putKey(adminMemberId, mattKey, admin).expect(200);
            expect(((await eventTypes(adminMemberId, admin)).body as { slug: string }[]).map((e) => e.slug)).toEqual([
                'chat',
            ]);
        });

        it('while a key is set, the username is Slotline’s: it cannot be typed over', async () => {
            const res = await putProfile(
                memberId,
                { jobTitle: 'Account manager', phone: null, slotlineUsername: 'someone-else' },
                member,
            );
            expect(res.status).toBe(422);
            await putProfile(
                memberId,
                { jobTitle: 'Account manager', phone: null, slotlineUsername: 'mia' },
                member,
            ).expect(200);
        });

        it('says so when Slotline does not answer, and changes nothing', async () => {
            slotlineApi.goDown();
            const res = await eventTypes(memberId);
            expect(res.status).toBe(409);
            expect((await profileOf(memberId)).slotlineEvent).toMatchObject({ slug: 'vip-15' });
        });

        it('a workspace without Slotline cannot take a key', async () => {
            const otherMember = (
                await owner.workspaceMember.findFirstOrThrow({ where: { workspaceId: otherWorkspace } })
            ).id;
            expect((await putKey(otherMember, mattKey, otherAdmin, otherWorkspace)).status).toBe(409);
        });

        it('removing the key keeps the link, and the list then asks for a key', async () => {
            await pick(memberId, null).expect(200);
            expect((await profileOf(memberId)).bookingLink).toBe(`${slotline}/mia`);
            await as(member)
                .delete(w(`/members/${memberId}/slotline-key`))
                .expect(204);
            expect(await profileOf(memberId)).toMatchObject({ slotlineKey: null, slotlineUsername: 'mia' });
            expect((await eventTypes(memberId)).status).toBe(409);
        });
    });
});
