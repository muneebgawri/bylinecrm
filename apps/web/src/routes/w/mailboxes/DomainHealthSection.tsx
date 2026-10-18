import { POSTMASTER_QUOTA_URL } from '@bylinecrm/shared';
import { Badge, DataTableChrome, EmptyState } from '@bylinecrm/ui';
import { Link } from 'react-router';
import { useSendingDomains } from '../../../api/sendingPool';
import type { SendingDomainView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { paths } from '../../paths';
import {
    DOMAIN_STATUS,
    percentText,
    postmasterLine,
    readsText,
    SpamRateSparkline,
    STEP_LABEL,
    usageLabel,
} from './domainHealth';

/**
 * Domain health (#190, FR-CRMS-13): every domain the workspace sends from — each connected mailbox's,
 * pool or personal — and every domain the connected Postmaster Tools account lists, with its SPF,
 * DKIM and DMARC check, its user-reported spam rate (latest, and the last 30 days as a sparkline)
 * and when Postmaster Tools was read. Only a pool domain is gated; a personal one is watched. A spent
 * Postmaster Tools API quota is said once, at the top, as an admin's to raise. Shown to people who
 * run outreach; each domain opens its own page for an admin.
 */
export function DomainHealthSection({ workspaceId }: { workspaceId: string }) {
    const mayRead = useCan('outreach:write');
    const admin = useCan('workspace:admin');
    const domains = useSendingDomains(workspaceId, mayRead);
    if (!mayRead) return null;
    if (domains.isError) throw domains.error;
    const spent = domains.data?.find((d) => d.postmaster.status === 'quota_exhausted');

    return (
        <section aria-labelledby="domain-health-title" className="mt-8">
            <h2 id="domain-health-title" className="m-0 mb-1 text-base font-semibold">
                Domain health
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Every domain your mailboxes send from, and every domain in the connected Postmaster Tools account. Pool
                domains must pass SPF, DKIM and DMARC to send; personal domains are monitored, never blocked. Google
                reports spam rates only for domains with substantial Gmail-bound traffic, so a quiet domain shows no
                rate rather than a zero. Postmaster Tools no longer reports domain reputation.
            </p>
            {spent && <QuotaAlert domain={spent} admin={admin} />}
            <DataTableChrome
                data={{
                    label: 'Domain health',
                    loading: domains.isPending,
                    rows: domains.data ?? [],
                    getRowId: (d) => d.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No sending domain yet"
                            body="Connect a mailbox, or Postmaster Tools, and its domains are checked here."
                        />
                    ),
                    columns: [
                        {
                            id: 'domain',
                            header: 'Domain',
                            cell: (d) => (
                                <div className="min-w-0">
                                    {admin ? (
                                        <Link
                                            to={paths.sendingDomain(workspaceId, d.id)}
                                            className="font-medium break-all text-accent underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center"
                                        >
                                            {d.domain}
                                        </Link>
                                    ) : (
                                        <span className="font-medium break-all">{d.domain}</span>
                                    )}
                                    <span className="block text-xs text-text-muted">{usageLabel(d)}</span>
                                </div>
                            ),
                        },
                        {
                            id: 'checks',
                            header: 'SPF, DKIM, DMARC',
                            phone: 'secondary',
                            cell: (d) => <ChecksCell domain={d} />,
                        },
                        {
                            id: 'spam',
                            header: 'Spam rate',
                            phone: 'meta',
                            cell: (d) => (
                                <div>
                                    {d.spamRate ? (
                                        <>
                                            <span className="tabular-nums">
                                                {percentText(d.spamRate.rateBps)} on {d.spamRate.day}
                                            </span>
                                            <SpamRateSparkline rates={d.spamRates} />
                                        </>
                                    ) : (
                                        <span className="text-text-muted">No rate reported</span>
                                    )}
                                    {d.deliveryErrorRate && (
                                        <span className="block text-xs text-text-muted tabular-nums">
                                            Delivery errors {percentText(d.deliveryErrorRate.rateBps)} on{' '}
                                            {d.deliveryErrorRate.day}
                                        </span>
                                    )}
                                </div>
                            ),
                        },
                        {
                            id: 'postmaster',
                            header: 'Postmaster Tools',
                            phone: 'meta',
                            cell: (d) => {
                                const reads = readsText(d.postmaster);
                                const line = postmasterLine(d.postmaster);
                                if (!reads && !line) return <span className="text-text-muted">Not read</span>;
                                return (
                                    <div className="min-w-0 max-w-[40ch]">
                                        {reads && <span className="block text-xs text-text-muted">{reads}</span>}
                                        {line}
                                    </div>
                                );
                            },
                        },
                    ],
                }}
            />
        </section>
    );
}

function ChecksCell({ domain }: { domain: SendingDomainView }) {
    const status = DOMAIN_STATUS[domain.status];
    const failing = domain.lastCheck
        ? (Object.keys(STEP_LABEL) as (keyof typeof STEP_LABEL)[]).filter(
              (k) => domain.lastCheck![k].outcome === 'fail',
          )
        : [];
    return (
        <div className="min-w-0">
            <Badge status={status.tone}>{status.label}</Badge>
            {failing.length > 0 && (
                <ul
                    className="m-0 mt-1 list-none p-0 text-xs text-text-muted"
                    aria-label={`${domain.domain} failing checks`}
                >
                    {failing.map((k) => (
                        <li key={k}>
                            {STEP_LABEL[k]}: {domain.lastCheck![k].message}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Google said the project's Postmaster Tools API quota is spent (#190): no domain is read until it
 * is raised or resets. An admin is told where to raise it, with Google's own words; anyone else that
 * an admin needs to.
 */
function QuotaAlert({ domain, admin }: { domain: SendingDomainView; admin: boolean }) {
    return (
        <div role="alert" className="mb-3 max-w-[75ch] rounded-md bg-warning-soft px-3 py-2 text-[13px] text-text">
            {admin ? (
                <>
                    <p className="m-0 font-semibold">Raise the Postmaster Tools API quota in Google Cloud.</p>
                    <p className="m-0 mt-0.5 text-text-muted">{domain.postmaster.message}</p>
                    <a
                        href={POSTMASTER_QUOTA_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex text-accent underline-offset-2 hover:underline max-md:min-h-touch max-md:items-center"
                    >
                        Open the Google Cloud quotas page
                    </a>
                </>
            ) : (
                <p className="m-0">
                    Google’s Postmaster Tools API quota is used up, so spam rates are not being read; an admin needs to
                    raise it in Google Cloud.
                </p>
            )}
        </div>
    );
}
