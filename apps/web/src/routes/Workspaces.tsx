import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    EmptyState,
    Field,
    Input,
    Skeleton,
    cn,
    focusRing,
} from '@bylinecrm/ui';
import { ChevronRight, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useCreateWorkspace, useWorkspaces } from '../api/queries';
import { LogoMark } from '../shell/LogoMark';
import { paths } from './paths';

/** The picker. Exactly one workspace sends the person straight in; none offers to create one. */
export function Workspaces() {
    const workspaces = useWorkspaces();
    const [creating, setCreating] = useState(false);

    if (workspaces.isPending) {
        return (
            <Frame>
                <div className="grid gap-2" aria-label="Loading your workspaces">
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                </div>
            </Frame>
        );
    }
    if (workspaces.isError) throw workspaces.error;
    const list = workspaces.data;
    if (list.length === 1 && list[0]) return <Navigate to={paths.home(list[0].id)} replace />;

    return (
        <Frame
            action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus aria-hidden /> New workspace
                </Button>
            }
        >
            {list.length === 0 ? (
                <EmptyState
                    title="You are not in a workspace yet"
                    body="Create one for your team, or accept an invitation from a colleague."
                    action={
                        <Button variant="primary" shape="square" onClick={() => setCreating(true)}>
                            Create a workspace
                        </Button>
                    }
                />
            ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {list.map((w) => (
                        <li key={w.id}>
                            <Link
                                to={paths.home(w.id)}
                                className={cn(
                                    'flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm hover:bg-surface-raised',
                                    focusRing,
                                )}
                            >
                                <LogoMark />
                                <span className="min-w-0 leading-tight">
                                    <b className="block truncate font-medium">{w.name}</b>
                                    <span className="text-xs text-text-muted">{w.slug}</span>
                                </span>
                                <ChevronRight aria-hidden className="ml-auto size-4 text-text-faint" />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
            <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
        </Frame>
    );
}

function Frame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
    return (
        <main className="min-h-dvh bg-background px-4 py-12 text-text">
            <div className="mx-auto w-full max-w-130">
                <div className="mb-5 flex items-center gap-3">
                    <h1 className="m-0 text-2xl font-semibold tracking-tight">Your workspaces</h1>
                    {action && <div className="ml-auto">{action}</div>}
                </div>
                {children}
            </div>
        </main>
    );
}

export function CreateWorkspaceDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const navigate = useNavigate();
    const create = useCreateWorkspace();
    const [name, setName] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(name, {
            onSuccess: (workspace) => {
                onOpenChange(false);
                navigate(paths.home(workspace.id));
            },
        });
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>New workspace</DialogTitle>
                <DialogDescription>You will be its first admin.</DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody>
                        <Field
                            label="Name"
                            required
                            error={create.isError ? 'Could not create the workspace.' : undefined}
                        >
                            <Input
                                autoFocus
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Acme PR"
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                            Create
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
