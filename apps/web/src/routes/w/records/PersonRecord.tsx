import { Badge, FactGrid, toast } from '@bylinecrm/ui';
import { ListTodo, Mail, Send, StickyNote } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { usePatchRecord, useRecord } from '../../../api/records';
import type { PersonView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { RecordPicker } from '../../../components/RecordPicker';
import { paths } from '../../paths';
import { RecordCompose, type RecordComposeHandle } from '../mail/RecordCompose';
import { AttachmentsPanel } from './AttachmentsPanel';
import { EnrichmentPanel } from './EnrichmentPanel';
import { InlineText } from './InlineEdit';
import { NotesPanel } from './NotesPanel';
import { OwnerControl, PropertiesColumn, type PropertyRow } from './PropertiesColumn';
import { RailCard, RailEmpty, RailLoading, RailRow } from './RailCard';
import { RecordHeader } from './RecordHeader';
import { RecordLayout } from './RecordLayout';
import { RecordActionBar, RecordHeaderActions, type RecordAction } from './recordActions';
import { useRelated } from './related';
import { TasksPanel } from './TasksPanel';
import { EnrolDialog, enrolSummary } from '../sequences/EnrolDialog';
import { PersonEnrolments } from '../sequences/PersonEnrolments';
import { TimelinePanel } from './TimelinePanel';
import { useRecordCommands } from './useRecordCommands';

export function personName(p: Pick<PersonView, 'nameFirst' | 'nameLast' | 'emails'>): string {
    return `${p.nameFirst} ${p.nameLast}`.trim() || p.emails.primary || 'Unnamed person';
}

/** The person record (doc 50 §A), as a full page or inside the drawer. */
export function PersonRecord({
    workspaceId,
    person,
    layout,
    siblings,
    membersById,
}: {
    workspaceId: string;
    person: PersonView;
    layout: 'page' | 'drawer';
    siblings?: { prev: string | null; next: string | null } | undefined;
    membersById: ReadonlyMap<string, string>;
}) {
    const patch = usePatchRecord(workspaceId, 'person', person.id);
    const write = usePermission('record:write');
    const company = useRecord(workspaceId, 'company', person.companyId ?? '');
    const deals = useRelated(workspaceId, 'opportunity', 'pointOfContactId', person.id);
    const [notesOpen, setNotesOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const enrol = usePermission('sequence:enrol');
    const [enrolling, setEnrolling] = useState(false);
    const compose = useRef<RecordComposeHandle>(null);
    const ownerId = useId();
    const target = { type: 'person' as const, id: person.id };
    const save = (p: Record<string, unknown>) => patch.mutateAsync(p);

    useRecordCommands({
        layout,
        onNote: write.allowed ? () => setNotesOpen(true) : undefined,
        onTask: write.allowed ? () => setTasksOpen(true) : undefined,
        onOwner: write.allowed ? () => document.getElementById(ownerId)?.focus() : undefined,
        onCompose: () => compose.current?.start(),
        composeTitle: 'Email this person',
        prev: siblings?.prev,
        next: siblings?.next,
    });

    const personDeals = deals.items;
    const companyName = person.companyId ? (company.data?.name ?? '…') : null;

    const standard: PropertyRow[] = [
        {
            field: 'nameFirst',
            control: (
                <InlineText
                    label="First name"
                    path="nameFirst"
                    value={person.nameFirst || null}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ nameFirst: v ?? '' })}
                />
            ),
        },
        {
            field: 'nameLast',
            control: (
                <InlineText
                    label="Last name"
                    path="nameLast"
                    value={person.nameLast || null}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ nameLast: v ?? '' })}
                />
            ),
        },
        {
            field: 'emails',
            control: (
                <InlineText
                    label="Email"
                    path="emails.primary"
                    type="email"
                    value={person.emails.primary}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ emails: { ...person.emails, primary: v } })}
                />
            ),
        },
        {
            field: 'phones',
            control: (
                <InlineText
                    label="Phone"
                    path="phones.primary.number"
                    type="tel"
                    value={person.phones.primary ? `${person.phones.primary.number}` : null}
                    placeholder="digits only"
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) =>
                        save({
                            phones: {
                                ...person.phones,
                                primary: v
                                    ? {
                                          number: v.replace(/\D/g, ''),
                                          countryCode: person.phones.primary?.countryCode ?? 'US',
                                      }
                                    : null,
                            },
                        })
                    }
                />
            ),
        },
        {
            field: 'jobTitle',
            control: (
                <InlineText
                    label="Job title"
                    path="jobTitle"
                    value={person.jobTitle}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ jobTitle: v })}
                />
            ),
        },
        {
            field: 'city',
            control: (
                <InlineText
                    label="City"
                    path="city"
                    value={person.city}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ city: v })}
                />
            ),
        },
        {
            field: 'companyId',
            control: (
                <RecordPicker
                    workspaceId={workspaceId}
                    object="company"
                    label="Company"
                    value={person.companyId}
                    valueLabel={company.data?.name}
                    clearLabel="No company"
                    canEdit={write.allowed}
                    reason={write.reason}
                    onChange={(v) => save({ companyId: v })}
                />
            ),
        },
        {
            field: 'ownerId',
            control: (
                <OwnerControl
                    workspaceId={workspaceId}
                    value={person.ownerId}
                    onSave={(v) => save({ ownerId: v })}
                    id={ownerId}
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
                    value={person.links.linkedin?.url ?? null}
                    display={(v) => v.replace(/^https?:\/\/(www\.)?/, '')}
                    href={(v) => v}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ links: { ...person.links, linkedin: v ? { url: v, label: null } : null } })}
                />
            ),
        },
    ];

    const actions: RecordAction[] = [
        {
            id: 'enrol',
            label: 'Enrol in sequence',
            short: 'Enrol',
            icon: <Send aria-hidden />,
            // The person page's primary action once sequences exist (P2-UI-1 ruling, #140).
            primary: true,
            onSelect: () => setEnrolling(true),
            disabled: !enrol.allowed,
            reason: enrol.reason || undefined,
        },
        {
            id: 'email',
            label: 'Email',
            short: 'Email',
            icon: <Mail aria-hidden />,
            onSelect: () => compose.current?.start(),
            hint: 'Write an email (e)',
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
            onSelect: () => setTasksOpen(true),
            disabled: !write.allowed,
            reason: write.reason || undefined,
            hint: 'Add a task (t)',
        },
    ];

    return (
        <RecordLayout
            layout={layout}
            bar={<RecordActionBar name={personName(person)} actions={actions} siblings={siblings} />}
            header={
                <RecordHeader
                    layout={layout}
                    name={personName(person)}
                    avatarSrc={person.avatarUrl}
                    subtitle={
                        <>
                            {person.jobTitle}
                            {person.jobTitle && companyName ? ' at ' : ''}
                            {companyName && person.companyId && (
                                <Link
                                    to={paths.company(workspaceId, person.companyId)}
                                    className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-current"
                                >
                                    {companyName}
                                </Link>
                            )}
                            {(person.jobTitle || companyName) && person.emails.primary ? ' · ' : ''}
                            {person.emails.primary}
                        </>
                    }
                    status={!person.emails.primary ? <Badge status="warning">No email</Badge> : undefined}
                    back={{ to: paths.people(workspaceId), label: 'People' }}
                    siblings={siblings}
                    actions={<RecordHeaderActions actions={actions} />}
                />
            }
            facts={
                <FactGrid
                    facts={[
                        {
                            label: 'Owner',
                            value: person.ownerId ? (membersById.get(person.ownerId) ?? '…') : 'Unassigned',
                        },
                        { label: 'Source', value: sourceLabel(person.createdBy.kind) },
                        { label: 'Email', value: person.emails.primary ?? '—' },
                        { label: 'City', value: person.city ?? '—' },
                    ]}
                />
            }
            properties={
                <PropertiesColumn
                    workspaceId={workspaceId}
                    object="person"
                    custom={person.custom}
                    standard={standard}
                    audit={{
                        createdAt: person.createdAt,
                        updatedAt: person.updatedAt,
                        createdBy: sourceLabel(person.createdBy.kind),
                    }}
                    onSave={save}
                    canEdit={write.allowed}
                    reason={write.reason}
                />
            }
            rail={
                <>
                    <EnrichmentPanel workspaceId={workspaceId} object="person" recordId={person.id} />
                    <RailCard title="Company">
                        {person.companyId && companyName ? (
                            <RailRow
                                to={paths.company(workspaceId, person.companyId)}
                                title={companyName}
                                subtitle={company.data?.domain ?? undefined}
                            />
                        ) : (
                            <RailEmpty>Not linked to a company.</RailEmpty>
                        )}
                    </RailCard>
                    <RailCard title="Deals" count={deals.data && !deals.more ? personDeals.length : undefined}>
                        {deals.isPending ? (
                            <RailLoading />
                        ) : personDeals.length === 0 ? (
                            <RailEmpty>No deals with this person as the contact.</RailEmpty>
                        ) : (
                            personDeals.map((d) => (
                                <RailRow
                                    key={d.id}
                                    to={paths.deal(workspaceId, d.id)}
                                    title={d.name}
                                    subtitle={`${d.daysInStage}d in stage`}
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
                    <PersonEnrolments workspaceId={workspaceId} personId={person.id} />
                    <AttachmentsPanel workspaceId={workspaceId} target={target} />
                </>
            }
        >
            <RecordCompose
                workspaceId={workspaceId}
                person={{ id: person.id, name: personName(person), email: person.emails.primary }}
                handle={compose}
            />
            <TimelinePanel workspaceId={workspaceId} target={target} />
            {enrolling && (
                <EnrolDialog
                    workspaceId={workspaceId}
                    people={[{ id: person.id, name: personName(person), email: person.emails.primary }]}
                    onOpenChange={(open) => !open && setEnrolling(false)}
                    onDone={(result) => {
                        setEnrolling(false);
                        toast({ title: enrolSummary(result) });
                    }}
                />
            )}
        </RecordLayout>
    );
}

/** The one wording for how a record came to exist (PAR-003). */
export function sourceLabel(kind: PersonView['createdBy']['kind']): string {
    switch (kind) {
        case 'member':
            return 'Added by a member';
        case 'api_key':
            return 'Integration';
        case 'import':
            return 'Import';
        case 'sync':
            // Mail, calendar or Slotline: the person's `source` says which.
            return 'Sync';
        case 'system':
            return 'System';
    }
}
