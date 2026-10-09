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
    DropdownMenuItem,
    EmptyState,
    Field,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateInvite, useInvites, useRevokeInvite, useRoles } from '../../../api/queries';
import { useWorkspaceId } from '../../params';
import { SecretOnce } from './ApiKeys';
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
                        <Button
                            data-primary-action
                            variant="primary"
                            shape="square"
                            size="sm"
                            onClick={() => setCreating(true)}
                        >
                            Invite member
                        </Button>
                    ),
                }}
                data={{
                    label: 'Invitations',
                    loading: invites.isPending,
                    rows: invites.data ?? [],
                    getRowId: (inv) => inv.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No invitations"
                            body="Invite a colleague by email; they join with the role you pick."
                        />
                    ),
                    columns: [
                        { id: 'email', header: 'Email', className: 'font-medium', cell: (inv) => inv.email },
                        { id: 'role', header: 'Role', cell: (inv) => roleName(inv.roleId) },
                        { id: 'expires', header: 'Expires', muted: true, cell: (inv) => formatDate(inv.expiresAt) },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'meta',
                            cell: (inv) =>
                                inv.acceptedAt ? (
                                    <Badge status="success">Accepted</Badge>
                                ) : new Date(inv.expiresAt) < new Date() ? (
                                    <Badge status="warning">Expired</Badge>
                                ) : (
                                    <Badge status="info">Pending</Badge>
                                ),
                        },
                    ],
                    rowActions: {
                        label: (inv) => inv.email,
                        items: (inv) =>
                            inv.acceptedAt ? null : (
                                <DropdownMenuItem destructive onSelect={() => revoke.mutate(inv.id)}>
                                    Revoke
                                </DropdownMenuItem>
                            ),
                    },
                }}
            />
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
