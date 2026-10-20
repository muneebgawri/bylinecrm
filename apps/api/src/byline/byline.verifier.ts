import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BylineVerification } from '@byline/contract';
import { FALLBACK_VERIFIER_SOURCE, type EmailVerification, type EmailVerificationReason } from '@bylinecrm/shared';
import { FreeVerifier } from '../verification/free-verifier';
import type { Verifier } from '../verification/verifier.port';
import { BYLINE_API, BylineApiError, type BylineApi } from './byline-api.port';
import { BylineLinks } from './byline-links.service';

/** Names BylineAI's answers in `source`. */
export const BYLINE_VERIFIER_SOURCE = 'byline';

/**
 * The verifier in use (FR-CRMS-16, "a vendor behind an interface"; BYL-2): BylineAI — its Reacher pool, on its own
 * box — for a workspace that linked BylineAI's API and turned verification on; the free layer for everyone else.
 * When BylineAI will not answer (budget spent, rate limit, key refused, down), the free layer answers instead and its
 * message says why BylineAI did not, so a spent budget never stops a workspace's sends.
 */
@Injectable()
export class BylineVerifier implements Verifier {
    readonly source = BYLINE_VERIFIER_SOURCE;
    private readonly logger = new Logger(BylineVerifier.name);

    constructor(
        private readonly free: FreeVerifier,
        @Inject(BYLINE_API) private readonly api: BylineApi,
        private readonly links: BylineLinks,
    ) {}

    async verify(address: string, context?: { workspaceId: string }): Promise<EmailVerification> {
        const link = context ? await this.links.linkFor(context.workspaceId) : null;
        if (!link?.verify) return this.free.verify(address);
        try {
            return fromByline(address, await this.api.verify(link, address));
        } catch (error) {
            if (!(error instanceof BylineApiError)) throw error;
            this.logger.warn(
                `workspace ${context!.workspaceId}: BylineAI did not verify (${error.kind}): ${error.message}`,
            );
            const free = await this.free.verify(address);
            // A rate limit or an outage passes: the free answer stands an hour (FALLBACK_VERIFIER_SOURCE), then BylineAI
            // is asked again. A spent budget or a refused key does not pass by itself: the free answer stands as usual.
            return {
                ...free,
                message: `${free.message} (${error.message}; free checks only.)`,
                ...(error.retryable ? { source: FALLBACK_VERIFIER_SOURCE } : {}),
            };
        }
    }
}

/** BylineAI's reasons (`BYLINE_VERIFICATION_REASONS`) in the CRM's words. */
const REASONS: Readonly<Record<string, EmailVerificationReason>> = {
    invalid_format: 'syntax',
    no_mx: 'no_mail_server',
    mailbox_not_found: 'mailbox_not_found',
    catch_all: 'catch_all',
    disposable: 'disposable',
    role: 'role',
    mailbox_exists: 'deliverable',
};

/** BylineAI's verdict as the CRM's answer. Exported for the suite. */
export function fromByline(address: string, answer: BylineVerification): EmailVerification {
    const domain = address.slice(address.lastIndexOf('@') + 1);
    const by = answer.provider ? ` (BylineAI, ${answer.provider})` : ' (BylineAI)';
    const known = answer.reason ? REASONS[answer.reason.toLowerCase()] : undefined;
    switch (answer.verdict) {
        case 'valid':
            return {
                result: 'valid',
                reason: 'deliverable',
                message: `The mailbox at ${domain} accepts mail${by}.`,
                source: BYLINE_VERIFIER_SOURCE,
            };
        case 'invalid':
            return {
                result: 'invalid',
                reason: known ?? 'mailbox_not_found',
                message: `${domain} does not take mail for this address${answer.reason ? `: ${answer.reason}` : ''}${by}.`,
                source: BYLINE_VERIFIER_SOURCE,
            };
        case 'risky':
            return {
                result: 'risky',
                reason: known ?? 'catch_all',
                message: `Mail to ${domain} may not reach a person${answer.reason ? `: ${answer.reason}` : ''}${by}.`,
                source: BYLINE_VERIFIER_SOURCE,
            };
        default:
            return {
                result: 'unknown',
                reason: 'lookup_failed',
                message: `Whether ${domain} takes this address could not be decided${by}.`,
                source: BYLINE_VERIFIER_SOURCE,
            };
    }
}
