import {
    Badge,
    Button,
    DataTableChrome,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    EmptyState,
    Field,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    tableClasses,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateInvite, useInvites, useRevokeInvite, useRoles } from '../../../api/queries';
import { useWorkspaceId } from '../../params';
import { SecretOnce } from './ApiKeys';
import { TableSkeleton } from './Members';
import { formatDate } from './SettingsLayout';

export function Invites() {
    const workspaceId = useWorkspaceId();
    const invites = useInvites(workspaceId);
    const roles = useRoles(workspaceId);
    const revoke = useRevokeInvite(workspaceId);
    const [creating, setCreating] = useState(false);
    if (invites.isError) throw invites.error;
    const roleName = (id: string) => roles.data?.find((r) => r.id === id)?.name ?? '…';
    return (
        <>
            <DataTableChrome
                tabs={[{ id: 'all', label: 'All', count: invites.data?.length }]}
                activeTab="all"
                toolbar={{
                    extra: (
                        <Button variant="primary" shape="square" size="sm" onClick={() => setCreating(true)}>
                            Invite member
                        </Button>
                    ),
                }}
            >
                {invites.isPending ? (
                    <TableSkeleton />
                ) : invites.data.length === 0 ? (
                    <EmptyState
                        className="m-4"
                        title="No invitations"
                        body="Invite a colleague by email; they join with the role you pick."
                    />
                ) : (
                    <table className={tableClasses.table}>
                        <thead>
                            <tr>
                                <th className={tableClasses.th}>Email</th>
                                <th className={tableClasses.th}>Role</th>
                                <th className={tableClasses.th}>Expires</th>
                                <th className={tableClasses.th}>Status</th>
                                <th className={tableClasses.th}>
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {invites.data.map((inv) => (
                                <tr key={inv.id} className={tableClasses.tr}>
                                    <td className={`${tableClasses.td} font-medium`}>{inv.email}</td>
                                    <td className={tableClasses.td}>{roleName(inv.roleId)}</td>
                                    <td className={`${tableClasses.td} ${tableClasses.muted}`}>
                                        {formatDate(inv.expiresAt)}
                                    </td>
                                    <td className={tableClasses.td}>
                                        {inv.acceptedAt ? (
                                            <Badge status="success">Accepted</Badge>
                                        ) : new Date(inv.expiresAt) < new Date() ? (
                                            <Badge status="warning">Expired</Badge>
                                        ) : (
                                            <Badge status="info">Pending</Badge>
                                        )}
                                    </td>
                                    <td className={`${tableClasses.td} text-right`}>
                                        {!inv.acceptedAt && (
                                            <Button
                                                size="sm"
                                                shape="square"
                                                variant="ghost"
                                                className="text-danger"
                                                loading={revoke.isPending && revoke.variables === inv.id}
                                                onClick={() => revoke.mutate(inv.id)}
                                            >
                                                Revoke
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </DataTableChrome>
            <InviteDialog workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />
        </>
    );
}

function InviteDialog({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
    const roles = useRoles(workspaceId);
    const create = useCreateInvite(workspaceId);
    const [email, setEmail] = useState('');
    const [roleId, setRoleId] = useState('');
    const [token, setToken] = useState<string | null>(null);

    const close = () => {
        setToken(null);
        setEmail('');
        setRoleId('');
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate({ email, roleId }, { onSuccess: (result) => setToken(result.token) });
    };
    const message =
        create.error instanceof ApiError
            ? create.error.message
            : create.isError
              ? 'Could not create the invitation.'
              : undefined;
    const link = token ? `${window.location.origin}/sign-up?invite=${encodeURIComponent(token)}` : '';

    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>{token ? 'Invitation ready' : 'Invite a member'}</DialogTitle>
                <DialogDescription>
                    {token
                        ? 'Invitation email is not sent yet; hand this link to the person. It is shown once.'
                        : 'They join with the role you pick; an admin can change it later.'}
                </DialogDescription>
                {token ? (
                    <>
                        <DialogBody>
                            <SecretOnce value={link} />
                        </DialogBody>
                        <DialogFooter>
                            <Button variant="primary" onClick={close}>
                                Done
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <form onSubmit={submit}>
                        <DialogBody className="grid gap-4">
                            <Field label="Email" required error={message}>
                                <Input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="name@company.com"
                                />
                            </Field>
                            <Field label="Role" required>
                                <Select value={roleId} onValueChange={setRoleId}>
                                    <SelectTrigger aria-label="Role">
                                        <SelectValue placeholder="Choose a role" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(roles.data ?? []).map((r) => (
                                            <SelectItem key={r.id} value={r.id}>
                                                {r.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </DialogBody>
                        <DialogFooter>
                            <Button type="button" onClick={close}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                variant="primary"
                                loading={create.isPending}
                                disabled={!email.trim() || !roleId}
                            >
                                Create invitation
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
