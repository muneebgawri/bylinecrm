import { STAGE_RULE_EVENTS, type StageRuleEvent } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenuItem,
    RowActionsMenu,
    type TableRowActions,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { useCreateRule, useRemoveRule, useUpdateRule } from '../../../api/settings';
import type { RuleView, StageView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { SelectField, SwitchRow } from './fields';
import { StageSwatch } from './StageEditor';
import { RULE_EVENT_LABEL, ruleSummary } from './settingsText';

const EVENT_OPTIONS = STAGE_RULE_EVENTS.map((event) => ({ value: event, label: RULE_EVENT_LABEL[event] }));

/**
 * A pipeline's stage rules (FR-CRMS-9), each as the sentence it is — "When a reply arrives, move
 * the deal to Replied". A rule only moves a deal forward unless it is allowed to go back.
 */
export function RulesSection({
    workspaceId,
    pipelineId,
    rules,
    stages,
    canConfigure,
}: {
    workspaceId: string;
    pipelineId: string;
    rules: readonly RuleView[];
    stages: readonly StageView[];
    canConfigure: boolean;
}) {
    const update = useUpdateRule(workspaceId, pipelineId);
    const remove = useRemoveRule(workspaceId, pipelineId);
    const [editing, setEditing] = useState<RuleView | 'new' | null>(null);
    const [deleting, setDeleting] = useState<RuleView | null>(null);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const sentence = (rule: RuleView) =>
        ruleSummary(rule.event, stageById.get(rule.toStageId)?.name ?? 'a removed stage', rule.allowBackward);

    const actions: TableRowActions<RuleView> = {
        label: (rule) => sentence(rule),
        items: (rule) => (
            <>
                <DropdownMenuItem onSelect={() => setEditing(rule)}>Edit</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => update.mutate({ ruleId: rule.id, enabled: !rule.enabled })}>
                    {rule.enabled ? 'Turn off' : 'Turn on'}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setDeleting(rule)}>
                    Delete
                </DropdownMenuItem>
            </>
        ),
    };

    return (
        <section aria-labelledby="rules-heading" className="rounded-lg border border-border bg-surface">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <div className="grid gap-0.5">
                    <h3 id="rules-heading" className="m-0 text-sm font-semibold">
                        Stage rules
                    </h3>
                    <p className="m-0 text-xs text-text-muted">
                        They act on replies and booked meetings once mailboxes and meetings are connected.
                    </p>
                </div>
                {canConfigure && (
                    <Button className="ml-auto" shape="square" size="sm" onClick={() => setEditing('new')}>
                        Add rule
                    </Button>
                )}
            </header>
            {rules.length === 0 ? (
                <p className="m-0 px-4 py-6 text-sm text-text-muted">
                    No rules: deals move only when someone moves them.
                </p>
            ) : (
                <ul aria-label="Rules" className="m-0 list-none p-0">
                    {rules.map((rule) => (
                        <li
                            key={rule.id}
                            className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 max-md:min-h-touch"
                        >
                            <span className={rule.enabled ? 'flex-1 text-sm' : 'flex-1 text-sm text-text-muted'}>
                                {sentence(rule)}
                            </span>
                            {!rule.enabled && <Badge shape="pill">Off</Badge>}
                            {canConfigure && <RowActionsMenu actions={actions} row={rule} />}
                        </li>
                    ))}
                </ul>
            )}
            {editing !== null && (
                <RuleEditor
                    workspaceId={workspaceId}
                    pipelineId={pipelineId}
                    rule={editing === 'new' ? null : editing}
                    stages={stages}
                    onClose={() => setEditing(null)}
                />
            )}
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleting(null);
                        remove.reset();
                    }
                }}
                title="Delete this rule?"
                body={deleting ? sentence(deleting) : ''}
                confirm="Delete rule"
                pending={remove.isPending}
                error={remove.error ? failureText(remove.error) : undefined}
                onConfirm={() => deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
            />
        </section>
    );
}

function RuleEditor({
    workspaceId,
    pipelineId,
    rule,
    stages,
    onClose,
}: {
    workspaceId: string;
    pipelineId: string;
    rule: RuleView | null;
    stages: readonly StageView[];
    onClose: () => void;
}) {
    const create = useCreateRule(workspaceId, pipelineId);
    const update = useUpdateRule(workspaceId, pipelineId);
    const [event, setEvent] = useState<StageRuleEvent | undefined>(rule?.event);
    const [toStageId, setToStageId] = useState<string | undefined>(rule?.toStageId);
    const [allowBackward, setAllowBackward] = useState(rule?.allowBackward ?? false);
    const [enabled, setEnabled] = useState(rule?.enabled ?? true);
    const target = stages.find((s) => s.id === toStageId);
    const mutation = rule ? update : create;
    const stageOptions = [...stages]
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ value: s.id, label: s.name, leading: <StageSwatch colour={s.colour} /> }));

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!event || !toStageId) return;
        if (rule) update.mutate({ ruleId: rule.id, toStageId, allowBackward, enabled }, { onSuccess: onClose });
        else create.mutate({ event, toStageId, allowBackward, enabled }, { onSuccess: onClose });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>{rule ? 'Edit rule' : 'Add rule'}</DialogTitle>
                <DialogDescription>Move a deal automatically when something happens to its contact.</DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="grid gap-4">
                        {rule ? (
                            <p className="m-0 text-sm">
                                <span className="text-text-muted">When </span>
                                {RULE_EVENT_LABEL[rule.event].toLowerCase()}
                            </p>
                        ) : (
                            <SelectField label="When" value={event} onValueChange={setEvent} options={EVENT_OPTIONS} />
                        )}
                        <SelectField
                            label="Move the deal to"
                            value={toStageId}
                            onValueChange={setToStageId}
                            options={stageOptions}
                        />
                        <SwitchRow
                            label="Also move it back"
                            hint="Off: a deal already further along stays where it is."
                            checked={allowBackward}
                            onCheckedChange={setAllowBackward}
                        />
                        <SwitchRow label="On" checked={enabled} onCheckedChange={setEnabled} />
                        {event && target && (
                            <p className="m-0 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
                                {ruleSummary(event, target.name, allowBackward)}
                            </p>
                        )}
                        {mutation.error && (
                            <p role="alert" className="m-0 text-sm text-danger">
                                {failureText(mutation.error)}
                            </p>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={mutation.isPending}
                            disabled={!event || !toStageId}
                        >
                            Save rule
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
