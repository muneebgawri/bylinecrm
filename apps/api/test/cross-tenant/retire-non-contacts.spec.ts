import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { parseArgs, retireNonContacts } from '../../src/cli/retire-non-contacts';
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

/**
 * #383: a colleague's or an automated sender's address is nobody's contact. The API refuses such a person on create
 * and on edit; `retire-non-contacts.js` retires the ones that got in before the rule, through the people service's
 * own delete, keeping any a deal points at or that carries notes or tasks.
 */
describe('retire-non-contacts: colleagues and automated senders are not contacts', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `rnc-admin-${stamp}@example.test`;
    let admin: Browser;
    let workspace: string;
    /** A real contact: untouched. */
    let lead: string;
    /** The admin's own sign-in address, as a person: retired. */
    let colleague: string;
    /** A bounce handler, as a person: retired. */
    let bounce: string;
    /** A notification stream that a deal points at: kept for a human. */
    let notifier: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const person = (name: string, primary: string) =>
        as(admin)
            .post(w('/people'))
            .send({ nameFirst: name, emails: { primary, additional: [] } });
    /** A person the rule would refuse today, as an earlier system left them: made as a contact, then re-addressed. */
    const seeded = async (name: string, primary: string) => {
        const made = id(await person(name, `was-${name.toLowerCase()}-${stamp}@contact.test`).expect(201));
        await owner.person.update({
            where: { id: made },
            data: { emails: { primary, additional: [] } },
        });
        return made;
    };
    const live = async (personId: string) =>
        (await owner.person.findUniqueOrThrow({ where: { id: personId }, select: { deletedAt: true } })).deletedAt ===
        null;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Rnc ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        lead = id(await person('Lead', `lead-${stamp}@example.test`).expect(201));
        colleague = await seeded('Colleague', adminEmail);
        bounce = await seeded('Bounce', `mailer-daemon@mx-${stamp}.test`);
        notifier = await seeded('Notifier', `notifications@tool-${stamp}.test`);
        const company = id(
            await as(admin)
                .post(w('/companies'))
                .send({ name: `Tool ${stamp}`, domain: `tool-${stamp}.test` })
                .expect(201),
        );
        await as(admin)
            .post(w('/opportunities'))
            .send({ name: `Deal ${stamp}`, currency: 'USD', pointOfContactId: notifier, companyId: company })
            .expect(201);
    });

    afterAll(async () => {
        await app.close();
    });

    it('reads its flags', () => {
        expect(parseArgs(['acme', '--estimate'])).toEqual({ slug: 'acme', options: { apply: false } });
        expect(parseArgs(['acme', '--apply', '--chunk', '5'])).toEqual({
            slug: 'acme',
            options: { apply: true, chunk: 5 },
        });
        expect(parseArgs(['acme'])).toBeNull();
        expect(parseArgs(['acme', '--estimate', '--apply'])).toBeNull();
        expect(parseArgs(['--apply'])).toBeNull();
    });

    it("refuses a person with a member's address or an automated sender's, on create and on edit", async () => {
        const member = await person('Me', adminEmail.toUpperCase());
        expect(member.status).toBe(422);
        expect((member.body as { message: string }).message).toMatch(/member/);
        const daemon = await person('Daemon', `postmaster@elsewhere-${stamp}.test`);
        expect(daemon.status).toBe(422);
        expect((daemon.body as { message: string }).message).toMatch(/automated sender/);
        const edit = await as(admin)
            .patch(w(`/people/${lead}`))
            .send({ emails: { primary: `no-reply@elsewhere-${stamp}.test`, additional: [] } });
        expect(edit.status).toBe(422);
        // The same address, unchanged, is not the reason an edit fails.
        await as(admin)
            .patch(w(`/people/${lead}`))
            .send({ nameLast: 'Still' })
            .expect(200);
    });

    it('estimates without writing: the colleague and the bounce would go, the notifier a deal points at stays', async () => {
        const report = await retireNonContacts(app, workspace, { apply: false });
        expect(report).toEqual({
            candidates: 3,
            staff: 1,
            system: 2,
            retired: 2,
            kept: { deals: 1, notes: 0, tasks: 0 },
        });
        for (const p of [lead, colleague, bounce, notifier]) expect(await live(p), p).toBe(true);
    });

    it('retires them through the people service: deleted by the system, announced, the rest untouched', async () => {
        const report = await retireNonContacts(app, workspace, { apply: true, chunk: 1 });
        expect(report).toEqual({
            candidates: 3,
            staff: 1,
            system: 2,
            retired: 2,
            kept: { deals: 1, notes: 0, tasks: 0 },
        });
        expect(await live(colleague)).toBe(false);
        expect(await live(bounce)).toBe(false);
        expect(await live(notifier)).toBe(true);
        expect(await live(lead)).toBe(true);
        const announced = await owner.outboxEvent.findMany({
            where: { workspaceId: workspace, type: 'person.deleted' },
            select: { payload: true },
        });
        const deleted = announced.map((e) => e.payload as { recordId: string; actor: { kind: string } });
        expect(deleted.map((d) => d.recordId).sort()).toEqual([bounce, colleague].sort());
        expect(deleted.every((d) => d.actor.kind === 'system')).toBe(true);
    });

    it('is idempotent: a rerun finds only the one a human must decide', async () => {
        const again = await retireNonContacts(app, workspace, { apply: true });
        expect(again).toEqual({
            candidates: 1,
            staff: 0,
            system: 1,
            retired: 0,
            kept: { deals: 1, notes: 0, tasks: 0 },
        });
    });
});
