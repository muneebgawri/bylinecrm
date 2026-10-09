import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    ERROR_CODES,
    REQUEST_ID_HEADER,
    SESSION_COOKIE,
    type ApiErrorBody,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';

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
    if (!session || !csrf) throw new Error('signup did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/** Every error body, whatever produced it, is exactly the envelope and its id matches the header. */
function expectEnvelope(res: Response, statusCode: number, code: string): ApiErrorBody {
    const body = res.body as ApiErrorBody;
    expect(res.status).toBe(statusCode);
    expect(Object.keys(body).sort()).toEqual(
        body.fieldErrors
            ? ['code', 'fieldErrors', 'message', 'requestId', 'statusCode']
            : ['code', 'message', 'requestId', 'statusCode'],
    );
    expect(body.statusCode).toBe(statusCode);
    expect(body.code).toBe(code);
    expect(ERROR_CODES).toContain(body.code);
    expect(typeof body.message).toBe('string');
    expect(body.requestId).toBe(res.headers[REQUEST_ID_HEADER]);
    return body;
}

/**
 * The one error envelope end to end (P1-1d): every way the real application fails — a DTO that
 * does not validate, a body that is not JSON, an unknown route, a custom-field value of the
 * wrong type, a unique collision, a refused gate — answers with the same body, and nothing in a
 * refusal about another workspace's record names that record.
 */
describe('errors', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let mine: Browser;
    let theirs: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let theirPerson: { id: string; nameFirst: string; email: string };

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `errors-${stamp}@example.test`, password, workspaceName: 'Errors Co' })
            .expect(201);
        mine = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `errors-other-${stamp}@example.test`, password, workspaceName: 'Secret Rivals Ltd' })
            .expect(201);
        theirs = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;
        const email = `confidential-${stamp}@rival.test`;
        const created = await as(theirs)
            .post(`/api/w/${otherWorkspace}/people`)
            .send({ nameFirst: 'Zebediah', emails: { primary: email, additional: [] } })
            .expect(201);
        theirPerson = { id: (created.body as { id: string }).id, nameFirst: 'Zebediah', email };

        await as(mine)
            .post(w('/custom-fields'))
            .send({ object: 'person', key: 'score', label: 'Score', type: 'number' })
            .expect(201);
    });

    afterAll(async () => {
        await app.close();
    });

    it('every response carries a request id header, success included', async () => {
        const res = await http().get('/health');
        expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('a well-formed inbound request id is echoed; a malformed one is replaced', async () => {
        const kept = await http().get('/health').set(REQUEST_ID_HEADER, 'edge-7f3a9c1e');
        expect(kept.headers[REQUEST_ID_HEADER]).toBe('edge-7f3a9c1e');
        const replaced = await http().get('/health').set(REQUEST_ID_HEADER, 'bad id');
        expect(replaced.headers[REQUEST_ID_HEADER]).not.toBe('bad id');
    });

    it('a request DTO that fails validation: 400 validation.failed with field paths', async () => {
        const res = await as(mine)
            .post(w('/people'))
            .send({ nameFirst: 42, emails: { primary: 'not-an-email' } });
        const body = expectEnvelope(res, 400, 'validation.failed');
        expect(body.fieldErrors?.map((e) => e.path)).toEqual(expect.arrayContaining(['nameFirst', 'emails.primary']));
    });

    it('a body that is not JSON: 400 validation.failed, the plain message', async () => {
        const res = await as(mine).post(w('/people')).set('Content-Type', 'application/json').send('{"nameFirst":');
        const body = expectEnvelope(res, 400, 'validation.failed');
        expect(body.message).toBe('the request body is not valid JSON');
    });

    it('an unknown route: 404 not_found', async () => {
        expectEnvelope(await as(mine).get('/api/no-such-route'), 404, 'not_found');
    });

    it('no session: 401 unauthorized', async () => {
        expectEnvelope(await http().get(w('/people')), 401, 'unauthorized');
    });

    it('a custom-field value of the wrong type arrives as a field error under custom.<key>', async () => {
        const res = await as(mine)
            .post(w('/people'))
            .send({ nameFirst: 'Typed', custom: { score: 'nine' } });
        const body = expectEnvelope(res, 400, 'validation.failed');
        expect(body.fieldErrors?.map((e) => e.path)).toEqual(['custom.score']);
    });

    it('an unknown custom field arrives as a field error under its key', async () => {
        const res = await as(mine)
            .post(w('/people'))
            .send({ nameFirst: 'Typed', custom: { nope: 1 } });
        const body = expectEnvelope(res, 400, 'validation.failed');
        expect(body.fieldErrors).toEqual([{ path: 'custom.nope', message: 'unknown custom field' }]);
    });

    it('a unique violation arrives as conflict.unique with the field', async () => {
        const email = `unique-${stamp}@x.test`;
        await as(mine)
            .post(w('/people'))
            .send({ nameFirst: 'First', emails: { primary: email, additional: [] } })
            .expect(201);
        const res = await as(mine)
            .post(w('/people'))
            .send({ nameFirst: 'Second', emails: { primary: email, additional: [] } });
        const body = expectEnvelope(res, 409, 'conflict.unique');
        expect(body.fieldErrors?.map((e) => e.path)).toEqual(['emails.primary']);
    });

    it('a duplicate custom-field key is conflict.unique on key', async () => {
        const res = await as(mine)
            .post(w('/custom-fields'))
            .send({ object: 'person', key: 'score', label: 'Score again', type: 'number' });
        const body = expectEnvelope(res, 409, 'conflict.unique');
        expect(body.fieldErrors?.map((e) => e.path)).toEqual(['key']);
    });

    describe('refusals about another workspace leak nothing about it', () => {
        const leaks = (body: ApiErrorBody) => {
            const wire = JSON.stringify(body);
            for (const secret of [
                otherWorkspace,
                theirPerson.id,
                theirPerson.nameFirst,
                theirPerson.email,
                'Secret Rivals',
            ]) {
                expect(wire).not.toContain(secret);
            }
        };

        it('their record in my workspace path: 404 not_found, no ids or names', async () => {
            const res = await as(mine).get(w(`/people/${theirPerson.id}`));
            leaks(expectEnvelope(res, 404, 'not_found'));
        });

        it('patching their record through my workspace: 404, no ids or names', async () => {
            const res = await as(mine)
                .patch(w(`/people/${theirPerson.id}`))
                .send({ nameFirst: 'Hijack' });
            leaks(expectEnvelope(res, 404, 'not_found'));
        });

        it('their workspace path: 403 forbidden, no ids or names', async () => {
            const res = await as(mine).get(`/api/w/${otherWorkspace}/people/${theirPerson.id}`);
            leaks(expectEnvelope(res, 403, 'forbidden'));
        });

        it('naming their company on my record: 422 unprocessable, no ids or names', async () => {
            const company = await as(theirs)
                .post(`/api/w/${otherWorkspace}/companies`)
                .send({ name: 'Secret Rivals Holdings' })
                .expect(201);
            const companyId = (company.body as { id: string }).id;
            const res = await as(mine).post(w('/people')).send({ nameFirst: 'Linked', companyId });
            const body = expectEnvelope(res, 422, 'unprocessable');
            leaks(body);
            expect(JSON.stringify(body)).not.toContain(companyId);
        });
    });
});
