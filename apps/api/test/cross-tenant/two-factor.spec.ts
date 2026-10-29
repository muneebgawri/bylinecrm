import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { TWO_FACTOR_MAX_ATTEMPTS } from '../../src/auth/auth.constants';
import { totp } from '../../src/auth/totp';
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
 * Two-factor sign-in (2FA-1) end to end: setup proves the app before anything changes, a password
 * login then answers a challenge and no session, the app's code or a recovery code finishes it,
 * wrong codes spend the challenge, and the password turns it off again.
 */
describe('two-factor sign-in', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `twofa-${stamp}@example.test`;
    const password = 'correct horse battery staple';
    let me: Browser;
    let secret: string;
    let codes: string[];

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        const signup = await http()
            .post('/api/auth/signup')
            .send({ email, password, workspaceName: 'Two Factor Co' })
            .expect(201);
        me = browserFrom(signup);
        await verifyAddress(app, http, email);
    });

    afterAll(async () => {
        await app.close();
    });

    const post = (path: string, b: Browser) => http().post(path).set('Cookie', b.cookie).set(CSRF_HEADER, b.csrf);

    it('starts off, and a password alone signs in', async () => {
        const status = await http().get('/api/me/two-factor').set('Cookie', me.cookie).expect(200);
        expect(status.body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        expect(login.body).toMatchObject({ user: { email, twoFactorEnabled: false }, twoFactor: null });
    });

    it('setup hands out a secret, but nothing changes until a code proves the app', async () => {
        const setup = await post('/api/me/two-factor/setup', me).expect(200);
        secret = (setup.body as { secret: string }).secret;
        expect((setup.body as { otpauthUrl: string }).otpauthUrl).toContain(`secret=${secret}`);
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        expect((login.body as { twoFactor: unknown }).twoFactor).toBeNull();
        await post('/api/me/two-factor/enable', me).send({ code: '000000' }).expect(400);
        const enabled = await post('/api/me/two-factor/enable', me).send({ code: totp(secret) }).expect(200);
        codes = (enabled.body as { codes: string[] }).codes;
        expect(codes).toHaveLength(8);
        const status = await http().get('/api/me/two-factor').set('Cookie', me.cookie).expect(200);
        expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
    });

    it('a password login answers a challenge and sets no cookie; the code signs in', async () => {
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        const challenge = (login.body as { twoFactor: { challenge: string } }).twoFactor.challenge;
        expect((login.body as { user: unknown }).user).toBeNull();
        expect(login.headers['set-cookie']).toBeUndefined();
        await http().post('/api/auth/login/two-factor').send({ challenge, code: '000000' }).expect(400);
        const done = await http().post('/api/auth/login/two-factor').send({ challenge, code: totp(secret) }).expect(200);
        expect(done.body).toMatchObject({ user: { email, twoFactorEnabled: true } });
        const b = browserFrom(done);
        await http().get('/api/me').set('Cookie', b.cookie).expect(200);
        // The challenge is spent: the same code again does not open a second session.
        await http().post('/api/auth/login/two-factor').send({ challenge, code: totp(secret) }).expect(400);
    });

    it('a recovery code works once, and the count goes down', async () => {
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        const challenge = (login.body as { twoFactor: { challenge: string } }).twoFactor.challenge;
        const code = codes[0]!;
        const done = await http()
            .post('/api/auth/login/two-factor')
            .send({ challenge, code: code.toUpperCase() })
            .expect(200);
        const b = browserFrom(done);
        const status = await http().get('/api/me/two-factor').set('Cookie', b.cookie).expect(200);
        expect(status.body).toMatchObject({ recoveryCodesLeft: 7 });
        const again = await http().post('/api/auth/login').send({ email, password }).expect(200);
        const second = (again.body as { twoFactor: { challenge: string } }).twoFactor.challenge;
        await http().post('/api/auth/login/two-factor').send({ challenge: second, code }).expect(400);
    });

    it('too many wrong codes spend the challenge', async () => {
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        const challenge = (login.body as { twoFactor: { challenge: string } }).twoFactor.challenge;
        for (let i = 0; i < TWO_FACTOR_MAX_ATTEMPTS; i++) {
            await http().post('/api/auth/login/two-factor').send({ challenge, code: '000000' }).expect(400);
        }
        const res = await http().post('/api/auth/login/two-factor').send({ challenge, code: totp(secret) }).expect(400);
        expect(res.body).toMatchObject({ code: 'token.invalid' });
    });

    it('new recovery codes replace the old; the password turns two-factor off', async () => {
        await post('/api/me/two-factor/recovery-codes', me).send({ password: 'wrong' }).expect(401);
        const fresh = await post('/api/me/two-factor/recovery-codes', me).send({ password }).expect(200);
        const next = (fresh.body as { codes: string[] }).codes;
        expect(next).toHaveLength(8);
        expect(next).not.toContain(codes[1]);
        await post('/api/me/two-factor/disable', me).send({ password: 'wrong' }).expect(401);
        await post('/api/me/two-factor/disable', me).send({ password }).expect(204);
        const login = await http().post('/api/auth/login').send({ email, password }).expect(200);
        expect(login.body).toMatchObject({ user: { email, twoFactorEnabled: false }, twoFactor: null });
    });
});
