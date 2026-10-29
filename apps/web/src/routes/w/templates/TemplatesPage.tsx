import { TEMPLATE_KINDS, TEMPLATE_NAME_MAX, type TemplateKind } from '@bylinecrm/shared';
import {
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
    PageHeader,
    toast,
} from '@bylinecrm/ui';
import { FileText } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useCreateTemplate, useDeleteTemplate, useDuplicateTemplate, useTemplates } from '../../../api/templates';
import type { EmailTemplateView } from '../../../api/types';
import { useCan, usePermission } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useDebounced } from '../../../lib/useDebounced';
import { useWorkspaceId } from '../../params';
import { CREATE_PARAM, paths } from '../../paths';
import { KIND_LABEL, KindBadge, KindPicker } from './kind';

type Tab = 'all' | TemplateKind;

/**
 * The workspace's email templates (doc 50 §C): a list in the shared table — cards on a phone —
 * with a kind filter, search and one primary action. A template is opened by its name; its row
 * menu duplicates or deletes it.
 */
export function TemplatesPage() {
    const workspaceId = useWorkspaceId();
    const navigate = useNavigate();
    const [search, setSearch] = useSearchParams();
    const [tab, setTab] = useState<Tab>('all');
    const [q, setQ] = useState('');
    const term = useDebounced(q).trim();
    const list = useTemplates(workspaceId, { kind: tab === 'all' ? undefined : tab, q: term || undefined });
    const write = usePermission('template:write');
    const outreachWrite = useCan('outreach:write');
    const duplicate = useDuplicateTemplate(workspaceId);
    const remove = useDeleteTemplate(workspaceId);
    const [deleting, setDeleting] = useState<EmailTemplateView | null>(null);
    if (list.isError) throw list.error;

    const creating = search.get(CREATE_PARAM) === '1' && write.allowed;
    const setCreating = (open: boolean) =>
        setSearch(
            (current) => {
                const next = new URLSearchParams(current);
                if (open) next.set(CREATE_PARAM, '1');
                else next.delete(CREATE_PARAM);
                return next;
            },
            { replace: true },
        );
    const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
    const canChange = (t: EmailTemplateView) => write.allowed && (t.kind !== 'outreach' || outreachWrite);

    return (
        <div className="p-4 md:p-6">
            <PageHeader
                title="Templates"
                subtitle="Reusable emails with variables. A variable with no value blocks the send; it is never sent blank."
                actions={
                    <Button
                        data-primary-action
                        data-primary-dialog
                        variant="primary"
                        shape="square"
                        disabled={!write.allowed}
                        title={write.reason || undefined}
                        onClick={() => setCreating(true)}
                    >
                        New template
                    </Button>
                }
            />
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'All' },
                    ...TEMPLATE_KINDS.map((kind) => ({ id: kind, label: KIND_LABEL[kind] })),
                ]}
                activeTab={tab}
                onTabChange={setTab}
                search={{ value: q, onChange: setQ, placeholder: 'Search templates…' }}
                footer={
                    list.hasNextPage ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            loading={list.isFetchingNextPage}
                            onClick={() => void list.fetchNextPage()}
                        >
                            Load more
                        </Button>
                    ) : undefined
                }
                data={{
                    label: 'Templates',
                    loading: list.isPending,
                    rows,
                    getRowId: (t) => t.id,
                    leading: () => <FileText aria-hidden className="size-5 text-text-muted" />,
                    empty:
                        term || tab !== 'all' ? (
                            <EmptyState
                                className="m-4"
                                title="No templates match"
                                body="Clear the search or choose another kind."
                            />
                        ) : (
                            <EmptyState
                                className="m-4"
                                title="No templates yet"
                                body="A template is an email you send again and again, with variables that fill in for each person."
                                action={
                                    write.allowed ? (
                                        <Button variant="primary" shape="square" onClick={() => setCreating(true)}>
                                            New template
                                        </Button>
                                    ) : undefined
                                }
                            />
                        ),
                    columns: [
                        {
                            id: 'name',
                            header: 'Name',
                            className: 'font-medium',
                            // On a phone the name is the card's tap target: full height, 44px.
                            cell: (t) => (
                                <Link
                                    to={paths.template(workspaceId, t.id)}
                                    className="hover:underline max-md:flex max-md:min-h-touch max-md:items-center"
                                >
                                    {t.name}
                                </Link>
                            ),
                        },
                        { id: 'kind', header: 'Kind', phone: 'meta', cell: (t) => <KindBadge kind={t.kind} /> },
                        {
                            id: 'subject',
                            header: 'Subject',
                            muted: true,
                            phone: 'secondary',
                            cell: (t) => <span className="block max-w-80 truncate">{t.subject || '—'}</span>,
                        },
                        {
                            id: 'updated',
                            header: 'Updated',
                            muted: true,
                            phone: 'secondary',
                            cell: (t) => formatDate(t.updatedAt),
                        },
                    ],
                    rowActions: {
                        label: (t) => t.name,
                        items: (t) => (
                            <>
                                <DropdownMenuItem onSelect={() => navigate(paths.template(workspaceId, t.id))}>
                                    Open
                                </DropdownMenuItem>
                                {canChange(t) && (
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            duplicate.mutate(t.id, {
                                                onSuccess: (copy) => navigate(paths.template(workspaceId, copy.id)),
                                                onError: (e) =>
                                                    toast({
                                                        title: 'The template was not duplicated',
                                                        description: failureText(e),
                                                        tone: 'danger',
                                                    }),
                                            })
                                        }
                                    >
                                        Duplicate
                                    </DropdownMenuItem>
                                )}
                                {canChange(t) && (
                                    <DropdownMenuItem destructive onSelect={() => setDeleting(t)}>
                                        Delete
                                    </DropdownMenuItem>
                                )}
                            </>
                        ),
                    },
                }}
            />
            <NewTemplateDialog
                workspaceId={workspaceId}
                open={creating}
                onClose={() => setCreating(false)}
                outreachAllowed={outreachWrite}
            />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleting(null);
                        remove.reset();
                    }
                }}
                title={`Delete “${deleting?.name ?? ''}”?`}
                body="It moves to the trash and stops appearing in pickers. Emails already sent with it are not affected."
                confirm="Delete"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() => {
                    if (!deleting) return;
                    remove.mutate(deleting.id, {
                        onSuccess: () => {
                            toast({ title: 'Template deleted' });
                            setDeleting(null);
                        },
                    });
                }}
            />
        </div>
    );
}

function NewTemplateDialog({
    workspaceId,
    open,
    onClose,
    outreachAllowed,
}: {
    workspaceId: string;
    open: boolean;
    onClose: () => void;
    outreachAllowed: boolean;
}) {
    const navigate = useNavigate();
    const create = useCreateTemplate(workspaceId);
    const [name, setName] = useState('');
    const [kind, setKind] = useState<TemplateKind>('personal');
    const close = () => {
        setName('');
        setKind('personal');
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(
            // A new template starts empty; the editor writes the subject and body next.
            { name: name.trim(), kind, subject: '', body: { type: 'doc', content: [] } },
            {
                onSuccess: (template) => {
                    close();
                    navigate(paths.template(workspaceId, template.id));
                },
            },
        );
    };
    // A field's own error sits under the field; anything else is said once, here.
    const general =
        create.isError && !(create.error instanceof ApiError && create.error.fieldErrors.length > 0)
            ? failureText(create.error)
            : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>New template</DialogTitle>
                <DialogDescription>Name it for what it is for; you write the email next.</DialogDescription>
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Name" required error={fieldErrorAt(create.error, 'name')}>
                            <Input
                                autoFocus
                                value={name}
                                maxLength={TEMPLATE_NAME_MAX}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Intro — PR distribution offer"
                            />
                        </Field>
                        <div className="flex flex-col gap-1.5">
                            <span className="text-[13px] font-medium">Kind</span>
                            <KindPicker value={kind} onChange={setKind} outreachAllowed={outreachAllowed} />
                        </div>
                        {general && (
                            <p role="alert" className="m-0 text-xs text-danger">
                                {general}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="ghost" shape="square" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            shape="square"
                            loading={create.isPending}
                            disabled={name.trim() === ''}
                        >
                            Create
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
