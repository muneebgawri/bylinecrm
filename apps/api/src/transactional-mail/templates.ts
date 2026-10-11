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
