import { CONTACT_STATUSES, CONTACT_STATUS_LABELS, type ContactStatus } from '@bylinecrm/shared';
import {
    Avatar,
    Button,
    KanbanBoard,
    KanbanLane,
    LoadingRegion,
    PageHeader,
    Skeleton,
    cn,
    focusRing,
    toast,
} from '@bylinecrm/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Building2, Mail } from 'lucide-react';
import { Link } from 'react-router';
import { customers } from '../../../api/customers';
import { useRecordPages } from '../../../api/lists';
import { keys } from '../../../api/queries';
import type { PersonView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths, withCreate } from '../../paths';
import { CONTACT_STATUS_TONE, LEADS_FILTER } from './leadsFilter';

/** The statuses a lead moves through before it is a customer or out; `do_not_contact` is set by suppression, not here. */
const LANES: readonly ContactStatus[] = CONTACT_STATUSES.filter((s) => s !== 'do_not_contact');

/**
 * Leads as a pipeline: every person, in a lane per contact status. A card's "Move to" sets the
 * status by hand (the same override the person page offers); the derived status returns when the
 * override is cleared there.
 */
export function LeadsPipeline() {
    const workspaceId = useWorkspaceId();
    const pages = useRecordPages(workspaceId, 'person', { limit: 200, sort: 'updatedAt:desc' });
    const canWrite = useCan('record:write');
    const client = useQueryClient();
    const move = useMutation({
        mutationFn: ({ id, status }: { id: string; status: ContactStatus }) =>
            customers.setContactStatus(workspaceId, id, status),
        onSuccess: (person) => {
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, 'person') });
            toast({ title: `${name(person)} is now ${CONTACT_STATUS_LABELS[person.contactStatus]}`, tone: 'success' });
        },
        onError: (error) =>
            toast({ title: 'Could not move the lead', description: failureText(error), tone: 'danger' }),
    });
    if (pages.isError) throw pages.error;
    const people = pages.data?.pages.flatMap((p) => p.items) ?? [];
    const byStatus = new Map<ContactStatus, PersonView[]>(LANES.map((s) => [s, []]));
    for (const p of people) byStatus.get(p.contactStatus)?.push(p);

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6">
            <PageHeader
                className="mb-0"
                title="Lead pipeline"
                subtitle="Everyone by where they are with you, from first touch to customer."
                actions={
                    <>
                        <Button asChild variant="secondary">
                            <Link to={`${paths.people(workspaceId)}?filter=${LEADS_FILTER}`}>All leads</Link>
                        </Button>
                        {canWrite && (
                            <Button asChild variant="primary" data-primary-action>
                                <Link to={withCreate(paths.people(workspaceId))}>Add lead</Link>
                            </Button>
                        )}
                    </>
                }
            />
            {!pages.data ? (
                <LoadingRegion label="Loading leads" className="grid grid-cols-6 gap-4">
                    {LANES.map((s) => (
                        <Skeleton key={s} className="h-64" />
                    ))}
                </LoadingRegion>
            ) : (
                <KanbanBoard>
                    {LANES.map((status) => {
                        const list = byStatus.get(status) ?? [];
                        return (
                            <KanbanLane
                                key={status}
                                name={CONTACT_STATUS_LABELS[status]}
                                tone={CONTACT_STATUS_TONE[status]}
                                count={list.length}
                            >
                                {list.length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-text-faint">
                                        No one here
                                    </div>
                                ) : (
                                    list.map((p) => (
                                        <LeadCard
                                            key={p.id}
                                            person={p}
                                            workspaceId={workspaceId}
                                            canMove={canWrite}
                                            moving={move.isPending && move.variables?.id === p.id}
                                            onMove={(s) => move.mutate({ id: p.id, status: s })}
                                        />
                                    ))
                                )}
                            </KanbanLane>
                        );
                    })}
                </KanbanBoard>
            )}
            {pages.hasNextPage && (
                <Button
                    variant="secondary"
                    className="self-center"
                    loading={pages.isFetchingNextPage}
                    onClick={() => void pages.fetchNextPage()}
                >
                    Load more people
                </Button>
            )}
        </div>
    );
}

function name(p: PersonView): string {
    return [p.nameFirst, p.nameLast].filter(Boolean).join(' ') || p.emails.primary || 'Unnamed';
}

function LeadCard({
    person,
    workspaceId,
    canMove,
    moving,
    onMove,
}: {
    person: PersonView;
    workspaceId: string;
    canMove: boolean;
    moving: boolean;
    onMove: (status: ContactStatus) => void;
}) {
    const next = LANES[LANES.indexOf(person.contactStatus) + 1];
    const label = name(person);
    return (
        <article
            aria-label={label}
            className="rounded-xl border border-border bg-surface p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
        >
            <div className="flex items-start gap-3">
                <Avatar name={label} src={person.avatarUrl ?? undefined} size="md" />
                <div className="min-w-0 flex-1">
                    <Link
                        to={paths.person(workspaceId, person.id)}
                        className="block truncate text-sm font-semibold hover:underline max-md:flex max-md:min-h-touch max-md:items-center"
                    >
                        {label}
                    </Link>
                    {person.jobTitle && (
                        <span className="block truncate text-xs text-text-muted">{person.jobTitle}</span>
                    )}
                </div>
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs text-text-muted">
                {person.company && (
                    <span className="flex items-center gap-1.5 truncate">
                        <Building2 aria-hidden className="size-3.5 shrink-0" />{' '}
                        <span className="truncate">{person.company.name}</span>
                    </span>
                )}
                {person.emails.primary && (
                    <span className="flex items-center gap-1.5 truncate">
                        <Mail aria-hidden className="size-3.5 shrink-0" />{' '}
                        <span className="truncate">{person.emails.primary}</span>
                    </span>
                )}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-[11px] text-text-muted">
                <span>Updated {formatRelative(person.updatedAt)}</span>
                {canMove && next && (
                    <button
                        type="button"
                        disabled={moving}
                        onClick={() => onMove(next)}
                        className={cn(
                            'flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-text hover:bg-surface-raised disabled:opacity-50 max-md:min-h-touch',
                            focusRing,
                        )}
                        title={`Move to ${CONTACT_STATUS_LABELS[next]}`}
                    >
                        {CONTACT_STATUS_LABELS[next]} <ArrowRight aria-hidden className="size-3" />
                    </button>
                )}
            </div>
        </article>
    );
}
