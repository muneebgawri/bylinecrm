import { EMAIL_VERIFICATION_TTL_S, INVITE_TTL_S, PASSWORD_RESET_TTL_S } from '../auth/auth.constants';

/** A rendered message without its envelope. */
export interface RenderedMail {
    subject: string;
    html: string;
    text: string;
}

/** The product name every transactional mail carries; never a workspace's branding (#93). */
const PRODUCT = 'BylineCRM';

/** Escapes text for HTML: every interpolated value goes through this. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** "24 hours", "30 minutes", "7 days": how long a link works, in words. */
function lifetime(seconds: number): string {
    if (seconds % 86_400 === 0) return seconds === 86_400 ? '24 hours' : `${seconds / 86_400} days`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600} hours`;
    return `${Math.round(seconds / 60)} minutes`;
}

/**
 * One layout for every message: a single column, real text, the action as a button-styled link and
 * again as a plain URL for clients that strip links. No images, no tracking pixel, no redirect — the
 * link is the app's own URL. `role="presentation"` keeps screen readers out of the layout table.
 */
function layout(input: { heading: string; paragraphs: string[]; action: string; url: string; footer: string }): string {
    const url = escapeHtml(input.url);
    const paragraphs = input.paragraphs
        .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2328">${escapeHtml(p)}</p>`)
        .join('');
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.heading)}</title></head>
<body style="margin:0;padding:0;background:#f6f8fa">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f8fa">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #d0d7de;border-radius:8px">
<tr><td style="padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#57606a">${PRODUCT}</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:30px;color:#1f2328">${escapeHtml(input.heading)}</h1>
${paragraphs}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:12px 20px;border-radius:6px">${escapeHtml(input.action)}</a></p>
<p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#57606a">Or paste this address into your browser:</p>
<p style="margin:0 0 24px;font-size:14px;line-height:20px;word-break:break-all;color:#0550ae">${url}</p>
<p style="margin:0;font-size:13px;line-height:20px;color:#57606a">${escapeHtml(input.footer)}</p>
</td></tr></table>
</td></tr></table>
</body>
</html>`;
}

function text(input: { heading: string; paragraphs: string[]; action: string; url: string; footer: string }): string {
    return [
        PRODUCT,
        '',
        input.heading,
        '',
        ...input.paragraphs.flatMap((p) => [p, '']),
        `${input.action}:`,
        input.url,
        '',
        input.footer,
        '',
    ].join('\n');
}

function render(subject: string, body: Parameters<typeof layout>[0]): RenderedMail {
    return { subject, html: layout(body), text: text(body) };
}

export function verificationMail(url: string): RenderedMail {
    return render(`Verify your email for ${PRODUCT}`, {
        heading: 'Verify your email address',
        paragraphs: [`Confirm this is your address to start using ${PRODUCT}.`],
        action: 'Verify email address',
        url,
        footer: `This link works once and expires in ${lifetime(EMAIL_VERIFICATION_TTL_S)}. If you did not create an account, ignore this message.`,
    });
}

export function passwordResetMail(url: string): RenderedMail {
    return render(`Reset your ${PRODUCT} password`, {
        heading: 'Reset your password',
        paragraphs: [
            'Someone asked to reset the password for this address. Choose a new password with the link below.',
            'Resetting signs you out everywhere else.',
        ],
        action: 'Choose a new password',
        url,
        footer: `This link works once and expires in ${lifetime(PASSWORD_RESET_TTL_S)}. If you did not ask for this, ignore this message; your password stays as it is.`,
    });
}

/** A workspace invitation; `owner` is the one a platform admin sends with a new workspace. */
export function workspaceInvitationMail(input: { url: string; workspaceName: string; owner: boolean }): RenderedMail {
    const name = input.workspaceName;
    return render(input.owner ? `Set up ${name} on ${PRODUCT}` : `You're invited to ${name} on ${PRODUCT}`, {
        heading: input.owner ? `Your workspace ${name} is ready` : `Join ${name}`,
        paragraphs: input.owner
            ? [`A workspace named ${name} was created for you on ${PRODUCT}. Accept to become its administrator.`]
            : [`You have been invited to the ${name} workspace on ${PRODUCT}.`],
        action: 'Accept invitation',
        url: input.url,
        footer: `This invitation expires in ${lifetime(INVITE_TTL_S)}. If you were not expecting it, ignore this message.`,
    });
}

export function signupInvitationMail(url: string): RenderedMail {
    return render(`You're invited to create a workspace on ${PRODUCT}`, {
        heading: `Create your ${PRODUCT} workspace`,
        paragraphs: [`You have been invited to sign up for ${PRODUCT} and create a workspace of your own.`],
        action: 'Create your account',
        url,
        footer: `This invitation works once and expires in ${lifetime(INVITE_TTL_S)}. If you were not expecting it, ignore this message.`,
    });
}

/** The workspace's automatic Twenty sync has failed several times in a row (#185): told to each admin, once per streak. */
export function twentySyncFailingMail(input: {
    workspaceName: string;
    failures: number;
    error: string;
    url: string;
}): RenderedMail {
    return importSyncFailingMail('Twenty', input);
}

/** The same notice for the automatic Bigin sync (BIGIN-1). */
export function biginSyncFailingMail(input: {
    workspaceName: string;
    failures: number;
    error: string;
    url: string;
}): RenderedMail {
    return importSyncFailingMail('Bigin', input);
}

function importSyncFailingMail(
    source: 'Twenty' | 'Bigin',
    input: { workspaceName: string; failures: number; error: string; url: string },
): RenderedMail {
    const name = input.workspaceName;
    return render(`Automatic ${source} sync is failing in ${name}`, {
        heading: `${source} sync has failed ${input.failures} times in a row`,
        paragraphs: [
            `${PRODUCT} could not sync ${name} from ${source}. The last run said: ${input.error}`,
            `The schedule keeps trying, less often each time, until a run succeeds. Check the ${source} connection and the last runs on the import screen.`,
        ],
        action: 'Open the import screen',
        url: input.url,
        footer: `You receive this because you are an admin of ${name} on ${PRODUCT}.`,
    });
}

/**
 * GUARD-2: a `high` poaching alert, at once, to the lead's owner and every reviewer. Who, whom, when and the
 * subject only — never the message's body.
 */
export function guardrailAlertMail(input: { workspaceName: string; message: string; url: string }): RenderedMail {
    return render(`Guardrail alert in ${input.workspaceName}`, {
        heading: 'A member mailed another member’s lead',
        paragraphs: [input.message],
        action: 'Open Guardrails',
        url: input.url,
        footer: `You receive this because you own the lead or review guardrails in ${input.workspaceName} on ${PRODUCT}.`,
    });
}

/**
 * PNW-1194: the Google project's Gmail spend for the day has passed the alert level — to each platform admin, once
 * that day. Google bills a project's use above `billedAbove` units a day.
 */
export function gmailUsageHighMail(input: { day: string; units: number; billedAbove: number }): RenderedMail {
    const n = (v: number) => v.toLocaleString('en-US');
    return render(`Gmail use on ${input.day} has passed half of Google’s billing line`, {
        heading: `${PRODUCT} has spent ${n(input.units)} Gmail units today`,
        paragraphs: [
            `On ${input.day} (Google’s quota day, Pacific time) ${PRODUCT} has spent ${n(input.units)} Gmail API units. Google bills a project’s Gmail use above ${n(input.billedAbove)} units a day.`,
            'A large first import or a run that keeps retrying is the usual cause. Check mail sync’s recent runs and the Gmail API metrics in the Google Cloud console.',
        ],
        action: 'Open the Gmail API quotas',
        url: 'https://console.cloud.google.com/apis/api/gmail.googleapis.com/quotas',
        footer: `You receive this because you are a platform admin of ${PRODUCT}. It is sent at most once a day.`,
    });
}

/** One task as a digest lists it: its title, what it is about, and when it was due. */
interface DigestTask {
    title: string;
    about: string[];
    due: string;
}

/**
 * A member's morning digest (#192): their tasks overdue and due today, in one message, so a
 * sequence's "Call if no reply" is not left waiting on a record nobody opened.
 */
export function taskDigestMail(input: {
    workspaceName: string;
    overdue: DigestTask[];
    today: DigestTask[];
    /** GUARD-2: guardrail alerts of the last day, as their events say them (who, whom, when, subject). */
    alerts?: string[];
    url: string;
}): RenderedMail {
    const alerts = input.alerts ?? [];
    const line = (t: DigestTask) => `• ${t.title}${t.about.length > 0 ? ` (${t.about.join(', ')})` : ''}, due ${t.due}`;
    const count = input.overdue.length + input.today.length;
    const subject =
        count > 0
            ? `${count} ${count === 1 ? 'task' : 'tasks'} due in ${input.workspaceName}`
            : `${alerts.length} guardrail ${alerts.length === 1 ? 'alert' : 'alerts'} in ${input.workspaceName}`;
    return render(subject, {
        heading: count > 0 ? 'Your tasks for today' : 'Guardrail alerts',
        paragraphs: [
            ...(alerts.length > 0 ? [`Guardrail alerts: ${alerts.length}`, ...alerts.map((a) => `• ${a}`)] : []),
            ...(input.overdue.length > 0 ? [`Overdue: ${input.overdue.length}`, ...input.overdue.map(line)] : []),
            ...(input.today.length > 0 ? [`Due today: ${input.today.length}`, ...input.today.map(line)] : []),
        ],
        action: 'Open my tasks',
        url: input.url,
        footer: `You receive this because tasks in ${input.workspaceName} on ${PRODUCT} are assigned to you. Turn it off under Notifications (the bell) in ${PRODUCT}.`,
    });
}
