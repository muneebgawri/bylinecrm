import {
    ENRICHMENT_FACTS,
    ENRICHMENT_SOURCE_LABELS,
    MAIL_PROVIDER_LABELS,
    type EnrichmentFactKey,
    type EnrichmentObject,
    type MailProvider,
} from '@bylinecrm/shared';
import { Badge, Button, LoadingRegion, Skeleton } from '@bylinecrm/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useEnrichNow, useEnrichment } from '../../../api/enrichment';
import { keys } from '../../../api/queries';
import type { EnrichmentAnswerView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { RailCard, RailEmpty } from './RailCard';

/**
 * What enrichment found about the record (P4-2, FR-CRMS-15): the newest answer per fact and source
 * — the value, where it came from, when it was asked, whether it was written to the record — with
 * no answer and a failed source said plainly. _Enrich now_ asks every source again; while the run is
 * queued the panel says so and asks again until it has settled, then the record is read again.
 */
export function EnrichmentPanel({
    workspaceId,
    object,
    recordId,
}: {
    workspaceId: string;
    object: EnrichmentObject;
    recordId: string;
}) {
    const write = usePermission('record:write');
    const history = useEnrichment(workspaceId, object, recordId);
    const enrichNow = useEnrichNow(workspaceId, object, recordId);
    const client = useQueryClient();
    const pending = history.data?.pending ?? false;
    // A run that just finished may have written fields: the record is read again, once.
    const wasPending = useRef(false);
    useEffect(() => {
        if (wasPending.current && !pending)
            void client.invalidateQueries({ queryKey: keys.record(workspaceId, object, recordId) });
        wasPending.current = pending;
    }, [pending, client, workspaceId, object, recordId]);

    const latest = newestPerFact(history.data?.answers ?? []);
    return (
        <RailCard
            title="Enrichment"
            count={history.data ? latest.length : undefined}
            action={
                write.allowed && history.data ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        loading={enrichNow.isPending}
                        disabled={pending}
                        onClick={() => enrichNow.mutate()}
                    >
                        Enrich now
                    </Button>
                ) : undefined
            }
        >
            {history.isPending && (
                <LoadingRegion label="Loading enrichment" className="px-4 py-3">
                    <Skeleton className="h-8" />
                </LoadingRegion>
            )}
            {history.isError && (
                <p role="alert" className="m-0 px-4 py-3 text-[13px] text-danger">
                    {failureText(history.error)}
                </p>
            )}
            {enrichNow.isError && (
                <p role="alert" className="m-0 px-4 py-2 text-[13px] text-danger">
                    {failureText(enrichNow.error)}
                </p>
            )}
            {pending && (
                <p className="m-0 border-b border-border px-4 py-2 text-[13px] text-text-muted" aria-live="polite">
                    Asking the sources…
                </p>
            )}
            {history.data && latest.length === 0 && !pending && <RailEmpty>Not enriched yet.</RailEmpty>}
            {latest.length > 0 && (
                <ul className="m-0 list-none p-0">
                    {latest.map((answer) => (
                        <li
                            key={answer.id}
                            className="flex flex-col gap-0.5 border-b border-border px-4 py-2.5 last:border-b-0"
                        >
                            <span className="flex items-baseline gap-2 text-[13px]">
                                <span className="font-medium text-text">
                                    {ENRICHMENT_FACTS[answer.field]?.label ?? answer.field}
                                </span>
                                {answer.applied && (
                                    <Badge status="success" className="ml-auto">
                                        Applied
                                    </Badge>
                                )}
                            </span>
                            <span className="text-[13px] text-text">{valueOf(answer)}</span>
                            <span className="text-xs text-text-muted">
                                {ENRICHMENT_SOURCE_LABELS[answer.source] ?? answer.source} ·{' '}
                                {formatDate(answer.askedAt)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </RailCard>
    );
}

/** The newest answer for each (fact, source), in the order the facts are declared. */
function newestPerFact(answers: readonly EnrichmentAnswerView[]): EnrichmentAnswerView[] {
    const seen = new Map<string, EnrichmentAnswerView>();
    for (const answer of answers) {
        const key = `${answer.field}:${answer.source}`;
        if (!seen.has(key)) seen.set(key, answer);
    }
    const order = Object.keys(ENRICHMENT_FACTS);
    return [...seen.values()].sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
}

function valueOf(answer: EnrichmentAnswerView): React.ReactNode {
    if (answer.status === 'no_answer') return <span className="text-text-muted">No answer</span>;
    if (answer.status === 'failed') {
        return <span className="text-danger">Failed{answer.note ? `: ${answer.note}` : ''}</span>;
    }
    const value = answer.value ?? '';
    const type = ENRICHMENT_FACTS[answer.field as EnrichmentFactKey]?.type;
    if (type === 'url') {
        return (
            <a
                href={value}
                target="_blank"
                rel="noreferrer noopener"
                className="break-all text-accent underline-offset-2 hover:underline"
            >
                {value.replace(/^https?:\/\//, '')}
            </a>
        );
    }
    if (type === 'enum' && answer.field === 'mail_provider')
        return MAIL_PROVIDER_LABELS[value as MailProvider] ?? value;
    return value;
}
