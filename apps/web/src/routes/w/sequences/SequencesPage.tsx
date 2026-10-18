import { SEQUENCE_LIMITS, SEQUENCE_WINDOW_DEFAULTS, type SequenceVisibility } from '@bylinecrm/shared';
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
    RadioGroup,
    PageHeader,
} from '@bylinecrm/ui';
import { ListOrdered } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useCreateSequence, useSequences } from '../../../api/sequences';
import type { SequenceStatus, SequenceView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { CREATE_PARAM, paths } from '../../paths';
import { SEQUENCE_STATUS_LABEL, SEQUENCE_STATUS_TONE } from './sequenceText';
import { VISIBILITY_LEGEND, VISIBILITY_OPTIONS } from './visibility';

type Tab = 'current' | 'archived';

/**
 * The workspace's sequences (doc 50 §D): a list in the shared table — cards on a phone — with each
 * sequence's state and its enrolment counts, read from the enrolment rows. A sequence opens in its
 * builder; "New sequence" names one and goes there.
 */
export function SequencesPage() {
    const workspaceId = useWorkspaceId();
    const [search, setSearch] = useSearchParams();
    const [tab, setTab] = useState<Tab>('current');
    const list = useSequences(workspaceId);
    const write = usePermission('sequence:write');
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
    const all = list.data ?? [];
    const rows = all.filter((s) => (tab === 'archived' ? s.status === 'archived' : s.status !== 'archived'));

    return (
        <div className="p-7 max-md:p-4">
            <PageHeader
                title="Sequences"
                subtitle="Emails and waits that run on their own, and stop on a reply, a bounce, an unsubscribe or a stage change."
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
                        New sequence
                    </Button>
                }
            />
            <DataTableChrome
                tabs={[
                    { id: 'current', label: 'Current' },
                    { id: 'archived', label: 'Archived' },
                ]}
                activeTab={tab}
                onTabChange={setTab}
                data={{
                    label: 'Sequences',
                    loading: list.isPending,
                    rows,
                    getRowId: (s) => s.id,
                    leading: () => <ListOrdered aria-hidden className="size-5 text-text-muted" />,
                    empty:
                        tab === 'archived' ? (
                            <EmptyState
                                className="m-4"
                                title="No archived sequences"
                                body="An archived sequence is read-only and enrols nobody."
                            />
                        ) : (
                            <EmptyState
                                className="m-4"
                                title="No sequences yet"
                                body="A sequence sends outreach templates with waits between them, from the sending pool, and stops itself when the person answers."
                                action={
                                    write.allowed ? (
                                        <Button variant="primary" shape="square" onClick={() => setCreating(true)}>
                                            New sequence
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
                            cell: (s) => (
                                <span className="flex flex-wrap items-center gap-2">
                                    <Link
                                        to={paths.sequence(workspaceId, s.id)}
                                        className="hover:underline max-md:flex max-md:min-h-touch max-md:items-center"
                                    >
                                        {s.name}
                                    </Link>
                                    {s.visibility === 'private' && <Badge status="neutral">Private</Badge>}
                                </span>
                            ),
                        },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'meta',
                            cell: (s) => <StatusBadge status={s.status} />,
                        },
                        {
                            id: 'steps',
                            header: 'Emails',
                            muted: true,
                            phone: 'secondary',
                            cell: (s) => s.steps.filter((step) => step.kind === 'email').length,
                        },
                        {
                            id: 'enrolled',
                            header: 'Enrolled',
                            muted: true,
                            phone: 'secondary',
                            cell: (s) => s.counts.enrolled,
                        },
                        { id: 'active', header: 'Active', muted: true, cell: (s) => s.counts.active },
                        { id: 'updated', header: 'Updated', muted: true, cell: (s) => formatDate(s.updatedAt) },
                    ],
                }}
            />
            <NewSequenceDialog workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />
        </div>
    );
}

export function StatusBadge({ status }: { status: SequenceStatus }) {
    return <Badge status={SEQUENCE_STATUS_TONE[status]}>{SEQUENCE_STATUS_LABEL[status]}</Badge>;
}

/** The browser's zone: where a new sequence's fallback zone starts (the API asks for one). */
function browserZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function NewSequenceDialog({
    workspaceId,
    open,
    onClose,
}: {
    workspaceId: string;
    open: boolean;
    onClose: () => void;
}) {
    const navigate = useNavigate();
    const create = useCreateSequence(workspaceId);
    const [name, setName] = useState('');
    const [visibility, setVisibility] = useState<SequenceVisibility>('shared');
    const close = () => {
        setName('');
        setVisibility('shared');
        create.reset();
        onClose();
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(
            { name: name.trim(), timeZone: browserZone(), window: { ...SEQUENCE_WINDOW_DEFAULTS }, visibility },
            {
                onSuccess: (created: SequenceView) => {
                    close();
                    navigate(paths.sequence(workspaceId, created.id));
                },
            },
        );
    };
    const general =
        create.isError && !(create.error instanceof ApiError && create.error.fieldErrors.length > 0)
            ? failureText(create.error)
            : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>New sequence</DialogTitle>
                <DialogDescription>Name it for who it reaches; you add the steps next.</DialogDescription>
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Name" required error={fieldErrorAt(create.error, 'name')}>
                            <Input
                                autoFocus
                                value={name}
                                maxLength={SEQUENCE_LIMITS.name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Q4 agency outreach"
                            />
                        </Field>
                        <RadioGroup
                            legend={VISIBILITY_LEGEND}
                            options={VISIBILITY_OPTIONS}
                            value={visibility}
                            onValueChange={setVisibility}
                        />
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
