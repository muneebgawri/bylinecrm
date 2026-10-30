import { Badge, FactGrid, toast } from '@bylinecrm/ui';
import { CONTACT_STATUS_LABELS, CONTACT_STATUSES, type ContactStatus } from '@bylinecrm/shared';
import { Building2, Handshake, ListTodo, Mail, Send, StickyNote } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSetContactStatus } from '../../../api/customers';
import { usePatchRecord, useRecord } from '../../../api/records';
import type { PersonView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { RecordPicker } from '../../../components/RecordPicker';
import { useCompanyCreator } from '../../../components/useCompanyCreator';
import { formatDay } from '../../../lib/format';
import { paths } from '../../paths';
import { RecordCompose, type RecordComposeHandle } from '../mail/RecordCompose';
import { AskIntroduction } from './AskIntroduction';
import { AttachmentsPanel } from './AttachmentsPanel';
import { EnrichmentPanel } from './EnrichmentPanel';
import { InlineSelect, InlineText } from './InlineEdit';
import { NotesPanel } from './NotesPanel';
import { newswireosClientRow, OwnerControl, PropertiesColumn, type PropertyRow } from './PropertiesColumn';
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
    const setContactStatus = useSetContactStatus(workspaceId, person.id);
    const write = usePermission('record:write');
    const company = useRecord(workspaceId, 'company', person.companyId ?? '');
    const createCompany = useCompanyCreator(workspaceId, person.emails.primary);
    const deals = useRelated(workspaceId, 'opportunity', 'pointOfContactId', person.id);
    const [notesOpen, setNotesOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const enrol = useCan('sequence:enrol');
    const [enrolling, setEnrolling] = useState(false);
    const compose = useRef<RecordComposeHandle>(null);
    // GUARD-1: another member's lead is theirs to mail; anyone else asks them for an introduction.
    const membership = useMembership();
    const mayTransfer = useCan('record:transfer');
    const othersLead = !!person.ownerId && person.ownerId !== membership?.memberId && !mayTransfer;
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
            // The primary address, then the others: each edited in place, cleared to remove it, and one more to add.
            control: (
                <div className="flex flex-col gap-1">
                    <InlineText
                        label="Email"
                        path="emails.primary"
                        type="email"
                        value={person.emails.primary}
                        canEdit={write.allowed}
                        reason={write.reason}
                        onSave={(v) => save({ emails: { ...person.emails, primary: v } })}
                    />
                    {person.emails.additional.map((address, i) => (
                        <InlineText
                            key={address}
                            label={`Other email ${i + 1}`}
                            path={`emails.additional.${i}`}
                            type="email"
                            value={address}
                            canEdit={write.allowed}
                            reason={write.reason}
                            onSave={(v) =>
                                save({
                                    emails: {
                                        ...person.emails,
                                        additional: v
                                            ? person.emails.additional.map((a, j) => (j === i ? v : a))
                                            : person.emails.additional.filter((_, j) => j !== i),
                                    },
                                })
                            }
                        />
                    ))}
                    {write.allowed && person.emails.primary ? (
                        // Keyed by the count, so once an address is added the slot is empty again.
                        <InlineText
                            key={`add-${person.emails.additional.length}`}
                            label="Add email"
                            path={`emails.additional.${person.emails.additional.length}`}
                            type="email"
                            value={null}
                            placeholder="Add email"
                            canEdit
                            onSave={(v) =>
                                v
                                    ? save({
                                          emails: { ...person.emails, additional: [...person.emails.additional, v] },
                                      })
                                    : Promise.resolve()
                            }
                        />
                    ) : null}
                </div>
            ),
        },
        {
            field: 'phones',
            control: (
                <div className="flex items-start gap-2">
                    <InlineText
                        className="min-w-0 flex-1"
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
                                              ...person.phones.primary,
                                              number: v.replace(/\D/g, ''),
                                              countryCode: person.phones.primary?.countryCode ?? 'US',
                                          }
                                        : null,
                                },
                            })
                        }
                    />
                    <InlineText
                        className="w-28 shrink-0"
                        label="Ext."
                        path="phones.primary.extension"
                        type="tel"
                        display={(v) => `ext. ${v}`}
                        value={person.phones.primary?.extension ?? null}
                        placeholder="Ext."
                        canEdit={write.allowed && person.phones.primary !== null}
                        reason={write.allowed ? 'Add a phone number first.' : write.reason}
                        onSave={(v) => {
                            const primary = person.phones.primary;
                            if (!primary) return Promise.resolve();
                            const { extension: _, ...number } = primary;
                            const extension = v?.replace(/\D/g, '');
                            return save({
                                phones: { ...person.phones, primary: extension ? { ...number, extension } : number },
                            });
                        }}
                    />
                </div>
            ),
        },
        {
            field: 'contactStatus',
            control: (
                <InlineSelect
                    label="Contact status"
                    path="status"
                    value={person.contactStatus}
                    options={CONTACT_STATUSES.map((s) => ({
                        value: s,
                        label:
                            s === person.contactStatus && !person.contactStatusOverride && s !== 'do_not_contact'
                                ? `${CONTACT_STATUS_LABELS[s]} (automatic)`
                                : CONTACT_STATUS_LABELS[s],
                    }))}
                    clearLabel="Automatic"
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => setContactStatus.mutateAsync(v as ContactStatus | null)}
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
                    onCreate={createCompany}
                />
            ),
        },
        {
            field: 'ownerId',
            control: (
                <OwnerControl
                    workspaceId={workspaceId}
                    object="person"
                    recordId={person.id}
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
        ...newswireosClientRow(person.newswireosCustomerId),
    ];

    const actions: RecordAction[] = [
        // The person page's primary action once sequences exist (P2-UI-1 ruling, #140) — offered only to
        // a role that may enrol (#192): no sequences to use, no button.
        ...(enrol
            ? [
                  {
                      id: 'enrol',
                      label: 'Enrol in sequence',
                      short: 'Enrol',
                      icon: <Send aria-hidden />,
                      primary: true,
                      onSelect: () => setEnrolling(true),
                  } satisfies RecordAction,
              ]
            : []),
        {
            id: 'email',
            label: othersLead ? 'Ask for an introduction' : 'Email',
            short: othersLead ? 'Intro' : 'Email',
            icon: <Mail aria-hidden />,
            onSelect: () => compose.current?.start(),
            hint: othersLead ? 'Ask the owner to introduce you (e)' : 'Write an email (e)',
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
                        { label: 'Status', value: CONTACT_STATUS_LABELS[person.contactStatus] },
                        {
                            label: 'Last contacted',
                            value: person.lastContactedAt
                                ? `${formatDay(person.lastContactedAt.slice(0, 10))} · ${person.contactAttempts} sent`
                                : 'Not yet',
                        },
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
                    <RailCard title="Company" icon={<Building2 />}>
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
                    <RailCard
                        title="Deals"
                        icon={<Handshake />}
                        count={deals.data && !deals.more ? personDeals.length : undefined}
                    >
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
            {othersLead ? (
                <AskIntroduction
                    workspaceId={workspaceId}
                    personId={person.id}
                    personName={personName(person)}
                    ownerId={person.ownerId!}
                    ownerName={membersById.get(person.ownerId!) ?? 'their owner'}
                    requesterName={(membership?.memberId && membersById.get(membership.memberId)) || 'a colleague'}
                    handle={compose}
                />
            ) : (
                <RecordCompose
                    workspaceId={workspaceId}
                    person={{
                        id: person.id,
                        name: personName(person),
                        email: person.emails.primary,
                        source: person.source ?? null,
                    }}
                    handle={compose}
                />
            )}
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
