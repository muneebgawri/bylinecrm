import {
    AvatarCell,
    Badge,
    Button,
    DataTableChrome,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
    EmptyState,
    Skeleton,
    tableClasses,
} from '@bylinecrm/ui';
import { MoreHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useMe, useMembers, useRemoveMember, useRoles, useSetMemberRole } from '../../../api/queries';
import type { MemberView } from '../../../api/types';
import { useWorkspaceId } from '../../params';
import { displayName } from '../../../shell/Sidebar';
import { formatDate } from './SettingsLayout';

export function Members() {
    const workspaceId = useWorkspaceId();
    const me = useMe();
    const members = useMembers(workspaceId);
    const roles = useRoles(workspaceId);
    const setRole = useSetMemberRole(workspaceId);
    const remove = useRemoveMember(workspaceId);
    const [q, setQ] = useState('');
    const [removing, setRemoving] = useState<MemberView | null>(null);

    const rows = useMemo(() => {
        const list = members.data ?? [];
        const needle = q.trim().toLowerCase();
        return needle
            ? list.filter((m) => m.email.toLowerCase().includes(needle) || m.roleName.includes(needle))
            : list;
    }, [members.data, q]);

    if (members.isError) throw members.error;

    return (
        <>
            <DataTableChrome
                tabs={[{ id: 'all', label: 'All', count: members.data?.length }]}
                activeTab="all"
                search={{ value: q, onChange: setQ, placeholder: 'Search members…' }}
            >
                {members.isPending ? (
                    <TableSkeleton />
                ) : rows.length === 0 ? (
                    <EmptyState
                        className="m-4"
                        title={q ? 'No members match' : 'No members yet'}
                        body={q ? 'Try another name or role.' : 'Invite colleagues from the Invites section.'}
                    />
                ) : (
                    <table className={tableClasses.table}>
                        <thead>
                            <tr>
                                <th className={tableClasses.th}>Member</th>
                                <th className={tableClasses.th}>Role</th>
                                <th className={tableClasses.th}>Joined</th>
                                <th className={tableClasses.th}>
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((m) => {
                                const isMe = m.userId === me.data?.id;
                                return (
                                    <tr key={m.id} className={tableClasses.tr}>
                                        <td className={tableClasses.td}>
                                            <AvatarCell name={displayName(m.email)} subline={m.email} />
                                        </td>
                                        <td className={tableClasses.td}>
                                            <Badge status={m.roleName === 'admin' ? 'accent' : 'neutral'}>
                                                {m.roleName}
                                            </Badge>
                                            {isMe && (
                                                <Badge className="ml-2" shape="pill">
                                                    You
                                                </Badge>
                                            )}
                                        </td>
                                        <td className={`${tableClasses.td} ${tableClasses.muted}`}>
                                            {formatDate(m.createdAt)}
                                        </td>
                                        <td className={`${tableClasses.td} text-right`}>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        shape="square"
                                                        aria-label={`Actions for ${m.email}`}
                                                    >
                                                        <MoreHorizontal aria-hidden />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-text-faint">
                                                        Role
                                                    </div>
                                                    <DropdownMenuRadioGroup
                                                        value={m.roleId}
                                                        onValueChange={(roleId) =>
                                                            setRole.mutate({ memberId: m.id, roleId })
                                                        }
                                                    >
                                                        {(roles.data ?? []).map((r) => (
                                                            <DropdownMenuRadioItem key={r.id} value={r.id}>
                                                                {r.name}
                                                            </DropdownMenuRadioItem>
                                                        ))}
                                                    </DropdownMenuRadioGroup>
                                                    <DropdownMenuItem
                                                        destructive
                                                        disabled={isMe}
                                                        onSelect={() => setRemoving(m)}
                                                    >
                                                        Remove from workspace
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </DataTableChrome>
            <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
                <DialogContent>
                    <DialogTitle>Remove {removing?.email}?</DialogTitle>
                    <DialogDescription>
                        They lose access immediately. Records they own keep them as owner until reassigned.
                    </DialogDescription>
                    {remove.isError && (
                        <p role="alert" className="m-0 text-sm text-danger">
                            {remove.error instanceof Error ? remove.error.message : 'Could not remove the member.'}
                        </p>
                    )}
                    <DialogFooter>
                        <Button onClick={() => setRemoving(null)}>Cancel</Button>
                        <Button
                            variant="danger"
                            loading={remove.isPending}
                            onClick={() =>
                                removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })
                            }
                        >
                            Remove
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

export function TableSkeleton() {
    return (
        <div className="grid gap-3 p-4" aria-label="Loading">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
        </div>
    );
}
