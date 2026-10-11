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
    PageHeader,
} from '@bylinecrm/ui';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import {
    useCreatePlatformWorkspace,
    useCreateSignupInvite,
    usePlatformAccess,
    usePlatformWorkspaces,
} from '../../api/queries';
import type { PlatformInviteView } from '../../api/types';
import { CopyValue } from '../../components/CopyValue';
import { formatDate } from '../../lib/format';
import { paths } from '../paths';
import { Forbidden, RouteSkeleton } from '../states';

/** What the page says about sign-up, by mode: where new workspaces come from. */
const SUBTITLES = {
    closed: 'Every workspace on this server. Sign-up is closed, so new workspaces start here.',
    invite: 'Every workspace on this server. People sign up only with an invitation from here.',
    open: 'Every workspace on this server. Sign-up is open, so anyone can also create one.',
} as const;

/**
 * Every workspace on this server, for platform admins (P0-14): the list, "New workspace" (a name
 * and the owner's email — the owner gets an invitation link to send), and, when sign-up is by
 * invitation, "Invite to sign up". The API decides who is a platform admin; this page only asks.
 */
export function PlatformWorkspaces() {
    const access = usePlatformAccess();
    const isAdmin = access.data?.platformAdmin === true;
    const workspaces = usePlatformWorkspaces(isAdmin);
    const [creating, setCreating] = useState(false);
    const [inviting, setInviting] = useState(false);

    if (access.isPending) return <RouteSkeleton />;
    if (access.isError) throw access.error;
    if (!isAdmin) return <Forbidden />;
    if (workspaces.isError) throw workspaces.error;

    return (
        <main className="min-h-dvh bg-background px-4 py-8 text-text md:px-7">
            <div className="mx-auto w-full max-w-260">
                <Link
                    to={paths.workspaces}
                    className="mb-4 inline-flex min-h-touch items-center gap-1.5 text-[13px] text-text-muted hover:text-text md:min-h-0"
                >
                    <ArrowLeft aria-hidden className="size-4" /> Your workspaces
                </Link>
                <PageHeader
                    title="Workspaces"
                    subtitle={SUBTITLES[access.data.signupMode]}
                    actions={
                        <>
                            {access.data.signupMode === 'invite' && (
                                <Button shape="square" onClick={() => setInviting(true)}>
                                    Invite to sign up
                                </Button>
                            )}
                            <Button data-primary-action variant="primary" onClick={() => setCreating(true)}>
                                <Plus aria-hidden /> New workspace
                            </Button>
                        </>
                    }
                />
                <DataTableChrome
                    tabs={[{ id: 'all', label: 'All', count: workspaces.data?.length }]}
                    activeTab="all"
                    data={{
                        label: 'Workspaces',
                        loading: workspaces.isPending,
                        rows: workspaces.data ?? [],
                        getRowId: (w) => w.id,
                        empty: (
                            <EmptyState
                                className="m-4"
                                title="No workspaces yet"
                                body="Create one and send its owner the invitation link."
                            />
                        ),
                        columns: [
                            { id: 'name', header: 'Name', className: 'font-medium', cell: (w) => w.name },
                            {
                                id: 'members',
                                header: 'Members',
                                cell: (w) => `${w.memberCount} ${w.memberCount === 1 ? 'member' : 'members'}`,
                            },
                            {
                                id: 'owner',
                                header: 'Owner invitation',
                                phone: 'meta',
                                cell: (w) =>
                                    w.pendingInvites.length > 0 ? (
                                        <Badge status="info">Waiting for {w.pendingInvites[0]?.email}</Badge>
                                    ) : w.memberCount > 0 ? (
                                        <Badge status="success">Joined</Badge>
                                    ) : (
                                        <Badge status="warning">No owner</Badge>
                                    ),
                            },
                            { id: 'created', header: 'Created', muted: true, cell: (w) => formatDate(w.createdAt) },
                        ],
                    }}
                />
            </div>
            <CreateWorkspaceForOwnerDialog open={creating} onClose={() => setCreating(false)} />
            <SignupInviteDialog open={inviting} onClose={() => setInviting(false)} />
        </main>
    );
}

function CreateWorkspaceForOwnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const create = useCreatePlatformWorkspace();
    const [name, setName] = useState('');
    const [ownerEmail, setOwnerEmail] = useState('');
    const [invite, setInvite] = useState<PlatformInviteView | null>(null);
    const close = () => {
        setName('');
        setOwnerEmail('');
        setInvite(null);
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate({ name, ownerEmail }, { onSuccess: (result) => setInvite(result.invite) });
    };
    const failure = create.error instanceof ApiError ? create.error : null;
    const fieldError = (path: string) => failure?.fieldErrors.find((f) => f.path === path)?.message;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>{invite ? 'Workspace created' : 'New workspace'}</DialogTitle>
                <DialogDescription>
                    {invite
                        ? `Send this link to ${invite.email}; they join as the workspace's admin. It is shown once.`
                        : 'Its owner gets an invitation link to join as its first admin.'}
                </DialogDescription>
                {invite ? (
                    <InviteLink invite={invite} onDone={close} />
                ) : (
                    <form onSubmit={submit}>
                        <DialogBody>
                            <Field label="Workspace name" required error={fieldError('name')}>
                                <Input
                                    autoFocus
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Acme PR"
                                />
                            </Field>
                            <Field
                                label="Owner's email"
                                required
                                error={
                                    fieldError('ownerEmail') ??
                                    (failure && failure.fieldErrors.length === 0
                                        ? failure.message
                                        : create.isError && !failure
                                          ? 'Could not reach the server.'
                                          : undefined)
                                }
                            >
                                <Input
                                    type="email"
                                    autoComplete="off"
                                    value={ownerEmail}
                                    onChange={(e) => setOwnerEmail(e.target.value)}
                                />
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
                                disabled={!name.trim() || !ownerEmail.trim()}
                            >
                                Create
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

function SignupInviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const create = useCreateSignupInvite();
    const [email, setEmail] = useState('');
    const [invite, setInvite] = useState<PlatformInviteView | null>(null);
    const close = () => {
        setEmail('');
        setInvite(null);
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate({ email }, { onSuccess: setInvite });
    };
    const failure = create.error instanceof ApiError ? create.error : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>{invite ? 'Invitation ready' : 'Invite to sign up'}</DialogTitle>
                <DialogDescription>
                    {invite
                        ? `Send this link to ${invite.email}; it lets them create an account and a workspace. It is shown once.`
                        : 'The person creates their own account and workspace from the link.'}
                </DialogDescription>
                {invite ? (
                    <InviteLink invite={invite} onDone={close} />
                ) : (
                    <form onSubmit={submit}>
                        <DialogBody>
                            <Field
                                label="Email"
                                required
                                error={
                                    failure?.fieldErrors.find((f) => f.path === 'email')?.message ??
                                    failure?.message ??
                                    (create.isError ? 'Could not reach the server.' : undefined)
                                }
                            >
                                <Input
                                    autoFocus
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                />
                            </Field>
                        </DialogBody>
                        <DialogFooter>
                            <Button type="button" onClick={close}>
                                Cancel
                            </Button>
                            <Button type="submit" variant="primary" loading={create.isPending} disabled={!email.trim()}>
                                Create link
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

function InviteLink({ invite, onDone }: { invite: PlatformInviteView; onDone: () => void }) {
    return (
        <>
            <DialogBody>
                <CopyValue value={invite.url} label="Copy invitation link" />
                <p className="m-0 text-xs text-text-muted">Expires {formatDate(invite.expiresAt)}.</p>
            </DialogBody>
            <DialogFooter>
                <Button variant="primary" onClick={onDone}>
                    Done
                </Button>
            </DialogFooter>
        </>
    );
}
