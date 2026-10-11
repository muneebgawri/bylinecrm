import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { ApiError } from '../../../api/client';
import type { MailboxView, SendMailInput } from '../../../api/types';
import { templateVariablePaths } from '../templates/preview';
import { docToSubject } from '../templates/subject';

/**
 * The record composer's rules (doc 50 §A, FR-CRMS-2/3), apart from its screen so each is stated
 * once and tested on its own.
 */

/**
 * The mailboxes a member may send 1:1 mail from: their own, personal, connected ones. A pool
 * mailbox is for sequences (Phase 3) and never offered here; another member's never is either —
 * the API refuses both (403), so offering them would only make a send fail.
 */
export function ownSendingMailboxes(
    mailboxes: readonly MailboxView[],
    memberId: string | null | undefined,
): MailboxView[] {
    return mailboxes.filter(
        (m) => m.purpose === 'personal' && m.status === 'connected' && !!memberId && m.ownerMemberId === memberId,
    );
}

/** Whether a rich-text document has nothing in it a reader would see. */
export function isBlank(doc: RichText): boolean {
    const visible = (nodes: readonly RichTextNode[] | undefined): boolean =>
        (nodes ?? []).some(
            (n) => (n.type === 'text' && (n.text ?? '').trim() !== '') || n.type === 'variable' || visible(n.content),
        );
    return !visible(doc.content);
}

/** The variables the draft uses that have no value for this person — what disables Send. */
export function emptyVariables(subject: RichText, body: RichText, missing: readonly string[]): string[] {
    if (missing.length === 0) return [];
    const unset = new Set(missing);
    return templateVariablePaths(docToSubject(subject), body).filter((path) => unset.has(path));
}

/** "custom.lastOutlet is empty" / "a and b are empty": the words under the composer. */
export function emptyVariablesText(paths: readonly string[], recipient: string): string {
    const list =
        paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths[paths.length - 1] ?? ''}`;
    return `${list} ${paths.length === 1 ? 'is' : 'are'} empty for ${recipient} · Send is disabled`;
}

/** A template as it was filled in, to tell whether the draft still IS that template. */
export interface TemplateFill {
    templateId: string;
    name: string;
    subject: RichText;
    body: RichText;
}

export interface Draft {
    mailboxId: string;
    personId: string;
    dealId?: string | undefined;
    /** People added beside the record's person; the person is always the first recipient. */
    alsoTo: readonly string[];
    subject: RichText;
    body: RichText;
    fill: TemplateFill | null;
    replyToMessageId?: string | undefined;
    sendAt?: Date | undefined;
    timeZone: string;
}

const same = (a: RichText, b: RichText) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the draft goes AS its template (`templateId`). The composer says so when it does not
 * ("edited — sends as written"), so an edit never changes what is sent without the person seeing it.
 */
export function sendsAsTemplate(draft: Pick<Draft, 'fill' | 'subject' | 'body' | 'replyToMessageId'>): boolean {
    return (
        draft.fill !== null &&
        draft.replyToMessageId === undefined &&
        same(draft.subject, draft.fill.subject) &&
        same(draft.body, draft.fill.body)
    );
}

/**
 * The request for a draft. A template left exactly as filled is sent AS the template
 * (`templateId`), so the send is attributed to it; once edited it is the written subject and body
 * (the API takes one or the other, never both). A reply is always written: with no subject of its
 * own it takes the parent's (`Re: …`) on the server, which a template's subject would replace.
 */
export function sendInput(draft: Draft): SendMailInput {
    const asTemplate = sendsAsTemplate(draft);
    const subject = docToSubject(draft.subject);
    return {
        mailboxId: draft.mailboxId,
        personId: draft.personId,
        ...(draft.dealId ? { dealId: draft.dealId } : {}),
        ...(draft.alsoTo.length
            ? { to: [{ personId: draft.personId }, ...draft.alsoTo.map((personId) => ({ personId }))] }
            : {}),
        ...(asTemplate && draft.fill
            ? { templateId: draft.fill.templateId }
            : { body: draft.body, ...(subject !== '' ? { subject } : {}) }),
        ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}),
        ...(draft.sendAt ? { sendAt: draft.sendAt.toISOString(), timeZone: draft.timeZone } : {}),
    };
}

/** The variables a refused send named as empty (`422 unprocessable`, one field error per path). */
export function refusedVariables(error: unknown): string[] {
    if (!(error instanceof ApiError) || error.status !== 422 || error.code !== 'unprocessable') return [];
    return error.fieldErrors.map((f) => f.path).filter((path) => path.includes('.'));
}
