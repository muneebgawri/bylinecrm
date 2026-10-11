import { TEMPLATE_NAME_MAX, type RichText, type TemplateKind } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    toast,
    useIsMobile,
} from '@bylinecrm/ui';
import { ArrowLeft, Lock, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useCreateTemplate,
    usePreviewTemplate,
    useTemplate,
    useTemplateVariables,
    useUpdateTemplate,
} from '../../../api/templates';
import { useMailSettings } from '../../../api/mailAdmin';
import type { EmailTemplateView, MailSettingsView } from '../../../api/types';
import { useCan, usePermission } from '../../../auth/capabilities';
import { useRegisterCommands } from '../../../commands/registry';
import { EmailFrame } from '../../../components/EmailFrame';
import { RecordPicker } from '../../../components/RecordPicker';
import { RichTextEditor, type RichTextHandle } from '../../../components/rich-text/RichTextEditor';
import { countryName } from '../../../lib/countries';
import { failureText } from '../../../lib/errors';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { KindMenu, OUTREACH_REASON } from './kind';
import { resolutionLine, templateVariablePaths } from './preview';
import { docToSubject, subjectToDoc } from './subject';
import { VariablePicker } from './VariablePicker';

/** The route segment, named once (an untyped `useParams` is a known trap). */
export const TEMPLATE_PARAM = 'templateId';

function useTemplateId(): string {
    const value = useParams()[TEMPLATE_PARAM];
    if (!value) throw new Error(`route has no :${TEMPLATE_PARAM} segment`);
    return value;
}

/** Shown on the disabled test-send until sending exists. */
export const SEND_TEST_REASON = 'Sending arrives with P2-3.';

/**
 * One template, edited (doc 50 §C; FR-CRMS-3): the subject and body with variable chips on the
 * left, the API's render against a real person on the right. On a phone the two become tabs.
 * Saving is explicit (button or ⌘/Ctrl-S) and names the version it edited, so a change someone
 * else saved first is never silently overwritten.
 */
export function TemplateEditorPage() {
    const workspaceId = useWorkspaceId();
    const templateId = useTemplateId();
    const template = useTemplate(workspaceId, templateId);
    // A reload after a conflict starts the editor again from what is stored now.
    const [generation, setGeneration] = useState(0);

    if (template.isError) {
        if (template.error instanceof ApiError && template.error.status === 404) {
            return (
                <div className="p-7 max-md:p-4">
                    <EmptyState
                        title="Template not found"
                        body="It may have been deleted, or the link is wrong."
                        action={
                            <Button asChild variant="secondary" shape="square">
                                <Link to={paths.templates(workspaceId)}>Back to templates</Link>
                            </Button>
                        }
                    />
                </div>
            );
        }
        throw template.error;
    }
    if (!template.data) return <EditorSkeleton />;
    return (
        <TemplateEditor
            key={`${template.data.id}:${generation}`}
            workspaceId={workspaceId}
            template={template.data}
            onReload={async () => {
                await template.refetch();
                setGeneration((g) => g + 1);
            }}
        />
    );
}

function EditorSkeleton() {
    return (
        <div className="flex flex-col gap-4 p-7 max-md:p-4" aria-busy="true" aria-label="Loading template">
            <Skeleton className="h-9 w-80" />
            <div className="grid gap-4 md:grid-cols-2">
                <Skeleton className="h-96" />
                <Skeleton className="h-96" />
            </div>
        </div>
    );
}

interface Draft {
    name: string;
    kind: TemplateKind;
    subject: RichText;
    body: RichText;
}

function draftFrom(template: EmailTemplateView): Draft {
    return {
        name: template.name,
        kind: template.kind,
        subject: subjectToDoc(template.subject),
        body: template.body as RichText,
    };
}

/** What a draft saves as: the subject back to `{{path}}` text. */
function toSaved(draft: Draft) {
    return { name: draft.name.trim(), kind: draft.kind, subject: docToSubject(draft.subject), body: draft.body };
}

function TemplateEditor({
    workspaceId,
    template,
    onReload,
}: {
    workspaceId: string;
    template: EmailTemplateView;
    onReload: () => Promise<void>;
}) {
    const navigate = useNavigate();
    const phone = useIsMobile();
    const write = usePermission('template:write');
    const outreachWrite = useCan('outreach:write');
    // An outreach template is changed only by a role that may write outreach (the API's rule too).
    const canEdit = write.allowed && (template.kind !== 'outreach' || outreachWrite);
    const editReason = !write.allowed ? write.reason : canEdit ? '' : OUTREACH_REASON;

    const [draft, setDraft] = useState<Draft>(() => draftFrom(template));
    const [saved, setSaved] = useState(() => JSON.stringify(toSaved(draftFrom(template))));
    const [version, setVersion] = useState(template.version);
    const [savedTemplate, setSavedTemplate] = useState(template);
    const dirty = JSON.stringify(toSaved(draft)) !== saved;
    const update = useUpdateTemplate(workspaceId, template.id);
    const copy = useCreateTemplate(workspaceId);
    const [conflict, setConflict] = useState(false);

    // Where "Insert variable" inserts: the field last focused, the body by default.
    const subjectRef = useRef<RichTextHandle>(null);
    const bodyRef = useRef<RichTextHandle>(null);
    const target = useRef<'subject' | 'body'>('body');
    const [pickerOpen, setPickerOpen] = useState(false);
    // Whether `{{` opened the picker (rather than its button): then a dismissal returns to the editor.
    const openedByTyping = useRef(false);
    const variables = useTemplateVariables(workspaceId);
    const insert = (path: string) =>
        (target.current === 'subject' ? subjectRef : bodyRef).current?.insertVariable(path);

    const [previewSeq, setPreviewSeq] = useState(0);
    const save = useCallback(() => {
        if (!canEdit || !dirty || update.isPending) return;
        const sent = toSaved(draft);
        update.mutate(
            { ...sent, version },
            {
                onSuccess: (result) => {
                    setSaved(JSON.stringify(sent));
                    setVersion(result.version);
                    setSavedTemplate(result);
                    setPreviewSeq((n) => n + 1);
                    toast({ title: 'Template saved' });
                },
                onError: (error) => {
                    if (error instanceof ApiError && error.status === 409) {
                        setConflict(true);
                        return;
                    }
                    if (!(error instanceof ApiError) || error.fieldErrors.length === 0) {
                        toast({
                            title: 'The template was not saved',
                            description: failureText(error),
                            tone: 'danger',
                        });
                    }
                },
            },
        );
    }, [canEdit, dirty, draft, update, version]);

    // The shortcut runs the latest save without re-registering the command on every keystroke.
    const saveRef = useRef(save);
    useEffect(() => {
        saveRef.current = save;
    }, [save]);
    useRegisterCommands(
        [
            {
                id: 'template.save',
                title: 'Save template',
                group: 'Template',
                shortcut: 'mod+s',
                when: () => canEdit,
                run: () => saveRef.current(),
            },
        ],
        [canEdit],
    );

    // Unsaved work is not lost to a click elsewhere in the app, a reload or a closed tab.
    const blocker = useBlocker(
        ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
    );
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    const saveAsCopy = () =>
        copy.mutate(
            { ...toSaved(draft), name: `${draft.name.trim()} (copy)`.slice(0, TEMPLATE_NAME_MAX) },
            {
                onSuccess: (created) => {
                    setConflict(false);
                    setSaved(JSON.stringify(toSaved(draft)));
                    navigate(paths.template(workspaceId, created.id));
                },
                onError: (error) =>
                    toast({
                        title: 'The copy was not saved',
                        description: failureText(error),
                        tone: 'danger',
                    }),
            },
        );

    const editPane = (
        <EditPane
            draft={draft}
            setDraft={setDraft}
            readOnly={!canEdit}
            subjectRef={subjectRef}
            bodyRef={bodyRef}
            onFocus={(field) => (target.current = field)}
            onTrigger={(field) => {
                target.current = field;
                openedByTyping.current = true;
                setPickerOpen(true);
            }}
            picker={
                <VariablePicker
                    variables={variables.data}
                    open={pickerOpen}
                    onOpenChange={(next) => {
                        // Only the button opens it through here; `{{` opens it directly.
                        if (next) openedByTyping.current = false;
                        setPickerOpen(next);
                    }}
                    onPick={insert}
                    restoreFocus={() => {
                        if (!openedByTyping.current) return false;
                        (target.current === 'subject' ? subjectRef : bodyRef).current?.focus();
                        return true;
                    }}
                    disabled={!canEdit}
                />
            }
            workspaceId={workspaceId}
            nameError={fieldErrorAt(update.error, 'name')}
            subjectError={fieldErrorAt(update.error, 'subject')}
            bodyError={update.error instanceof ApiError ? bodyErrorText(update.error) : undefined}
        />
    );
    const previewPane = (
        <PreviewPane workspaceId={workspaceId} template={savedTemplate} dirty={dirty} refreshSeq={previewSeq} />
    );

    return (
        <div className="flex min-h-full flex-col gap-4 p-7 max-md:p-4">
            <header className="flex flex-wrap items-center gap-3">
                <Button asChild variant="ghost" size="sm" shape="square" aria-label="Back to templates">
                    <Link to={paths.templates(workspaceId)}>
                        <ArrowLeft aria-hidden />
                        <span className="max-md:sr-only">Templates</span>
                    </Link>
                </Button>
                <h1 className="m-0 min-w-0 flex-1 truncate text-xl font-semibold tracking-tight">
                    {draft.name.trim() || 'Untitled template'}
                </h1>
                <KindMenu
                    value={draft.kind}
                    onChange={(kind) => setDraft((d) => ({ ...d, kind }))}
                    outreachAllowed={outreachWrite}
                    disabled={!canEdit}
                />
                <span aria-live="polite" className="text-[13px] text-text-muted">
                    {update.isPending ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
                </span>
                {canEdit ? (
                    <Button
                        data-primary-action
                        variant="primary"
                        shape="square"
                        size="sm"
                        loading={update.isPending}
                        disabled={!dirty}
                        onClick={save}
                    >
                        Save
                    </Button>
                ) : (
                    <span className="text-[13px] text-text-muted">{editReason}</span>
                )}
            </header>

            {phone ? (
                <Tabs defaultValue="edit" className="flex flex-col gap-3">
                    <TabsList aria-label="Template" className="self-start">
                        <TabsTrigger value="edit">Edit</TabsTrigger>
                        <TabsTrigger value="preview">Preview</TabsTrigger>
                    </TabsList>
                    <TabsContent value="edit">{editPane}</TabsContent>
                    <TabsContent value="preview">{previewPane}</TabsContent>
                </Tabs>
            ) : (
                <div className="grid flex-1 grid-cols-2 items-start gap-4">
                    {editPane}
                    {previewPane}
                </div>
            )}

            <Dialog open={conflict} onOpenChange={setConflict}>
                <DialogContent>
                    <DialogTitle>Changed by someone else</DialogTitle>
                    <DialogDescription>
                        This template was saved by someone else after you opened it. Reload to see their version (your
                        changes here are discarded), or save yours as a copy.
                    </DialogDescription>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            shape="square"
                            onClick={() => {
                                setConflict(false);
                                setSaved(JSON.stringify(toSaved(draft)));
                                void onReload();
                            }}
                        >
                            Reload
                        </Button>
                        <Button variant="primary" shape="square" loading={copy.isPending} onClick={saveAsCopy}>
                            Save as copy
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={blocker.state === 'blocked'} onOpenChange={(open) => !open && blocker.reset?.()}>
                <DialogContent>
                    <DialogTitle>Leave without saving?</DialogTitle>
                    <DialogDescription>Your changes to this template have not been saved.</DialogDescription>
                    <DialogFooter>
                        <Button variant="ghost" shape="square" onClick={() => blocker.reset?.()}>
                            Stay
                        </Button>
                        <Button variant="danger" shape="square" onClick={() => blocker.proceed?.()}>
                            Leave
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/** A body field error names its path in the document (`body.content.1…`); show the first. */
function bodyErrorText(error: ApiError): string | undefined {
    return error.fieldErrors.find((f) => f.path === 'body' || f.path.startsWith('body.'))?.message;
}

function EditPane({
    draft,
    setDraft,
    readOnly,
    subjectRef,
    bodyRef,
    onFocus,
    onTrigger,
    picker,
    workspaceId,
    nameError,
    subjectError,
    bodyError,
}: {
    draft: Draft;
    setDraft: React.Dispatch<React.SetStateAction<Draft>>;
    readOnly: boolean;
    subjectRef: React.RefObject<RichTextHandle | null>;
    bodyRef: React.RefObject<RichTextHandle | null>;
    onFocus: (field: 'subject' | 'body') => void;
    onTrigger: (field: 'subject' | 'body') => void;
    picker: React.ReactNode;
    workspaceId: string;
    nameError: string | undefined;
    subjectError: string | undefined;
    bodyError: string | undefined;
}) {
    return (
        <section aria-label="Edit" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
            <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Name</span>
                <Input
                    value={draft.name}
                    maxLength={TEMPLATE_NAME_MAX}
                    readOnly={readOnly}
                    aria-invalid={nameError ? true : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
                {nameError && (
                    <span role="alert" className="text-xs text-danger">
                        {nameError}
                    </span>
                )}
            </label>
            <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span id="template-subject-label" className="text-[13px] font-medium">
                        Subject
                    </span>
                    {picker}
                </div>
                <RichTextEditor
                    profile="subject"
                    aria-label="Subject"
                    value={draft.subject}
                    onChange={(subject) => setDraft((d) => ({ ...d, subject }))}
                    onFocus={() => onFocus('subject')}
                    onVariableTrigger={() => onTrigger('subject')}
                    handle={subjectRef}
                    readOnly={readOnly}
                    placeholder="Quick one for {{ to insert a variable"
                />
                {subjectError && (
                    <span role="alert" className="text-xs text-danger">
                        {subjectError}
                    </span>
                )}
            </div>
            <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Body</span>
                <RichTextEditor
                    profile="template"
                    aria-label="Body"
                    value={draft.body}
                    onChange={(body) => setDraft((d) => ({ ...d, body }))}
                    onFocus={() => onFocus('body')}
                    onVariableTrigger={() => onTrigger('body')}
                    handle={bodyRef}
                    readOnly={readOnly}
                    placeholder="Write the email. Type {{ to insert a variable."
                />
                {bodyError && (
                    <span role="alert" className="text-xs text-danger">
                        {bodyError}
                    </span>
                )}
                <p className="m-0 text-xs text-text-muted">
                    Variables are filled in for each person. One with no value stops the email; it is never sent blank.
                </p>
            </div>
            {draft.kind === 'outreach' && <LockedFooter workspaceId={workspaceId} />}
        </section>
    );
}

/** The footer every outreach email carries; it is not part of the body, so no edit can remove it. */
function LockedFooter({ workspaceId }: { workspaceId: string }) {
    const settings = useMailSettings(workspaceId);
    const address = settings.data?.postalAddress ?? null;
    return (
        <div className="flex flex-col gap-2" aria-label="Locked footer">
            <LockedBlock title="Unsubscribe link">
                {settings.data?.unsubscribeFooterText ?? 'The workspace’s unsubscribe notice'} · Unsubscribe
            </LockedBlock>
            <LockedBlock title="Postal address" warning={settings.isSuccess && !address}>
                {settings.isSuccess ? (address ? formatAddress(address) : 'Not set — this email cannot be sent.') : '…'}
            </LockedBlock>
            <p className="m-0 text-xs text-text-muted">
                Required on outreach templates.{' '}
                <Link to={paths.settingsMail(workspaceId)} className="text-accent underline underline-offset-2">
                    Edit them in Mail settings
                </Link>
                .
            </p>
        </div>
    );
}

function LockedBlock({ title, warning, children }: { title: string; warning?: boolean; children: React.ReactNode }) {
    return (
        <div
            className={cn(
                'flex items-start gap-2 rounded-md border border-dashed border-border bg-surface-raised px-3 py-2 text-[13px]',
                warning && 'border-warning bg-warning-soft',
            )}
        >
            <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
            <span>
                <span className="block font-medium">{title}</span>
                <span className={cn('block text-text-muted', warning && 'text-warning')}>{children}</span>
            </span>
        </div>
    );
}

function formatAddress(address: NonNullable<MailSettingsView['postalAddress']>): string {
    return [
        address.line1,
        address.line2,
        address.city,
        address.region,
        address.postalCode,
        countryName(address.country),
    ]
        .filter(Boolean)
        .join(', ');
}

function PreviewPane({
    workspaceId,
    template,
    dirty,
    refreshSeq,
}: {
    workspaceId: string;
    template: EmailTemplateView;
    dirty: boolean;
    refreshSeq: number;
}) {
    const [personId, setPersonId] = useState<string | null>(null);
    const [personName, setPersonName] = useState<string | null>(null);
    const [dealId, setDealId] = useState<string | null>(null);
    const [dealName, setDealName] = useState<string | null>(null);
    const preview = usePreviewTemplate(workspaceId, template.id);
    const { mutate } = preview;
    const variableCount = useMemo(
        () => templateVariablePaths(template.subject, template.body as RichText).length,
        [template.subject, template.body],
    );

    useEffect(() => {
        if (personId) mutate({ personId, dealId: dealId ?? undefined });
    }, [personId, dealId, refreshSeq, mutate]);

    const rendered = preview.data;
    const line = rendered && personName ? resolutionLine(rendered, variableCount, personName) : null;
    const failure =
        preview.error instanceof ApiError
            ? preview.error.status === 404
                ? 'That person or deal is not one you can see.'
                : preview.error.message
            : preview.isError
              ? 'The preview could not be loaded.'
              : null;

    return (
        <section aria-label="Preview" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                    <span className="text-[13px] font-medium">Preview as</span>
                    <RecordPicker
                        workspaceId={workspaceId}
                        object="person"
                        label="Preview as"
                        value={personId}
                        valueLabel={personName}
                        onChange={(id) => setPersonId(id)}
                        onResolved={(_id, title) => setPersonName(title)}
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-[13px] font-medium">Deal (optional)</span>
                    <RecordPicker
                        workspaceId={workspaceId}
                        object="opportunity"
                        label="Deal"
                        clearLabel="No deal"
                        value={dealId}
                        valueLabel={dealName}
                        onChange={(id) => {
                            setDealId(id);
                            if (!id) setDealName(null);
                        }}
                        onResolved={(_id, title) => setDealName(title)}
                    />
                </div>
            </div>
            {dirty && (
                <p className="m-0 rounded-md bg-info-soft px-3 py-2 text-[13px] text-info">
                    The preview shows the saved version. Save to see your changes.
                </p>
            )}
            {!personId ? (
                <EmptyState
                    className="py-10"
                    title="Choose a person to preview"
                    body="The email is rendered for a real person, exactly as they would receive it."
                />
            ) : failure ? (
                <EmptyState tone="error" className="py-10" title="No preview" body={failure} />
            ) : !rendered || preview.isPending ? (
                <div aria-busy="true" aria-label="Rendering preview" className="flex flex-col gap-2">
                    <Skeleton className="h-6 w-2/3" />
                    <Skeleton className="h-64" />
                </div>
            ) : (
                <>
                    <div className="flex items-start gap-2">
                        <p className="m-0 min-w-0 flex-1 text-sm">
                            <span className="text-text-muted">Subject: </span>
                            <span className="font-medium">{rendered.subject || '(no subject)'}</span>
                        </p>
                        <Button
                            variant="ghost"
                            size="xs"
                            shape="square"
                            aria-label="Refresh preview"
                            onClick={() => mutate({ personId, dealId: dealId ?? undefined })}
                        >
                            <RefreshCw aria-hidden />
                        </Button>
                    </div>
                    <EmailFrame
                        html={rendered.html}
                        title={`Email preview for ${personName ?? 'the chosen person'}`}
                        className="h-96 max-md:h-[55vh]"
                    />
                    {line && (
                        <p
                            role="status"
                            className={cn('m-0 text-[13px]', line.tone === 'success' ? 'text-success' : 'text-warning')}
                        >
                            {line.tone === 'success' ? '✓ ' : '⚠ '}
                            {line.text}
                        </p>
                    )}
                </>
            )}
            <div className="flex justify-end">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span tabIndex={0} className="inline-flex">
                            <Button variant="secondary" shape="square" size="sm" disabled>
                                Send test to me
                            </Button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {rendered && !rendered.sendable
                            ? 'Fill every variable first. ' + SEND_TEST_REASON
                            : SEND_TEST_REASON}
                    </TooltipContent>
                </Tooltip>
            </div>
        </section>
    );
}
