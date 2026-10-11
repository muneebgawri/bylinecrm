import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
    MISSING_POSTAL_ADDRESS,
    SESSION_COOKIE,
    UNSUBSCRIBE_URL_PLACEHOLDER,
    type ApiErrorBody,
    type RichText,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
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

interface Template {
    id: string;
    name: string;
    kind: 'personal' | 'outreach';
    subject: string;
    body: RichText;
    version: number;
    updatedAt: string;
    deletedAt: string | null;
}
interface Rendered {
    subject: string;
    html: string;
    text: string;
    missing: string[];
    sendable: boolean;
}

const body = (...content: RichText['content'] & object): RichText => ({ type: 'doc', content });
const para = (...content: object[]) => ({ type: 'paragraph', content }) as never;
const v = (path: string) => ({ type: 'variable', attrs: { path } });
const t = (text: string) => ({ type: 'text', text });

const address = { line1: '123 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' };

/**
 * Email templates end to end (P2-4): validation of the subset and the variables, the outreach
 * gate, optimistic concurrency, the no-op rule, renders that never blank a variable, the locked
 * outreach footer — and the workspace boundary and owner scope around all of it.
 */
describe('email templates', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let writer: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let dana: string;
    let danasDeal: string;
    let writersPerson: string;
    let othersPerson: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const ow = (path: string) => `/api/w/${otherWorkspace}${path}`;
    const err = (res: Response) => res.body as ApiErrorBody;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Templates Co' })
            .expect(201);
        await verifyAddress(app, http, `admin-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        await verifyAddress(app, http, `other-${stamp}@example.test`);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        // A writer: personal templates only (no outreach:write), and only their own records.
        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'writer',
                capabilities: ['record:read', 'record:write', 'template:read', 'template:write'],
                recordScope: 'own',
            })
            .expect(201);
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `writer-${stamp}@example.test`, roleId: (role.body as { id: string }).id })
            .expect(201);
        writer = browserFrom(
            await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201),
        );
        await verifyAddress(app, http, `writer-${stamp}@example.test`);

        await as(admin)
            .post(w('/custom-fields'))
            .send({ object: 'person', key: 'beat', label: 'Beat', type: 'text' })
            .expect(201);
        const company = await as(admin).post(w('/companies')).send({ name: 'Acme & Sons' }).expect(201);
        const person = await as(admin)
            .post(w('/people'))
            .send({
                nameFirst: 'Dana',
                companyId: (company.body as { id: string }).id,
                custom: { beat: '<b>fintech</b>' },
            })
            .expect(201);
        dana = (person.body as { id: string }).id;
        const deal = await as(admin)
            .post(w('/opportunities'))
            .send({ name: 'Series B PR', amount: { amountMinor: 1200000, currency: 'USD' } })
            .expect(201);
        danasDeal = (deal.body as { id: string }).id;
        writersPerson = (
            (await as(writer).post(w('/people')).send({ nameFirst: 'Wren', nameLast: 'Writer' }).expect(201)).body as {
                id: string;
            }
        ).id;
        othersPerson = (
            (await as(other).post(ow('/people')).send({ nameFirst: 'Olive' }).expect(201)).body as { id: string }
        ).id;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('saving', () => {
        it('creates a personal template, version 1, with variables as nodes and tokens', async () => {
            const res = await as(admin)
                .post(w('/templates'))
                .send({
                    name: 'Intro',
                    kind: 'personal',
                    subject: 'Quick one for {{person.firstName}}',
                    body: body(para(t('Hi '), v('person.firstName'), t(' at '), v('company.name'))),
                })
                .expect(201);
            const template = res.body as Template;
            expect(template).toMatchObject({ name: 'Intro', kind: 'personal', version: 1, deletedAt: null });
            const got = await as(writer)
                .get(w(`/templates/${template.id}`))
                .expect(200);
            expect((got.body as Template).subject).toBe('Quick one for {{person.firstName}}');
        });

        it('refuses unknown variables, naming each where it sits', async () => {
            const res = await as(admin)
                .post(w('/templates'))
                .send({
                    name: 'Bad vars',
                    kind: 'personal',
                    subject: 'Hi {{person.password}}',
                    body: body(para(v('person.custom.nope'), v('person.custom.beat'))),
                })
                .expect(400);
            expect(err(res).code).toBe('validation.failed');
            expect(err(res).fieldErrors).toEqual([
                { path: 'subject', message: 'unknown variable "person.password"' },
                { path: 'body.content.0.content.0', message: 'unknown variable "person.custom.nope"' },
            ]);
        });

        it('refuses a body outside the template subset — a script node, a javascript: link', async () => {
            const res = await as(admin)
                .post(w('/templates'))
                .send({
                    name: 'Bad body',
                    kind: 'personal',
                    body: body(
                        { type: 'script', content: [t('alert(1)')] } as never,
                        para({
                            type: 'text',
                            text: 'x',
                            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                        }),
                    ),
                })
                .expect(400);
            expect(err(res).fieldErrors?.map((f) => f.path)).toEqual([
                'body.content.0',
                'body.content.1.content.0.marks.0.attrs.href',
            ]);
        });

        it('an outreach template needs outreach:write as well as template:write', async () => {
            const refused = await as(writer).post(w('/templates')).send({ name: 'Cold', kind: 'outreach' }).expect(403);
            expect(err(refused).code).toBe('forbidden');
            const own = await as(writer).post(w('/templates')).send({ name: 'Mine', kind: 'personal' }).expect(201);
            const mine = own.body as Template;
            // …including switching a personal one to outreach.
            await as(writer)
                .patch(w(`/templates/${mine.id}`))
                .send({ kind: 'outreach', version: 1 })
                .expect(403);
            // …and touching one an outreach writer made.
            const cold = (await as(admin).post(w('/templates')).send({ name: 'Cold', kind: 'outreach' }).expect(201))
                .body as Template;
            await as(writer)
                .patch(w(`/templates/${cold.id}`))
                .send({ name: 'Mine now', version: 1 })
                .expect(403);
            await as(writer)
                .delete(w(`/templates/${cold.id}`))
                .expect(403);
            await as(writer)
                .post(w(`/templates/${cold.id}/duplicate`))
                .expect(403);
        });
    });

    describe('optimistic concurrency and no-op writes', () => {
        let template: Template;
        beforeAll(async () => {
            template = (await as(admin).post(w('/templates')).send({ name: 'Versioned', kind: 'personal' }).expect(201))
                .body as Template;
        });

        it('a PATCH that names no version is refused', async () => {
            const res = await as(admin)
                .patch(w(`/templates/${template.id}`))
                .send({ name: 'x' })
                .expect(400);
            expect(err(res).fieldErrors?.[0]?.path).toBe('version');
        });

        it('the edited version bumps; a stale version is 409 conflict, never an overwrite', async () => {
            const first = await as(admin)
                .patch(w(`/templates/${template.id}`))
                .send({ subject: 'First edit', version: 1 })
                .expect(200);
            expect((first.body as Template).version).toBe(2);
            const stale = await as(admin)
                .patch(w(`/templates/${template.id}`))
                .send({ subject: 'Second edit from an old tab', version: 1 })
                .expect(409);
            expect(err(stale).code).toBe('conflict');
            expect(err(stale).message).toContain('now version 2');
            const after = await as(admin)
                .get(w(`/templates/${template.id}`))
                .expect(200);
            expect((after.body as Template).subject).toBe('First edit');
        });

        it('If-Match names the version as well as the body can', async () => {
            const res = await as(admin)
                .patch(w(`/templates/${template.id}`))
                .set('If-Match', '"2"')
                .send({ subject: 'Via If-Match' })
                .expect(200);
            expect((res.body as Template).version).toBe(3);
        });

        it('a PATCH that changes nothing writes nothing: same version, same updatedAt', async () => {
            const before = (
                await as(admin)
                    .get(w(`/templates/${template.id}`))
                    .expect(200)
            ).body as Template;
            const res = await as(admin)
                .patch(w(`/templates/${template.id}`))
                .send({ subject: before.subject, name: before.name, version: before.version })
                .expect(200);
            expect((res.body as Template).version).toBe(before.version);
            expect((res.body as Template).updatedAt).toBe(before.updatedAt);
        });

        it('delete, restore and duplicate', async () => {
            await as(admin)
                .delete(w(`/templates/${template.id}`))
                .expect(204);
            await as(admin)
                .get(w(`/templates/${template.id}`))
                .expect(404);
            const trash = await as(admin).get(w('/templates/deleted')).expect(200);
            expect((trash.body as { items: Template[] }).items.map((x) => x.id)).toContain(template.id);
            await as(admin)
                .post(w(`/templates/${template.id}/restore`))
                .expect(201);
            const copy = await as(admin)
                .post(w(`/templates/${template.id}/duplicate`))
                .expect(201);
            expect(copy.body as Template).toMatchObject({ name: 'Versioned (copy)', version: 1 });
        });
    });

    describe('rendering', () => {
        let personal: Template;
        let outreach: Template;
        beforeAll(async () => {
            personal = (
                await as(admin)
                    .post(w('/templates'))
                    .send({
                        name: 'Render me',
                        kind: 'personal',
                        subject: '{{person.firstName}} × {{deal.name}}',
                        body: body(
                            para(t('Hi '), v('person.firstName'), t(' '), v('person.lastName')),
                            para(v('company.name'), t(' / '), v('person.custom.beat'), t(' / '), v('deal.amount')),
                        ),
                    })
                    .expect(201)
            ).body as Template;
            outreach = (
                await as(admin)
                    .post(w('/templates'))
                    .send({
                        name: 'Cold intro',
                        kind: 'outreach',
                        body: body(para(t('Hello '), v('person.firstName'))),
                    })
                    .expect(201)
            ).body as Template;
        });

        it('fills what it can, escapes values, and never blanks a missing variable', async () => {
            const res = await as(admin)
                .post(w(`/templates/${personal.id}/preview`))
                .send({ personId: dana, dealId: danasDeal })
                .expect(200);
            const email = res.body as Rendered;
            expect(email.subject).toBe('Dana × Series B PR');
            expect(email.missing).toEqual(['person.lastName']);
            expect(email.sendable).toBe(false);
            expect(email.html).toContain('data-missing-variable="person.lastName"');
            expect(email.html).toContain('Acme &amp; Sons / &lt;b&gt;fintech&lt;/b&gt; / $12,000.00');
            expect(email.html).not.toContain('<b>fintech');
            expect(email.text).toContain('Hi Dana {{person.lastName}}');
        });

        it('a deal variable with no deal named is missing, not blank', async () => {
            const email = (
                await as(admin)
                    .post(w(`/templates/${personal.id}/preview`))
                    .send({ personId: dana })
                    .expect(200)
            ).body as Rendered;
            expect(email.missing).toEqual(['deal.name', 'person.lastName', 'deal.amount']);
        });

        it('an outreach render without a postal address names it and is not sendable; with one it is', async () => {
            const without = (
                await as(admin)
                    .post(w(`/templates/${outreach.id}/preview`))
                    .send({ personId: dana })
                    .expect(200)
            ).body as Rendered;
            expect(without.missing).toEqual([MISSING_POSTAL_ADDRESS]);
            expect(without.sendable).toBe(false);

            await as(writer)
                .put(w('/settings/mail'))
                .send({ postalAddress: address, unsubscribeFooterText: 'x' })
                .expect(403);
            const saved = await as(admin)
                .put(w('/settings/mail'))
                .send({
                    postalAddress: address,
                    defaultSenderName: null,
                    unsubscribeFooterText: DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
                })
                .expect(200);
            expect((saved.body as { postalAddress: { line2: null } }).postalAddress.line2).toBeNull();

            const withAddress = (
                await as(admin)
                    .post(w(`/templates/${outreach.id}/preview`))
                    .send({ personId: dana })
                    .expect(200)
            ).body as Rendered;
            expect(withAddress.sendable).toBe(true);
            expect(withAddress.html).toContain(`<a href="${UNSUBSCRIBE_URL_PLACEHOLDER}">Unsubscribe</a>`);
            expect(withAddress.html).toContain('123 Main St, Austin, TX, 78701, US');
        });

        it('the footer cannot be edited away: it is not part of the stored body', async () => {
            const res = await as(admin)
                .patch(w(`/templates/${outreach.id}`))
                .send({ body: { type: 'doc', content: [] }, version: outreach.version })
                .expect(200);
            expect(JSON.stringify((res.body as Template).body)).not.toContain('nsubscribe');
            const email = (
                await as(admin)
                    .post(w(`/templates/${outreach.id}/preview`))
                    .send({ personId: dana })
                    .expect(200)
            ).body as Rendered;
            expect(email.html).toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
        });

        it('previewing someone the caller cannot see is 404 — another owner’s, or another workspace’s', async () => {
            // The writer's role keeps its own records: Dana is the admin's.
            await as(writer)
                .post(w(`/templates/${personal.id}/preview`))
                .send({ personId: dana })
                .expect(404);
            await as(writer)
                .post(w(`/templates/${personal.id}/preview`))
                .send({ personId: writersPerson })
                .expect(200);
            await as(admin)
                .post(w(`/templates/${personal.id}/preview`))
                .send({ personId: othersPerson })
                .expect(404);
            await as(writer)
                .post(w(`/templates/${personal.id}/preview`))
                .send({ personId: writersPerson, dealId: danasDeal })
                .expect(404);
        });
    });

    describe('the workspace boundary', () => {
        let template: Template;
        beforeAll(async () => {
            template = (await as(admin).post(w('/templates')).send({ name: 'Ours', kind: 'personal' }).expect(201))
                .body as Template;
        });

        it('another workspace’s member cannot reach our routes, and our template id means nothing in theirs', async () => {
            await as(other)
                .get(w(`/templates/${template.id}`))
                .expect(403);
            const res = await as(other)
                .get(ow(`/templates/${template.id}`))
                .expect(404);
            expect(JSON.stringify(res.body)).not.toContain(workspace);
            await as(other)
                .post(ow(`/templates/${template.id}/preview`))
                .send({ personId: othersPerson })
                .expect(404);
            const list = await as(other).get(ow('/templates')).expect(200);
            expect((list.body as { items: Template[] }).items).toEqual([]);
        });

        it('our mail settings are ours: theirs still read the defaults', async () => {
            const theirs = await as(other).get(ow('/settings/mail')).expect(200);
            expect(theirs.body).toEqual({
                postalAddress: null,
                defaultSenderName: null,
                unsubscribeFooterText: DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
            });
        });

        it('the variables list carries the workspace’s own custom fields only', async () => {
            const ours = await as(admin).get(w('/templates/variables')).expect(200);
            const theirs = await as(other).get(ow('/templates/variables')).expect(200);
            const paths = (r: Response) => (r.body as { custom: { path: string }[] }).custom.map((c) => c.path);
            expect(paths(ours)).toContain('person.custom.beat');
            expect(paths(theirs)).not.toContain('person.custom.beat');
        });
    });
});
