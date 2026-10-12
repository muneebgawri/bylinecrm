import { Injectable } from '@nestjs/common';
import {
    REGION_LABELS,
    regionOfCountry,
    type EnrolmentRefusal,
    type EnrolmentWarning,
    type Emails,
    type RegionCode,
} from '@bylinecrm/shared';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SuppressionService } from '../suppression/suppression.service';
import { EmailVerificationService } from '../verification/email-verification.service';
import { inferCountry } from './country';
import { ExclusionsService, exclusionMessage } from './exclusions.service';
import { RegionPolicyService } from './region-policy.service';

/** A person who passed every gate, with what the runner needs about them. */
export interface EligiblePerson {
    personId: string;
    address: string;
    country: string | null;
    region: RegionCode;
}

export interface ScreenResult {
    eligible: EligiblePerson[];
    refused: EnrolmentRefusal[];
    /** Eligible people flagged for review (D-251, FR-CRMS-14). */
    warnings: EnrolmentWarning[];
}

const SUPPRESSION_WORDS: Readonly<Record<string, string>> = {
    unsubscribe: 'Unsubscribed',
    hard_bounce: 'Bounced',
    complaint: 'Marked our mail as spam',
    manual: 'On the suppression list',
};

/**
 * The enrolment gates (P3-3) — one function, so the preview and the enrol make the same decision and
 * the dialog shows the server's reasons, never a guess (doc 50 §D). In order: the person exists and is
 * visible (`person.not_found`), has a primary address (`email.missing`), has a source (FR-CRMS-11,
 * `source.missing`), is not suppressed (FR-CRMS-7, P3-1's one query), not excluded (FR-CRMS-10), is
 * in a region the workspace's policy allows (FR-CRMS-12), and has an address verification finds
 * deliverable (FR-CRMS-14, P3-5's one check: `email.invalid`; `unknown` is not valid and does not
 * enrol — `email.unverified`; a risky address enrols with a warning). Reads in the caller's scope (a
 * person their role cannot see is `person.not_found`); each read is its own short transaction —
 * never one held open across another, and verification's lookups happen with none open — and the
 * step runner checks again before every step.
 */
@Injectable()
export class EnrolmentScreen {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly suppressions: SuppressionService,
        private readonly exclusions: ExclusionsService,
        private readonly regions: RegionPolicyService,
        private readonly verification: EmailVerificationService,
    ) {}

    async screen(workspaceId: string, personIds: readonly string[]): Promise<ScreenResult> {
        const people = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.person.findMany({
                where: { id: { in: [...personIds] }, deletedAt: null },
                select: { id: true, emails: true, source: true, country: true, company: { select: { address: true } } },
            }),
        );
        const byId = new Map(people.map((p) => [p.id, p]));
        const refused: EnrolmentRefusal[] = [];
        const candidates: { personId: string; address: string; country: string | null }[] = [];
        for (const personId of personIds) {
            const p = byId.get(personId);
            if (!p) {
                refused.push({ personId, code: 'person.not_found', message: 'No such person' });
                continue;
            }
            const address = (p.emails as Emails | null)?.primary?.trim().toLowerCase();
            if (!address) {
                refused.push({ personId, code: 'email.missing', message: 'Has no email address' });
                continue;
            }
            if (!p.source) {
                refused.push({
                    personId,
                    code: 'source.missing',
                    message: 'Has no source (where this contact came from)',
                });
                continue;
            }
            const companyCountry = (p.company?.address as { country?: string | null } | null)?.country ?? null;
            const { country } = inferCountry({ personCountry: p.country, companyCountry, email: address });
            candidates.push({ personId, address, country });
        }

        const addresses = candidates.map((c) => c.address);
        // FR-CRMS-7: P3-1's one query.
        const suppressed = await this.suppressions.check(workspaceId, addresses);
        const { excluded, policy } = await this.rls.withWorkspace(workspaceId, async (tx) => ({
            excluded: await this.exclusions.check(tx, addresses),
            policy: await this.regions.allowedIn(tx),
        }));
        const passing: EligiblePerson[] = [];
        for (const c of candidates) {
            const s = suppressed.get(c.address);
            if (s) {
                refused.push({
                    personId: c.personId,
                    code: 'suppressed',
                    message: SUPPRESSION_WORDS[s.reason] ?? 'On the suppression list',
                });
                continue;
            }
            const x = excluded.get(c.address);
            if (x) {
                refused.push({ personId: c.personId, code: 'excluded', message: exclusionMessage(x) });
                continue;
            }
            const region = regionOfCountry(c.country);
            if (!policy[region]) {
                refused.push({
                    personId: c.personId,
                    code: 'region.blocked',
                    message: `Region blocked: ${REGION_LABELS[region]} (policy)`,
                });
                continue;
            }
            passing.push({ ...c, region });
        }

        // FR-CRMS-14: P3-5's one check, last — only for those every cheaper gate let through.
        const verified = await this.verification.check(
            workspaceId,
            passing.map((c) => c.address),
        );
        const eligible: EligiblePerson[] = [];
        const warnings: EnrolmentWarning[] = [];
        for (const c of passing) {
            const verdict = verified.get(c.address)!;
            if (verdict.result === 'invalid') {
                refused.push({ personId: c.personId, code: 'email.invalid', message: verdict.message });
                continue;
            }
            if (verdict.result === 'unknown') {
                refused.push({ personId: c.personId, code: 'email.unverified', message: verdict.message });
                continue;
            }
            eligible.push(c);
            if (verdict.result === 'risky') {
                warnings.push({ personId: c.personId, code: 'email.risky', message: verdict.message });
            }
            if (c.region === 'unknown') {
                warnings.push({
                    personId: c.personId,
                    code: 'region.unknown',
                    message: 'Country unknown — check it is not in a blocked region',
                });
            }
        }
        // Refusals in the order the people were asked for.
        const order = new Map(personIds.map((id, i) => [id, i]));
        refused.sort((a, b) => order.get(a.personId)! - order.get(b.personId)!);
        return { eligible, refused, warnings };
    }
}
