import { CSRF_COOKIE, SESSION_COOKIE } from '@bylinecrm/shared';
import type { CookieOptions, Response } from 'express';
import { SESSION_TTL_S } from './auth.constants';

/**
 * How the two auth cookies are written. `secure` follows the API's public URL: an `https:`
 * APP_URL is the one definition of "we are on TLS", so a production deploy behind TLS gets a
 * Secure cookie and a local `http://` one still works.
 */
export class AuthCookies {
    constructor(private readonly secure: boolean) {}

    static fromAppUrl(appUrl: string): AuthCookies {
        return new AuthCookies(new URL(appUrl).protocol === 'https:');
    }

    private base(): CookieOptions {
        return { secure: this.secure, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_S * 1000 };
    }

    /** The session (httpOnly) and its CSRF twin (readable, so the web app can echo it). */
    set(res: Response, sessionToken: string, csrfToken: string): void {
        res.cookie(SESSION_COOKIE, sessionToken, { ...this.base(), httpOnly: true });
        res.cookie(CSRF_COOKIE, csrfToken, { ...this.base(), httpOnly: false });
    }

    clear(res: Response): void {
        res.clearCookie(SESSION_COOKIE, { ...this.base(), httpOnly: true });
        res.clearCookie(CSRF_COOKIE, { ...this.base(), httpOnly: false });
    }
}
