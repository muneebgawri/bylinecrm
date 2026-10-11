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
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    EmptyState,
} from '@bylinecrm/ui';
import { useMemo, useState } from 'react';
import { useMe } from '../../../api/queries';
import { useMembers, useRemoveMember, useRoles, useSetMemberRole } from '../../../api/team';
import type { MemberView } from '../../../api/types';
import { useWorkspaceId } from '../../params';
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
                data={{
                    label: 'Members',
                    loading: members.isPending,
                    rows,
                    getRowId: (m) => m.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title={q ? 'No members match' : 'No members yet'}
                            body={q ? 'Try another name or role.' : 'Invite colleagues from the Invites section.'}
                        />
                    ),
                    columns: [
                        {
                            id: 'member',
                            header: 'Member',
                            cell: (m) => <AvatarCell name={m.displayName ?? m.email} subline={m.email} />,
                        },
                        {
                            id: 'role',
                            header: 'Role',
                            cell: (m) => (
                                <>
                                    <Badge status={m.roleName === 'admin' ? 'accent' : 'neutral'}>{m.roleName}</Badge>
                                    {m.userId === me.data?.id && (
                                        <Badge className="ml-2" shape="pill">
                                            You
                                        </Badge>
                                    )}
                                </>
                            ),
                        },
                        { id: 'joined', header: 'Joined', muted: true, cell: (m) => formatDate(m.createdAt) },
                    ],
                    rowActions: {
                        label: (m) => m.email,
                        items: (m) => (
                            <>
                                <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-text-faint">Role</div>
                                <DropdownMenuRadioGroup
                                    value={m.roleId}
                                    onValueChange={(roleId) => setRole.mutate({ memberId: m.id, roleId })}
                                >
                                    {(roles.data ?? []).map((r) => (
                                        <DropdownMenuRadioItem key={r.id} value={r.id}>
                                            {r.name}
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                                <DropdownMenuItem
                                    destructive
                                    disabled={m.userId === me.data?.id}
                                    onSelect={() => setRemoving(m)}
                                >
                                    Remove from workspace
                                </DropdownMenuItem>
                            </>
                        ),
                    },
                }}
            />
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
