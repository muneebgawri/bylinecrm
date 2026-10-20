import { Injectable } from '@nestjs/common';
import {
    BYLINE_ENRICHMENT_PATH,
    BYLINE_VERDICTS,
    BYLINE_VERIFICATION_PATH,
    type BylineApiErrorBody,
    type BylineEnrichment,
    type BylineVerification,
} from '@byline/contract';
import { BylineApiError, type BylineApi, type BylineLink } from './byline-api.port';

/** How long one ask may take. */
export const BYLINE_API_TIMEOUT_MS = 10_000;

/** BylineAI over HTTP (BYL-2): `x-api-key`, JSON, errors turned into `BylineApiError`. */
@Injectable()
export class BylineApiHttp implements BylineApi {
    async enrich(link: BylineLink, email: string): Promise<BylineEnrichment | null> {
        const res = await call(link, `${BYLINE_ENRICHMENT_PATH}/${encodeURIComponent(email)}`);
        if (res.status === 404) return null;
        const body = await ok(res);
        return body as BylineEnrichment;
    }

    async verify(link: BylineLink, email: string): Promise<BylineVerification> {
        const body = (await ok(
            await call(link, `${BYLINE_VERIFICATION_PATH}/${encodeURIComponent(email)}`),
        )) as Partial<BylineVerification> | null;
        if (!body || !BYLINE_VERDICTS.includes(body.verdict as never)) {
            throw new BylineApiError('unavailable', 'BylineAI answered with no verdict');
        }
        return {
            email,
            verdict: body.verdict!,
            reason: typeof body.reason === 'string' ? body.reason : null,
            provider: typeof body.provider === 'string' ? body.provider : null,
        };
    }
}

async function call(link: BylineLink, path: string): Promise<Response> {
    try {
        return await fetch(new URL(path, link.baseUrl), {
            headers: { 'x-api-key': link.apiKey, accept: 'application/json' },
            signal: AbortSignal.timeout(BYLINE_API_TIMEOUT_MS),
        });
    } catch (error) {
        throw new BylineApiError(
            'unavailable',
            `BylineAI could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/** The body of a 2xx answer, or the error BylineAI's status and body say. Exported for the suite. */
export async function ok(res: Response): Promise<unknown> {
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return body;
    throw errorFrom(res.status, body as BylineApiErrorBody | null);
}

/** BylineAI's refusal, as a member would read it. Exported for the suite. */
export function errorFrom(status: number, body: BylineApiErrorBody | null): BylineApiError {
    const detail =
        typeof body?.message === 'string' && body.message.trim() ? `: ${body.message.trim().slice(0, 200)}` : '';
    if (status === 402 || body?.error === 'budget_exhausted') {
        return new BylineApiError('budget', `BylineAI’s budget for this is spent${detail}`);
    }
    if (status === 429 || body?.error === 'rate_limited') {
        return new BylineApiError('rate_limited', `BylineAI is rate-limiting these asks${detail}`);
    }
    if (status === 401 || status === 403) {
        return new BylineApiError('unauthorized', 'BylineAI refused the API key');
    }
    return new BylineApiError('unavailable', `BylineAI answered ${status}${detail}`);
}
