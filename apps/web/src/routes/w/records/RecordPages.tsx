import type { RecordObject } from '@bylinecrm/shared';
import { EmptyState, Skeleton } from '@bylinecrm/ui';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../../api/client';
import { useMembersSummary, useRecord } from '../../../api/queries';
import type { CompanyView, OpportunityView, PersonView } from '../../../api/types';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { CompanyRecord } from './CompanyRecord';
import { DealRecord } from './DealRecord';
import { PersonRecord } from './PersonRecord';
import { useSiblings } from './siblings';

/** The route segments, named once (an untyped `useParams` is a known trap). */
export const PERSON_PARAM = 'personId';
export const COMPANY_PARAM = 'companyId';
export const DEAL_PARAM = 'dealId';

function useRequiredParam(name: string): string {
    const value = useParams()[name];
    if (!value) throw new Error(`route has no :${name} segment`);
    return value;
}

/** Member id → name for owners and authors; one query the whole page shares. */
export function useMembersById(workspaceId: string): ReadonlyMap<string, string> {
    const members = useMembersSummary(workspaceId);
    return useMemo(
        () => new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Unnamed member'])),
        [members.data],
    );
}

/** The page's shape while the record loads: header, fact strip, three columns — no shift. */
export function RecordSkeleton({ layout }: { layout: 'page' | 'drawer' }) {
    return (
        <div
            className={layout === 'page' ? 'flex flex-col gap-5 p-7' : 'flex flex-col gap-4 px-5.5 py-5'}
            aria-busy="true"
            aria-label="Loading record"
        >
            <div className="flex items-center gap-3.5">
                <Skeleton className="size-14 rounded-full" />
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-4 w-72" />
                </div>
            </div>
            <Skeleton className="h-16" />
            {layout === 'page' ? (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)_280px]">
                    <Skeleton className="h-80" />
                    <Skeleton className="h-80" />
                    <Skeleton className="h-80" />
                </div>
            ) : (
                <Skeleton className="h-64" />
            )}
        </div>
    );
}

/**
 * Loads one record and renders its component, or the right state. A `404` from the API — the
 * record does not exist *for this caller*, which is also what a record outside their owner
 * scope answers — is "not found", never "forbidden" (no existence leak, FR-CRMS-UI-6/7). On a
 * full page the route boundary says so; in the drawer the panel does.
 */
export function RecordLoader<O extends RecordObject>({
    object,
    id,
    layout,
    render,
}: {
    object: O;
    id: string;
    layout: 'page' | 'drawer';
    render: (
        record: O extends 'person' ? PersonView : O extends 'company' ? CompanyView : OpportunityView,
    ) => React.ReactNode;
}) {
    const workspaceId = useWorkspaceId();
    const query = useRecord(workspaceId, object, id);
    if (query.isPending) return <RecordSkeleton layout={layout} />;
    if (query.isError) {
        if (layout === 'page') throw query.error;
        const notFound = query.error instanceof ApiError && query.error.status === 404;
        return (
            <div className="p-5.5">
                <EmptyState
                    tone="error"
                    title={notFound ? 'Not found' : 'Could not load this record'}
                    body={notFound ? 'There is no such record, or it was removed.' : query.error.message}
                />
            </div>
        );
    }
    return <>{render(query.data as never)}</>;
}

export function PersonPage() {
    const workspaceId = useWorkspaceId();
    const id = useRequiredParam(PERSON_PARAM);
    const siblings = useSiblings(id, (x) => paths.person(workspaceId, x));
    const members = useMembersById(workspaceId);
    return (
        <RecordLoader
            object="person"
            id={id}
            layout="page"
            render={(person) => (
                <PersonRecord
                    workspaceId={workspaceId}
                    person={person}
                    layout="page"
                    siblings={siblings}
                    membersById={members}
                />
            )}
        />
    );
}

export function CompanyPage() {
    const workspaceId = useWorkspaceId();
    const id = useRequiredParam(COMPANY_PARAM);
    const siblings = useSiblings(id, (x) => paths.company(workspaceId, x));
    const members = useMembersById(workspaceId);
    return (
        <RecordLoader
            object="company"
            id={id}
            layout="page"
            render={(company) => (
                <CompanyRecord
                    workspaceId={workspaceId}
                    company={company}
                    layout="page"
                    siblings={siblings}
                    membersById={members}
                />
            )}
        />
    );
}

export function DealPage() {
    const workspaceId = useWorkspaceId();
    const id = useRequiredParam(DEAL_PARAM);
    const siblings = useSiblings(id, (x) => paths.deal(workspaceId, x));
    const members = useMembersById(workspaceId);
    return (
        <RecordLoader
            object="opportunity"
            id={id}
            layout="page"
            render={(deal) => (
                <DealRecord
                    workspaceId={workspaceId}
                    deal={deal}
                    layout="page"
                    siblings={siblings}
                    membersById={members}
                />
            )}
        />
    );
}
