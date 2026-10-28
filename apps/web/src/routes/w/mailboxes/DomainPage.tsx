import { Badge, Button, DataTableChrome, EmptyState, LoadingRegion, PageHeader, Skeleton, toast } from '@bylinecrm/ui';
import { Link } from 'react-router';
import { useCheckSendingDomain, useSendingDomain } from '../../../api/sendingPool';
import type { SendingDomainView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { useDomainId, useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { DOMAIN_STATUS, percentText, postmasterLine, readsText, STEP_LABEL, usageLabel } from './domainHealth';

/**
 * One sending domain, for an admin (#190, FR-CRMS-13): what uses it and what the gate does with it,
 * each of its SPF, DKIM and DMARC checks with what the lookup found, what Postmaster Tools last said
 * and every day's user-reported spam rate it reported over the last 30 days — the table the panel's
 * sparkline draws. An admin checks it again from here.
 */
export function DomainPage() {
    const workspaceId = useWorkspaceId();
    const domainId = useDomainId();
    const admin = useCan('workspace:admin');
    const domain = useSendingDomain(workspaceId, domainId, admin);
    const check = useCheckSendingDomain(workspaceId);
    const back = (
        <Link
            to={paths.mailboxes(workspaceId)}
            className="text-accent underline-offset-2 hover:underline max-md:inline-flex max-md:min-h-touch max-md:items-center"
        >
            Back to Mailboxes
        </Link>
    );
    if (!admin) {
        return (
            <div className="p-7 max-md:p-4">
                <EmptyState
                    title="Only an admin can open a sending domain"
                    body="Its health is on the Mailboxes page for everyone who runs outreach."
                />
                <p className="mt-3 text-[13px]">{back}</p>
            </div>
        );
    }
    if (domain.isError) throw domain.error;
    if (!domain.data) {
        return (
            <div className="p-7 max-md:p-4">
                <LoadingRegion label="Loading the sending domain">
                    <Skeleton className="h-9 w-64" />
                    <Skeleton className="mt-4 h-40" />
                </LoadingRegion>
            </div>
        );
    }
    const d = domain.data;
    const checkAgain = () =>
        check.mutate(d.id, {
            onSuccess: (result) =>
                toast({
                    title: result.status === 'pass' ? `${result.domain} is verified` : `${result.domain} still fails`,
                    tone: result.status === 'pass' ? 'success' : 'danger',
                }),
            onError: (error) =>
                toast({ title: 'The check did not run', description: failureText(error), tone: 'danger' }),
        });
    const reads = readsText(d.postmaster);
    return (
        <div className="p-7 max-md:p-4">
            <p className="m-0 mb-2 text-[13px]">{back}</p>
            <PageHeader
                title={d.domain}
                subtitle={`${usageLabel(d)}. ${gateText(d)}`}
                actions={
                    <Button data-primary-action shape="square" onClick={checkAgain} disabled={check.isPending}>
                        Check again
                    </Button>
                }
            />
            <section aria-labelledby="checks-title" className="mt-6">
                <h2 id="checks-title" className="m-0 mb-2 text-base font-semibold">
                    SPF, DKIM and DMARC{' '}
                    <Badge status={DOMAIN_STATUS[d.status].tone}>{DOMAIN_STATUS[d.status].label}</Badge>
                </h2>
                {d.lastCheck ? (
                    <ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
                        {(Object.keys(STEP_LABEL) as (keyof typeof STEP_LABEL)[]).map((k) => (
                            <li key={k} className="flex flex-wrap items-baseline gap-2">
                                <span className="w-14 font-medium">{STEP_LABEL[k]}</span>
                                <Badge status={d.lastCheck![k].outcome === 'pass' ? 'success' : 'danger'}>
                                    {d.lastCheck![k].outcome === 'pass' ? 'Passes' : 'Fails'}
                                </Badge>
                                <span className="min-w-0 break-words text-text-muted">{d.lastCheck![k].message}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="m-0 text-[13px] text-text-muted">Not checked yet.</p>
                )}
                <p className="m-0 mt-2 text-xs text-text-muted">
                    {d.extraDkimSelectors.length > 0 ? 'DKIM selectors ' : 'DKIM selector '}
                    <span className="font-medium text-text">
                        {[d.dkimSelector, ...d.extraDkimSelectors.filter((s) => s !== d.dkimSelector)].join(', ')}
                    </span>
                    {d.checkedAt ? ` · checked ${formatRelative(d.checkedAt)}` : ''}
                </p>
            </section>
            <section aria-labelledby="postmaster-days-title" className="mt-8">
                <h2 id="postmaster-days-title" className="m-0 mb-1 text-base font-semibold">
                    Postmaster Tools, by day
                </h2>
                <div className="mb-3 max-w-[65ch] text-[13px] text-text-muted">
                    {reads && <span className="block">{reads}</span>}
                    {postmasterLine(d.postmaster)}
                    <span className="block">
                        Google reports a day only when the domain sent substantial Gmail-bound traffic; a missing day is
                        no data, not a zero.
                    </span>
                </div>
                <DataTableChrome
                    data={{
                        label: 'Spam and delivery-error rates by day',
                        loading: false,
                        rows: daysOf(d),
                        getRowId: (r) => r.day,
                        empty: (
                            <EmptyState
                                className="m-4"
                                title="No rates in the last 30 days"
                                body="Postmaster Tools reported nothing for this domain."
                            />
                        ),
                        columns: [
                            { id: 'day', header: 'Day', cell: (r) => r.day },
                            {
                                id: 'spam',
                                header: 'Spam rate',
                                phone: 'meta',
                                // On a phone the row is a card without column headers: each number says what it is.
                                cell: (r) => (
                                    <span className="tabular-nums">
                                        <span className="md:hidden">Spam </span>
                                        {rateText(r.spamBps)}
                                    </span>
                                ),
                            },
                            {
                                id: 'errors',
                                header: 'Delivery errors',
                                phone: 'meta',
                                cell: (r) => (
                                    <span className="tabular-nums">
                                        <span className="md:hidden">Delivery errors </span>
                                        {rateText(r.errorBps)}
                                    </span>
                                ),
                            },
                        ],
                    }}
                />
            </section>
        </div>
    );
}

/**
 * Each day Postmaster Tools reported either rate for, newest first (#190): a day with one rate and
 * not the other shows a dash for the missing one, never a zero.
 */
function daysOf(d: SendingDomainView): { day: string; spamBps: number | null; errorBps: number | null }[] {
    const days = new Map<string, { day: string; spamBps: number | null; errorBps: number | null }>();
    const at = (day: string) => days.get(day) ?? days.set(day, { day, spamBps: null, errorBps: null }).get(day)!;
    for (const r of d.spamRates) at(r.day).spamBps = r.rateBps;
    for (const r of d.deliveryErrorRates) at(r.day).errorBps = r.rateBps;
    return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

function rateText(bps: number | null): string {
    return bps === null ? '—' : percentText(bps);
}

/** What the pool's gate does with the domain (#190): the pool's are gated, personal mail is only watched. */
function gateText(d: SendingDomainView): string {
    if (d.gated)
        return 'Pool mailboxes send from it only while SPF, DKIM and DMARC pass, and pause at the spam-rate threshold.';
    return 'Monitored, never blocked: nothing is refused or paused for what its checks find.';
}
