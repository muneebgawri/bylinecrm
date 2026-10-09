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
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useRoles } from '../../../api/queries';
import { useWorkspaceId } from '../../params';
import { formatDate } from './SettingsLayout';

export function ApiKeys() {
    const workspaceId = useWorkspaceId();
    const keys = useApiKeys(workspaceId);
    const revoke = useRevokeApiKey(workspaceId);
    const [creating, setCreating] = useState(false);
    if (keys.isError) throw keys.error;
    const live = (keys.data ?? []).filter((k) => !k.revokedAt);
    const revoked = (keys.data ?? []).filter((k) => k.revokedAt);
    return (
        <>
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'Active', count: live.length },
                    { id: 'revoked', label: 'Revoked', count: revoked.length },
                ]}
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
                            New key
                        </Button>
                    ),
                }}
                data={{
                    label: 'API keys',
                    loading: keys.isPending,
                    rows: keys.data ?? [],
                    getRowId: (k) => k.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No API keys"
                            body="A key lets a machine call this workspace with a role's permissions."
                        />
                    ),
                    columns: [
                        { id: 'name', header: 'Name', className: 'font-medium', cell: (k) => k.name },
                        { id: 'prefix', header: 'Prefix', cell: (k) => <code className="text-xs">{k.prefix}…</code> },
                        {
                            id: 'created',
                            header: 'Created',
                            muted: true,
                            phone: 'hidden',
                            cell: (k) => formatDate(k.createdAt),
                        },
                        {
                            id: 'lastUsed',
                            header: 'Last used',
                            muted: true,
                            phone: 'secondary',
                            cell: (k) => formatDate(k.lastUsedAt),
                        },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'meta',
                            cell: (k) =>
                                k.revokedAt ? (
                                    <Badge status="danger">Revoked</Badge>
                                ) : (
                                    <Badge status="success" dot>
                                        Active
                                    </Badge>
                                ),
                        },
                    ],
                    rowActions: {
                        label: (k) => k.name,
                        items: (k) =>
                            k.revokedAt ? null : (
                                <DropdownMenuItem destructive onSelect={() => revoke.mutate(k.id)}>
                                    Revoke
                                </DropdownMenuItem>
                            ),
                    },
                }}
            />
            <CreateKeyDialog workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />
        </>
    );
}

function CreateKeyDialog({ workspaceId, open, onClose }: { workspaceId: string; open: boolean; onClose: () => void }) {
    const roles = useRoles(workspaceId);
    const create = useCreateApiKey(workspaceId);
    const [name, setName] = useState('');
    const [roleId, setRoleId] = useState('');
    const [secret, setSecret] = useState<string | null>(null);

    const close = () => {
        setSecret(null);
        setName('');
        setRoleId('');
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate({ name, roleId }, { onSuccess: (result) => setSecret(result.secret) });
    };
    const message =
        create.error instanceof ApiError
            ? create.error.message
            : create.isError
              ? 'Could not create the key.'
              : undefined;

    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>{secret ? 'Your new key' : 'New API key'}</DialogTitle>
                <DialogDescription>
                    {secret
                        ? 'Copy it now. It is shown once and cannot be recovered; a lost key is revoked and replaced.'
                        : 'The key calls this workspace with the chosen role’s permissions.'}
                </DialogDescription>
                {secret ? (
                    <>
                        <DialogBody>
                            <SecretOnce value={secret} />
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
                            <Field label="Name" required error={message}>
                                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zapier" />
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
                                disabled={!name.trim() || !roleId}
                            >
                                Create key
                            </Button>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** A value shown once with a copy button; the copy result is announced, never assumed. */
export function SecretOnce({ value }: { value: string }) {
    const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied('copied');
        } catch {
            setCopied('failed');
        }
    };
    return (
        <div className="grid gap-2">
            <code className="block rounded-md border border-border bg-surface-raised px-3 py-2 text-sm break-all select-all">
                {value}
            </code>
            <div className="flex items-center gap-2">
                <Button size="sm" shape="square" onClick={copy}>
                    Copy
                </Button>
                <span role="status" className="text-xs text-text-muted">
                    {copied === 'copied'
                        ? 'Copied.'
                        : copied === 'failed'
                          ? 'Could not copy — select it and copy by hand.'
                          : ''}
                </span>
            </div>
        </div>
    );
}
