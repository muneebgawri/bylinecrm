import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    MAIL_IMAGE_MAX_BYTES,
    MAIL_IMAGE_STORED_WIDTH,
    SESSION_COOKIE,
    type MailAssetView,
    type RichTextNode,
} from '@bylinecrm/shared';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
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

const rgba = (width: number, height: number) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([20, 80, 160, 255], i);
    return data;
};
const png = (width: number, height: number) => {
    const image = new PNG({ width, height });
    image.data = rgba(width, height);
    return PNG.sync.write(image);
};
const jpg = (width: number, height: number) =>
    Buffer.from(jpeg.encode({ width, height, data: rgba(width, height) }, 80).data);

/**
 * Images in mail: uploaded by whoever writes mail into their own workspace's storage, served publicly at an
 * unguessable https address, and kept by a body that links them — with tables — through to the email's HTML.
 * One workspace never uploads into another's, and an image's row is the workspace's own under RLS.
 */
describe('mail images', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let reader: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const upload = (who: Browser, ws: string, bytes: Buffer, contentType: string, filename = 'image.png') =>
        as(who).post(w('/mail-assets', ws)).attach('file', bytes, { filename, contentType });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`assets-admin-${stamp}@example.com`, `Pinion ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `assets-other-${stamp}@example.com`,
            `Other ${stamp}`,
        ));
        // A role that reads records but writes no mail: it may not upload.
        const role = await as(admin)
            .post(w('/roles'))
            .send({ name: `reader ${stamp}`, capabilities: ['record:read'] })
            .expect(201);
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `assets-reader-${stamp}@example.com`, roleId: (role.body as { id: string }).id })
            .expect(201);
        reader = browserFrom(
            await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201),
        );
        await verifyAddress(app, http, `assets-reader-${stamp}@example.com`);
    });

    afterAll(async () => {
        await app?.close();
    });

    let first: MailAssetView;

    it('stores a PNG, scaled to the stored width, and serves it publicly at an unguessable address', async () => {
        const res = await upload(admin, workspace, png(MAIL_IMAGE_STORED_WIDTH * 2, 300), 'image/png');
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        first = res.body as MailAssetView;
        expect(first).toMatchObject({ width: MAIL_IMAGE_STORED_WIDTH, height: 150, contentType: 'image/png' });
        expect(first.url).toMatch(/^https?:\/\/[^/]+\/api\/public\/mail-assets\/[A-Za-z0-9_-]{32,}\.png$/);
        const served = await http()
            .get(new URL(first.url).pathname)
            .buffer(true)
            .parse((r, done) => {
                const chunks: Buffer[] = [];
                r.on('data', (c: Buffer) => chunks.push(c));
                r.on('end', () => done(null, Buffer.concat(chunks)));
            });
        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toMatch(/^image\/png/);
        expect(PNG.sync.read(served.body as Buffer).width).toBe(MAIL_IMAGE_STORED_WIDTH);
    });

    it('keeps a JPEG a JPEG', async () => {
        const res = await upload(admin, workspace, jpg(400, 200), 'image/jpeg', 'photo.jpg');
        expect(res.status).toBe(201);
        const view = res.body as MailAssetView;
        expect(view).toMatchObject({ width: 400, height: 200, contentType: 'image/jpeg' });
        expect(view.url).toMatch(/\.jpg$/);
        const served = await http().get(new URL(view.url).pathname);
        expect(served.status).toBe(200);
        expect(served.headers['content-type']).toMatch(/^image\/jpeg/);
        // The same token under the other extension is no image.
        expect((await http().get(new URL(view.url).pathname.replace(/\.jpg$/, '.png'))).status).toBe(404);
    });

    it('refuses what is not a readable PNG or JPEG within the size limit', async () => {
        expect((await upload(admin, workspace, Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg')).status).toBe(415);
        expect((await upload(admin, workspace, Buffer.alloc(MAIL_IMAGE_MAX_BYTES + 1, 1), 'image/png')).status).toBe(
            413,
        );
        expect((await upload(admin, workspace, Buffer.from('not a png at all'), 'image/png')).status).toBe(422);
        expect((await http().get('/api/public/mail-assets/nope.png')).status).toBe(404);
    });

    it('needs a capability that writes mail', async () => {
        expect((await upload(reader, workspace, png(10, 10), 'image/png')).status).toBe(403);
    });

    it('never uploads into another workspace, and a workspace sees only its own images', async () => {
        expect((await upload(admin, otherWorkspace, png(10, 10), 'image/png')).status).toBe(403);
        const theirs = await upload(otherAdmin, otherWorkspace, png(20, 10), 'image/png');
        expect(theirs.status).toBe(201);
        const row = await owner.mailAsset.findUniqueOrThrow({ where: { id: (theirs.body as MailAssetView).id } });
        expect(row.workspaceId).toBe(otherWorkspace);
        expect(row.storageKey.startsWith(`${otherWorkspace}/`)).toBe(true);
        // Under RLS, this workspace's client cannot see the other's row.
        const seen = await rls.withWorkspace(workspace, (tx) => tx.mailAsset.findMany({ select: { id: true } }));
        expect(seen.map((a) => a.id)).toContain(first.id);
        expect(seen.map((a) => a.id)).not.toContain(row.id);
    });

    it('a template body keeps an uploaded image and a table through to the email’s HTML and text', async () => {
        const p = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
        const t = (text: string): RichTextNode => ({ type: 'text', text });
        const cell = (type: string, text: string): RichTextNode => ({ type, content: [p(t(text))] });
        const body = {
            type: 'doc',
            content: [
                p(t('Here is our team '), { type: 'image', attrs: { src: first.url, alt: 'The team', width: 300 } }),
                {
                    type: 'table',
                    content: [
                        { type: 'tableRow', content: [cell('tableHeader', 'Plan'), cell('tableHeader', 'Price')] },
                        { type: 'tableRow', content: [cell('tableCell', 'Basic'), cell('tableCell', '£10')] },
                    ],
                },
            ],
        };
        const created = await as(admin)
            .post(w('/templates'))
            .send({ name: `Media ${stamp}`, kind: 'personal', subject: 'Hello', body });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const person = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                nameLast: 'Reyes',
                emails: { primary: `dana-${stamp}@acme.example`, additional: [] },
            });
        expect(person.status).toBe(201);
        const dana = (person.body as { id: string }).id;
        const preview = await as(admin)
            .post(w(`/templates/${(created.body as { id: string }).id}/preview`))
            .send({ personId: dana });
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        const email = preview.body as { html: string; text: string };
        expect(email.html).toContain(`<img src="${first.url}" alt="The team" width="300"`);
        expect(email.html).toMatch(/<table [^>]*style="border-collapse:collapse;/);
        expect(email.html).toContain('padding:6px 10px');
        expect(email.text).toContain('[The team]');
        expect(email.text).toContain('Plan | Price\nBasic | £10');
    });
});
