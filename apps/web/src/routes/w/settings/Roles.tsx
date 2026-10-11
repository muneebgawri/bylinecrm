import { CAPABILITIES, type Capability, type RecordScope } from '@bylinecrm/shared';
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
    RadioGroup,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { useCreateRole, useRemoveRole, useRoles, useUpdateRole } from '../../../api/team';
import type { RoleView } from '../../../api/types';
import { useWorkspaceId } from '../../params';
import { CAPABILITY_AREA_LABEL, CAPABILITY_LABEL } from './settingsText';

/** The system admin role holds every capability and is read-only. */
const isAdmin = (role: RoleView) => role.isSystem && role.name === 'admin';

/** The catalogue grouped by its area, for the editor; labels from `settingsText`. */
const GROUPS = Array.from(
    CAPABILITIES.reduce((map, cap) => {
        const subject = cap.split(':')[0] ?? cap;
        map.set(subject, [...(map.get(subject) ?? []), cap]);
        return map;
    }, new Map<string, Capability[]>()),
);

/** Which records a role's members see (P1-1a's owner scope), in words. */
const SCOPE_OPTIONS: readonly { value: RecordScope; label: string; description: string }[] = [
    {
        value: 'all',
        label: 'All records',
        description: 'Members see every person, company and deal they have permission to read.',
    },
    {
        value: 'own',
        label: 'Only records they own',
        description:
            'Members see the people, companies and deals whose owner is them; anyone else’s are hidden, as if they did not exist.',
    },
];

const SCOPE_SUMMARY: Record<RecordScope, string> = { all: 'All records', own: 'Only their own records' };

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
                            data-primary-dialog
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
                            id: 'scope',
                            header: 'Records',
                            muted: true,
                            cell: (role) => SCOPE_SUMMARY[role.recordScope],
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
    const [recordScope, setRecordScope] = useState<RecordScope>(existing?.recordScope ?? 'all');
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
        // In catalogue order, so the request reads the same whatever order the boxes were ticked.
        const capabilities = CAPABILITIES.filter((cap) => selected.has(cap));
        if (existing) update.mutate({ roleId: existing.id, name, capabilities, recordScope }, { onSuccess: onClose });
        else create.mutate({ name, capabilities, recordScope }, { onSuccess: onClose });
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
                    {!readOnly && (
                        <RadioGroup
                            legend="Which records members see"
                            options={SCOPE_OPTIONS}
                            value={recordScope}
                            onValueChange={setRecordScope}
                        />
                    )}
                    <div className="grid gap-4 sm:grid-cols-2">
                        {GROUPS.map(([subject, caps]) => (
                            <fieldset key={subject} className="m-0 border-0 p-0">
                                <legend className="mb-1.5 p-0 text-[11.5px] font-medium text-text-faint">
                                    {CAPABILITY_AREA_LABEL[subject] ?? subject}
                                </legend>
                                {caps.map((cap) => (
                                    <div key={cap} className="flex items-center gap-2 py-1 text-sm max-md:min-h-touch">
                                        <Checkbox
                                            id={`cap-${cap}`}
                                            checked={readOnly || selected.has(cap)}
                                            disabled={readOnly}
                                            onCheckedChange={() => toggle(cap)}
                                        />
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <label htmlFor={`cap-${cap}`}>{CAPABILITY_LABEL[cap]}</label>
                                            </TooltipTrigger>
                                            {/* The catalogue string, for the admin wiring an API key or reading the docs. */}
                                            <TooltipContent>{cap}</TooltipContent>
                                        </Tooltip>
                                    </div>
                                ))}
                            </fieldset>
                        ))}
                    </div>
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
