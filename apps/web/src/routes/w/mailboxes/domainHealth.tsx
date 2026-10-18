import type { DomainCheck } from '@bylinecrm/shared';
import type { SendingDomainView } from '../../../api/types';
import { formatRelative, formatWhen } from '../../../lib/format';

/**
 * What the pool, the Domain health panel and a domain's page say about a sending domain (P3-2,
 * #129, #183, #190), written once.
 */

export const DOMAIN_STATUS: Record<
    SendingDomainView['status'],
    { label: string; tone: 'success' | 'danger' | 'neutral' }
> = {
    pass: { label: 'Verified', tone: 'success' },
    fail: { label: 'Failing', tone: 'danger' },
    unchecked: { label: 'Not checked yet', tone: 'neutral' },
};

export const STEP_LABEL: Record<keyof DomainCheck, string> = { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' };

/** What uses the domain, and what the gate does with it (#190): the pool's are gated, personal mail is only watched. */
export function usageLabel(domain: SendingDomainView): string {
    if (domain.gated) return domain.usedBy.includes('personal') ? 'Pool and personal — gated' : 'Pool — gated';
    if (domain.usedBy.includes('personal')) return 'Personal — monitored';
    return domain.inPostmaster ? 'In Postmaster Tools only' : 'No mailbox uses it';
}

/** Basis points as the percent people read: 35 → 0.35%, 500 → 5%. */
export function percentText(bps: number): string {
    return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** When Postmaster Tools was last asked and when it is asked next, or null before it ever was. */
export function readsText(postmaster: SendingDomainView['postmaster']): string | null {
    if (!postmaster.readAt) return null;
    const next = postmaster.nextReadAt ? `; next read ${formatWhen(postmaster.nextReadAt)}` : '';
    return `Read ${formatRelative(postmaster.readAt)}${next}`;
}

/**
 * What the last ask of Postmaster Tools came to (#129, #183, #190), under the domain: a refusal or
 * a spent quota is a warning; a rate limit or no answer is said calmly, with the next try, because
 * the last reading stands and the check tries again on its own.
 */
export function postmasterLine(postmaster: SendingDomainView['postmaster']) {
    const next = postmaster.nextReadAt ? `next try ${formatWhen(postmaster.nextReadAt)}` : null;
    switch (postmaster.status) {
        case 'not_connected':
            return null;
        case 'rate_limited':
            return (
                <span className="block text-xs text-text-muted">
                    {postmaster.message ?? 'Postmaster Tools is rate-limiting reads'}
                    {next ? `; ${next}` : ''}
                </span>
            );
        case 'unreachable':
            return (
                <span className="block text-xs text-text-muted">
                    Postmaster Tools did not answer{next ? `; ${next}` : ''}
                </span>
            );
        case 'ok':
            return postmaster.message ? (
                <span className="block text-xs text-text-muted">Postmaster Tools: {postmaster.message}</span>
            ) : null;
        default:
            return postmaster.message ? (
                <span className="block text-xs text-warning">Postmaster Tools: {postmaster.message}</span>
            ) : null;
    }
}

const SPARK = { width: 84, height: 26, pad: 3 };

/**
 * A domain's user-reported spam rate over the last 30 days (#190), as a sparkline: one series, so
 * one hue and no legend; a 2px line, the latest day marked. Its label says the range in words, and
 * the domain's page has the same days as a table. Days Postmaster Tools kept back are gaps in time,
 * never zeros.
 */
export function SpamRateSparkline({ rates }: { rates: SendingDomainView['spamRates'] }) {
    if (rates.length === 0) return null;
    const from = rates[0]!.day;
    const to = rates.at(-1)!.day;
    const values = rates.map((r) => r.rateBps);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const start = Date.parse(from);
    const span = Math.max(1, Date.parse(to) - start);
    const x = (day: string) => SPARK.pad + ((Date.parse(day) - start) / span) * (SPARK.width - 2 * SPARK.pad);
    const y = (bps: number) =>
        SPARK.height - SPARK.pad - (high === low ? 0.5 : (bps - low) / (high - low)) * (SPARK.height - 2 * SPARK.pad);
    const points = rates.map((r) => `${x(r.day).toFixed(1)},${y(r.rateBps).toFixed(1)}`).join(' ');
    const last = rates.at(-1)!;
    const label =
        low === high
            ? `Spam rate, last 30 days: ${percentText(low)} on each of ${rates.length} days reported`
            : `Spam rate, last 30 days: ${percentText(low)} to ${percentText(high)} over ${rates.length} days reported`;
    return (
        <svg
            role="img"
            aria-label={label}
            viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
            className="mt-1 block h-6.5 w-21 text-accent"
        >
            <title>{label}</title>
            {rates.length > 1 && (
                <polyline
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            )}
            <circle cx={x(last.day)} cy={y(last.rateBps)} r={2.5} fill="currentColor" />
        </svg>
    );
}
