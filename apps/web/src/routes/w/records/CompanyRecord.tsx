import { DEFAULT_CURRENCY } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogTitle,
    FactGrid,
} from '@bylinecrm/ui';
import { ListTodo, Mail, StickyNote, Handshake, Users } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { usePatchRecord } from '../../../api/records';
import type { CompanyView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { formatMoney, minorDigits, toMajor, toMinor } from '../../../lib/money';
import { paths } from '../../paths';
import type { ComposerPerson } from '../mail/Composer';
import { RecordCompose, type RecordComposeHandle } from '../mail/RecordCompose';
import { AttachmentsPanel } from './AttachmentsPanel';
import { CompanyDomainsCard } from './CompanyDomainsCard';
import { EnrichmentPanel } from './EnrichmentPanel';
import { InlineSelect, InlineText } from './InlineEdit';
import { NotesPanel } from './NotesPanel';
import { personName, sourceLabel } from './PersonRecord';
import { newswireosClientRow, OwnerControl, PropertiesColumn, type PropertyRow } from './PropertiesColumn';
import { RailCard, RailEmpty, RailLoading, RailRow } from './RailCard';
import { RecordHeader } from './RecordHeader';
import { RecordLayout } from './RecordLayout';
import { RecordActionBar, RecordHeaderActions, type RecordAction } from './recordActions';
import { countLabel, useRelated } from './related';
import { TasksPanel } from './TasksPanel';
import { TimelinePanel } from './TimelinePanel';
import { useRecordCommands } from './useRecordCommands';

/**
 * The company record: the same frame; its timeline merges its people's. Its compose box (GUARD-3's "Start new
 * email") writes to one of the company's people: the only one with an address straight away, else whichever
 * the rep picks — so a first email to a customer or prospect starts in the CRM and continues in Gmail.
 */
export function CompanyRecord({
    workspaceId,
    company,
    layout,
    siblings,
    membersById,
}: {
    workspaceId: string;
    company: CompanyView;
    layout: 'page' | 'drawer';
    siblings?: { prev: string | null; next: string | null } | undefined;
    membersById: ReadonlyMap<string, string>;
}) {
    const patch = usePatchRecord(workspaceId, 'company', company.id);
    const write = usePermission('record:write');
    const people = useRelated(workspaceId, 'person', 'companyId', company.id);
    const deals = useRelated(workspaceId, 'opportunity', 'companyId', company.id);
    const [notesOpen, setNotesOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const ownerId = useId();
    const target = { type: 'company' as const, id: company.id };
    const save = (p: Record<string, unknown>) => patch.mutateAsync(p);
    const currency = company.arr?.currency ?? DEFAULT_CURRENCY;

    const companyPeople = people.items;
    const companyDeals = deals.items;

    // Start new email: whom at this company. One person with an address needs no asking.
    const compose = useRef<RecordComposeHandle>(null);
    const [recipient, setRecipient] = useState<ComposerPerson | null>(null);
    const [choosing, setChoosing] = useState(false);
    const mailable = companyPeople.filter((p) => p.emails.primary);
    const asRecipient = (p: (typeof mailable)[number]): ComposerPerson => ({
        id: p.id,
        name: personName(p),
        email: p.emails.primary,
        source: p.source ?? null,
    });
    const startEmail = () => {
        if (recipient) return compose.current?.start();
        if (mailable.length === 1) {
            setRecipient(asRecipient(mailable[0]!));
            // The composer mounts with the person on the next render; focus it then.
            setTimeout(() => compose.current?.start(), 0);
            return;
        }
        setChoosing(true);
    };
    const choose = (p: (typeof mailable)[number]) => {
        setRecipient(asRecipient(p));
        setChoosing(false);
        setTimeout(() => compose.current?.start(), 0);
    };
    const noOneToEmail = people.data && mailable.length === 0;

    useRecordCommands({
        layout,
        onNote: write.allowed ? () => setNotesOpen(true) : undefined,
        onTask: write.allowed ? () => setTasksOpen(true) : undefined,
        onOwner: write.allowed ? () => document.getElementById(ownerId)?.focus() : undefined,
        onCompose: noOneToEmail ? undefined : startEmail,
        composeTitle: 'Start new email to someone here',
        prev: siblings?.prev,
        next: siblings?.next,
    });

    const standard: PropertyRow[] = [
        {
            field: 'name',
            control: (
                <InlineText
                    label="Name"
                    path="name"
                    value={company.name}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ name: v ?? '' })}
                />
            ),
        },
        {
            field: 'domain',
            control: (
                <InlineText
                    label="Domain"
                    path="domain"
                    value={company.domain}
                    placeholder="example.com"
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ domain: v })}
                />
            ),
        },
        {
            field: 'employeeCount',
            control: (
                <InlineText
                    label="Employees"
                    path="employeeCount"
                    type="number"
                    value={company.employeeCount === null ? null : String(company.employeeCount)}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ employeeCount: v === null ? null : Number(v) })}
                />
            ),
        },
        {
            field: 'arr',
            control: (
                <InlineText
                    label={`ARR (${currency})`}
                    path="arr"
                    type="number"
                    value={company.arr ? toMajor(company.arr).toFixed(minorDigits(currency)) : null}
                    display={() => formatMoney(company.arr)}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) =>
                        save({ arr: v === null ? null : { amountMinor: toMinor(Number(v), currency), currency } })
                    }
                />
            ),
        },
        {
            field: 'ownerId',
            control: (
                <OwnerControl
                    workspaceId={workspaceId}
                    object="company"
                    recordId={company.id}
                    value={company.ownerId}
                    onSave={(v) => save({ ownerId: v })}
                    id={ownerId}
                />
            ),
        },
        {
            field: 'icp',
            control: (
                <InlineSelect
                    label="Ideal customer"
                    path="icp"
                    value={company.icp ? 'true' : 'false'}
                    options={[
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' },
                    ]}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ icp: v === 'true' })}
                />
            ),
        },
        {
            field: 'address',
            control: (
                <InlineText
                    label="City"
                    path="address.city"
                    value={company.address.city}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ address: { ...company.address, city: v } })}
                />
            ),
        },
        {
            field: 'links',
            control: (
                <InlineText
                    label="LinkedIn"
                    path="links.linkedin.url"
                    type="url"
                    value={company.links.linkedin?.url ?? null}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ links: { ...company.links, linkedin: v ? { url: v, label: null } : null } })}
                />
            ),
        },
        ...newswireosClientRow(company.newswireosCustomerId),
    ];

    const actions: RecordAction[] = [
        {
            id: 'email',
            label: 'Start new email',
            short: 'Email',
            icon: <Mail aria-hidden />,
            onSelect: startEmail,
            disabled: !!noOneToEmail,
            reason: noOneToEmail ? 'No one at this company has an email address yet.' : undefined,
            hint: 'Write a first email to someone here (e)',
        },
        {
            id: 'note',
            label: 'Add note',
            short: 'Note',
            icon: <StickyNote aria-hidden />,
            onSelect: () => setNotesOpen(true),
            disabled: !write.allowed,
            reason: write.reason || undefined,
            hint: 'Add a note (n)',
        },
        {
            id: 'task',
            label: 'Add task',
            short: 'Task',
            icon: <ListTodo aria-hidden />,
            primary: true,
            onSelect: () => setTasksOpen(true),
            disabled: !write.allowed,
            reason: write.reason || undefined,
            hint: 'Add a task (t)',
        },
    ];

    return (
        <RecordLayout
            layout={layout}
            bar={<RecordActionBar name={company.name} actions={actions} siblings={siblings} />}
            header={
                <RecordHeader
                    layout={layout}
                    name={company.name}
                    avatarSrc={company.logoUrl}
                    subtitle={
                        [company.domain, company.address.city, company.address.country].filter(Boolean).join(' · ') ||
                        undefined
                    }
                    status={company.icp ? <Badge status="accent">Ideal customer</Badge> : undefined}
                    back={{ to: paths.companies(workspaceId), label: 'Companies' }}
                    siblings={siblings}
                    actions={<RecordHeaderActions actions={actions} />}
                />
            }
            facts={
                <FactGrid
                    facts={[
                        {
                            label: 'Owner',
                            value: company.ownerId ? (membersById.get(company.ownerId) ?? '…') : 'Unassigned',
                        },
                        { label: 'ARR', value: formatMoney(company.arr) },
                        { label: 'People', value: people.data ? countLabel(companyPeople.length, people.more) : '…' },
                        {
                            label: 'Open deals',
                            value: deals.data
                                ? countLabel(companyDeals.filter((d) => !d.closedAt).length, deals.more)
                                : '…',
                        },
                    ]}
                />
            }
            properties={
                <PropertiesColumn
                    workspaceId={workspaceId}
                    object="company"
                    custom={company.custom}
                    standard={standard}
                    audit={{
                        createdAt: company.createdAt,
                        updatedAt: company.updatedAt,
                        createdBy: sourceLabel(company.createdBy.kind),
                    }}
                    onSave={save}
                    canEdit={write.allowed}
                    reason={write.reason}
                />
            }
            rail={
                <>
                    <EnrichmentPanel workspaceId={workspaceId} object="company" recordId={company.id} />
                    <CompanyDomainsCard workspaceId={workspaceId} companyId={company.id} ownerId={company.ownerId} />
                    <RailCard
                        title="People"
                        icon={<Users />}
                        count={people.data && !people.more ? companyPeople.length : undefined}
                    >
                        {people.isPending ? (
                            <RailLoading />
                        ) : companyPeople.length === 0 ? (
                            <RailEmpty>No people at this company yet.</RailEmpty>
                        ) : (
                            companyPeople.map((p) => (
                                <RailRow
                                    key={p.id}
                                    to={paths.person(workspaceId, p.id)}
                                    title={personName(p)}
                                    subtitle={p.jobTitle ?? p.emails.primary ?? undefined}
                                />
                            ))
                        )}
                    </RailCard>
                    <RailCard
                        title="Deals"
                        icon={<Handshake />}
                        count={deals.data && !deals.more ? companyDeals.length : undefined}
                    >
                        {deals.isPending ? (
                            <RailLoading />
                        ) : companyDeals.length === 0 ? (
                            <RailEmpty>No deals with this company yet.</RailEmpty>
                        ) : (
                            companyDeals.map((d) => (
                                <RailRow
                                    key={d.id}
                                    to={paths.deal(workspaceId, d.id)}
                                    title={d.name}
                                    subtitle={`${formatMoney(d.amount)} · ${d.daysInStage}d in stage`}
                                />
                            ))
                        )}
                    </RailCard>
                    <TasksPanel
                        workspaceId={workspaceId}
                        target={target}
                        open={tasksOpen}
                        onOpenChange={setTasksOpen}
                    />
                    <NotesPanel
                        workspaceId={workspaceId}
                        target={target}
                        open={notesOpen}
                        onOpenChange={setNotesOpen}
                    />
                    <AttachmentsPanel workspaceId={workspaceId} target={target} />
                </>
            }
        >
            {recipient && <RecordCompose workspaceId={workspaceId} person={recipient} handle={compose} />}
            <TimelinePanel workspaceId={workspaceId} target={target} />
            <Dialog open={choosing} onOpenChange={setChoosing}>
                <DialogContent>
                    <DialogTitle>Start new email</DialogTitle>
                    <DialogDescription>Whom at {company.name} do you want to write to?</DialogDescription>
                    <DialogBody className="flex flex-col gap-1">
                        {mailable.map((p) => (
                            <Button
                                key={p.id}
                                type="button"
                                variant="ghost"
                                className="justify-start"
                                onClick={() => choose(p)}
                            >
                                <span className="truncate font-medium">{personName(p)}</span>
                                <span className="ml-2 truncate text-text-muted">{p.jobTitle ?? p.emails.primary}</span>
                            </Button>
                        ))}
                    </DialogBody>
                </DialogContent>
            </Dialog>
        </RecordLayout>
    );
}
