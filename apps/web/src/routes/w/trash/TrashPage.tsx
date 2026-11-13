import { Button, EmptyState, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@bylinecrm/ui';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../../api/client';
import { useMembersById } from '../../../api/records';
import { useRestoreRecord, useTrash, type TrashedOf, type TrashObject } from '../../../api/trash';
import { usePermission } from '../../../auth/capabilities';
import { DELETE_REASON_LABEL } from '../../../lib/deleteReasons';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { useWorkspaceId } from '../../params';

const TABS: readonly { object: TrashObject; label: string; plural: string }[] = [
    { object: 'person', label: 'People', plural: 'people' },
    { object: 'company', label: 'Companies', plural: 'companies' },
];

/** A trashed record's name, and the line under it (an address, a domain). */
function naming(object: TrashObject, row: TrashedOf<TrashObject>): { name: string; detail: string | null } {
    if (object === 'person') {
        const p = row as TrashedOf<'person'>;
        const name = `${p.nameFirst} ${p.nameLast}`.trim();
        const email = p.emails.primary;
        return name ? { name, detail: email } : { name: email ?? 'Unnamed person', detail: null };
    }
    const c = row as TrashedOf<'company'>;
    return { name: c.name, detail: c.domain };
}

/**
 * The trash: the people and companies that were deleted, newest first, each with who deleted it, when and why,
 * and "Restore" to put it back as it was. A member sees what their role shows them live: their own records, or
 * everyone's. A deleted person keeps their email address, so nobody can add them again until they are restored.
 */
export function TrashPage() {
    const workspaceId = useWorkspaceId();
    const write = usePermission('record:write');
    const [object, setObject] = useState<TrashObject>('person');
    return (
        <div className="flex w-full flex-col gap-4 p-4 md:p-6">
            <PageHeader
                title="Trash"
                subtitle="Deleted people and companies stay here until someone restores them. A deleted person keeps their email address, so they cannot be added again while they are here."
            />
            {write.allowed ? (
                <>
                    <Tabs value={object} onValueChange={(v) => setObject(v as TrashObject)}>
                        <TabsList variant="pill" aria-label="Which records">
                            {TABS.map((t) => (
                                <TabsTrigger key={t.object} value={t.object}>
                                    {t.label}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                        {TABS.map((t) => (
                            <TabsContent key={t.object} value={t.object} className="mt-4">
                                <TrashList workspaceId={workspaceId} object={t.object} />
                            </TabsContent>
                        ))}
                    </Tabs>
                </>
            ) : (
                <EmptyState title="You cannot open the trash" body={write.reason} />
            )}
        </div>
    );
}

function TrashList({ workspaceId, object }: { workspaceId: string; object: TrashObject }) {
    const pages = useTrash(workspaceId, object);
    const restore = useRestoreRecord(workspaceId, object);
    const members = useMembersById(workspaceId);
    const plural = TABS.find((t) => t.object === object)!.plural;
    const rows = pages.data?.pages.flatMap((p) => p.items as TrashedOf<TrashObject>[]) ?? [];
    const first = pages.data?.pages[0];

    const putBack = async (id: string, name: string) => {
        try {
            await restore.mutateAsync(id);
            toast({ tone: 'success', title: `${name} restored.` });
        } catch (error) {
            toast({
                tone: 'danger',
                title: `${name} was not restored`,
                description: error instanceof ApiError ? error.message : failureText(error),
            });
        }
    };

    if (pages.isPending) return <p className="m-0 text-sm text-text-muted">Loading…</p>;
    if (pages.isError) {
        return (
            <EmptyState
                title="The trash did not load"
                body={failureText(pages.error)}
                action={<Button onClick={() => void pages.refetch()}>Retry</Button>}
            />
        );
    }
    if (rows.length === 0) {
        return <EmptyState title="Nothing in the trash" body={`No deleted ${plural} that you can see.`} />;
    }
    return (
        <section aria-label={`Deleted ${plural}`} className="flex flex-col gap-3">
            <p className="m-0 text-xs text-text-muted">
                {first?.totalIsExact === false ? `${first.total.toLocaleString()}+` : first?.total.toLocaleString()}{' '}
                deleted {plural}
            </p>
            <ul className="m-0 list-none divide-y divide-border rounded-lg border border-border bg-surface p-0">
                {rows.map((row) => {
                    const { name, detail } = naming(object, row);
                    const d = row.deletion;
                    const by = d.byMemberId ? (members.get(d.byMemberId) ?? 'a former member') : null;
                    const owner = row.ownerId ? (members.get(row.ownerId) ?? null) : null;
                    return (
                        <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <p className="m-0 truncate text-sm font-medium">{name}</p>
                                {detail && <p className="m-0 truncate text-xs text-text-muted">{detail}</p>}
                                <p className="m-0 mt-1 text-xs text-text-muted">
                                    Deleted {formatRelative(d.at)}
                                    {by ? ` by ${by}` : ''}
                                    {d.reason ? ` · ${DELETE_REASON_LABEL[d.reason]}` : ''}
                                    {owner ? ` · Owner: ${owner}` : ''}
                                </p>
                                {d.note && <p className="m-0 mt-0.5 text-xs text-text-muted">“{d.note}”</p>}
                            </div>
                            <Button
                                size="sm"
                                shape="square"
                                disabled={restore.isPending}
                                aria-label={`Restore ${name}`}
                                onClick={() => void putBack(row.id, name)}
                            >
                                <RotateCcw aria-hidden /> Restore
                            </Button>
                        </li>
                    );
                })}
            </ul>
            {pages.hasNextPage && (
                <Button
                    className="self-start"
                    shape="square"
                    loading={pages.isFetchingNextPage}
                    onClick={() => void pages.fetchNextPage()}
                >
                    Show more
                </Button>
            )}
        </section>
    );
}
