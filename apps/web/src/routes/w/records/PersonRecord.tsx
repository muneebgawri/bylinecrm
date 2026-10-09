import { Badge, Button, FactGrid, Tooltip, TooltipContent, TooltipTrigger } from '@bylinecrm/ui';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { usePatchRecord, useRecord, useRecordList } from '../../../api/queries';
import type { PersonView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { paths } from '../../paths';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ComposePlaceholder } from './ComposePlaceholder';
import { InlineSelect, InlineText } from './InlineEdit';
import { NotesPanel } from './NotesPanel';
import { OwnerControl, PropertiesColumn, type PropertyRow } from './PropertiesColumn';
import { RailCard, RailEmpty, RailRow } from './RailCard';
import { RecordHeader } from './RecordHeader';
import { RecordLayout } from './RecordLayout';
import { TasksPanel } from './TasksPanel';
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
    const companies = useRecordList(workspaceId, 'company', { limit: 200 }, write.allowed);
    const deals = useRecordList(workspaceId, 'opportunity', { limit: 200 });
    const [notesOpen, setNotesOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const ownerId = useId();
    const target = { type: 'person' as const, id: person.id };
    const save = (p: Record<string, unknown>) => patch.mutateAsync(p);

    useRecordCommands({
        recordId: person.id,
        onNote: write.allowed ? () => setNotesOpen(true) : undefined,
        onTask: write.allowed ? () => setTasksOpen(true) : undefined,
        onOwner: write.allowed ? () => document.getElementById(ownerId)?.focus() : undefined,
        onCompose: () => setNotice('Email from a record arrives with Phase 2 (connect a mailbox first).'),
        prev: siblings?.prev,
        next: siblings?.next,
    });

    const personDeals = (deals.data?.items ?? []).filter((d) => d.pointOfContactId === person.id);
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
                <InlineSelect
                    label="Company"
                    path="companyId"
                    value={person.companyId}
                    options={(companies.data?.items ?? (company.data ? [company.data] : [])).map((c) => ({
                        value: c.id,
                        label: c.name,
                    }))}
                    clearLabel="No company"
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ companyId: v })}
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
                    display={(v) => (
                        <a href={v} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            {v.replace(/^https?:\/\/(www\.)?/, '')}
                        </a>
                    )}
                    canEdit={write.allowed}
                    reason={write.reason}
                    onSave={(v) => save({ links: { ...person.links, linkedin: v ? { url: v, label: null } : null } })}
                />
            ),
        },
    ];

    return (
        <RecordLayout
            layout={layout}
            header={
                <RecordHeader
                    layout={layout}
                    name={personName(person)}
                    subtitle={
                        <>
                            {person.jobTitle}
                            {person.jobTitle && companyName ? ' at ' : ''}
                            {companyName && person.companyId && (
                                <Link
                                    to={paths.company(workspaceId, person.companyId)}
                                    className="text-text hover:underline"
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
                    actions={
                        <>
                            <Button
                                variant="secondary"
                                shape="square"
                                size="sm"
                                onClick={() => setNotesOpen(true)}
                                disabled={!write.allowed}
                                title={write.reason || 'Add a note (n)'}
                            >
                                Add note
                            </Button>
                            <Button
                                variant="secondary"
                                shape="square"
                                size="sm"
                                onClick={() => setTasksOpen(true)}
                                disabled={!write.allowed}
                                title={write.reason || 'Add a task (t)'}
                            >
                                Add task
                            </Button>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span tabIndex={0}>
                                        <Button
                                            variant="primary"
                                            shape="square"
                                            size="sm"
                                            disabled
                                            aria-disabled="true"
                                        >
                                            Enrol in sequence
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>Sequences arrive in Phase 3</TooltipContent>
                            </Tooltip>
                        </>
                    }
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
                    <RailCard title="Deals" count={deals.data ? personDeals.length : undefined}>
                        {personDeals.length === 0 ? (
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
                    <AttachmentsPanel workspaceId={workspaceId} target={target} />
                </>
            }
        >
            <ComposePlaceholder notice={notice} />
            <TimelinePanel workspaceId={workspaceId} target={target} />
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
            return 'Mail sync';
        case 'system':
            return 'System';
    }
}
