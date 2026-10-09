import { CAPABILITIES, type Capability } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
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
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateRole, useRemoveRole, useRoles, useUpdateRole } from '../../../api/queries';
import type { RoleView } from '../../../api/types';
import { describeCapability } from '../../../auth/capabilities';
import { useWorkspaceId } from '../../params';

/** The catalogue grouped by its subject, for the editor. */
/** The system admin role holds every capability and is read-only. */
const isAdmin = (role: RoleView) => role.isSystem && role.name === 'admin';

const GROUPS = Array.from(
    CAPABILITIES.reduce((map, cap) => {
        const subject = cap.split(':')[0] ?? cap;
        map.set(subject, [...(map.get(subject) ?? []), cap]);
        return map;
    }, new Map<string, Capability[]>()),
);

export function Roles() {
    const workspaceId = useWorkspaceId();
    const roles = useRoles(workspaceId);
    const remove = useRemoveRole(workspaceId);
    const [editing, setEditing] = useState<RoleView | 'new' | null>(null);
    if (roles.isError) throw roles.error;
    return (
        <>
            <DataTableChrome
                tabs={[{ id: 'all', label: 'All', count: roles.data?.length }]}
                activeTab="all"
                toolbar={{
                    extra: (
                        <Button
                            data-primary-action
                            variant="primary"
                            shape="square"
                            size="sm"
                            onClick={() => setEditing('new')}
                        >
                            New role
                        </Button>
                    ),
                }}
                data={{
                    label: 'Roles',
                    loading: roles.isPending,
                    rows: roles.data ?? [],
                    getRowId: (role) => role.id,
                    empty: <EmptyState className="m-4" title="No roles" body="Every workspace has admin and member." />,
                    columns: [
                        {
                            id: 'role',
                            header: 'Role',
                            cell: (role) => (
                                <>
                                    <span className="font-medium">{role.name}</span>
                                    {role.isSystem && (
                                        <Badge className="ml-2" shape="pill">
                                            system
                                        </Badge>
                                    )}
                                </>
                            ),
                        },
                        {
                            id: 'capabilities',
                            header: 'Capabilities',
                            muted: true,
                            cell: (role) =>
                                isAdmin(role) ? 'Everything' : `${role.capabilities.length} of ${CAPABILITIES.length}`,
                        },
                    ],
                    rowActions: {
                        label: (role) => role.name,
                        items: (role) => (
                            <>
                                <DropdownMenuItem onSelect={() => setEditing(role)}>
                                    {isAdmin(role) ? 'View' : 'Edit'}
                                </DropdownMenuItem>
                                {!role.isSystem && (
                                    <DropdownMenuItem destructive onSelect={() => remove.mutate(role.id)}>
                                        Delete
                                    </DropdownMenuItem>
                                )}
                            </>
                        ),
                    },
                }}
            />
            <RoleDialog workspaceId={workspaceId} role={editing} onClose={() => setEditing(null)} />
        </>
    );
}

function RoleDialog({
    workspaceId,
    role,
    onClose,
}: {
    workspaceId: string;
    role: RoleView | 'new' | null;
    onClose: () => void;
}) {
    const open = role !== null;
    const existing = role !== 'new' ? role : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-2xl">
                {/* The form's initial values come from the role; a different role is a different form (key), not an effect. */}
                {open && (
                    <RoleForm
                        key={existing?.id ?? 'new'}
                        workspaceId={workspaceId}
                        existing={existing}
                        onClose={onClose}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function RoleForm({
    workspaceId,
    existing,
    onClose,
}: {
    workspaceId: string;
    existing: RoleView | null;
    onClose: () => void;
}) {
    const create = useCreateRole(workspaceId);
    const update = useUpdateRole(workspaceId);
    const [name, setName] = useState(existing?.name ?? '');
    const [selected, setSelected] = useState<Set<Capability>>(() => new Set(existing?.capabilities ?? []));
    const readOnly = existing !== null && isAdmin(existing);

    const toggle = (cap: Capability) =>
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(cap)) next.delete(cap);
            else next.add(cap);
            return next;
        });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const capabilities = [...selected];
        if (existing) update.mutate({ roleId: existing.id, name, capabilities }, { onSuccess: onClose });
        else create.mutate({ name, capabilities }, { onSuccess: onClose });
    };
    const pending = create.isPending || update.isPending;
    const error = (create.error ?? update.error) as unknown;
    const message =
        error instanceof ApiError ? error.message : error instanceof Error ? 'Could not save the role.' : undefined;

    return (
        <>
            <DialogTitle>{readOnly ? 'Admin' : existing ? `Edit ${existing.name}` : 'New role'}</DialogTitle>
            <DialogDescription>
                {readOnly
                    ? 'The admin role holds every capability and cannot be edited.'
                    : 'Pick what members with this role may do.'}
            </DialogDescription>
            <form onSubmit={submit}>
                <DialogBody className="grid gap-5">
                    {!readOnly && (
                        <Field label="Name" required error={message}>
                            <Input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={existing?.isSystem}
                            />
                        </Field>
                    )}
                    <fieldset className="grid gap-4 sm:grid-cols-2">
                        <legend className="sr-only">Capabilities</legend>
                        {GROUPS.map(([subject, caps]) => (
                            <div key={subject}>
                                <div className="mb-1.5 text-[11.5px] font-medium text-text-faint capitalize">
                                    {subject}
                                </div>
                                {caps.map((cap) => (
                                    <label key={cap} className="flex items-center gap-2 py-1 text-sm">
                                        <Checkbox
                                            checked={readOnly || selected.has(cap)}
                                            disabled={readOnly}
                                            onCheckedChange={() => toggle(cap)}
                                            aria-label={cap}
                                        />
                                        <span className="capitalize">{describeCapability(cap)}</span>
                                        <code className="ml-auto text-xs text-text-faint">{cap}</code>
                                    </label>
                                ))}
                            </div>
                        ))}
                    </fieldset>
                </DialogBody>
                <DialogFooter>
                    <Button type="button" onClick={onClose}>
                        {readOnly ? 'Close' : 'Cancel'}
                    </Button>
                    {!readOnly && (
                        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
                            {existing ? 'Save' : 'Create role'}
                        </Button>
                    )}
                </DialogFooter>
            </form>
        </>
    );
}
