import {
    MISSING_POSTAL_ADDRESS,
    TEMPLATE_SUBJECT_TOKEN,
    UNSUBSCRIBE_LINK_LABEL,
    UNSUBSCRIBE_URL_PLACEHOLDER,
    type EmailTemplateBody,
    type MailSettings,
    type PostalAddress,
} from '@bylinecrm/shared';
import { escapeHtml, missingMarker, renderBody, type VariableResolver } from './serializer';

/**
 * A whole email from a template (P2-4): subject, body and — for an outreach template — the locked
 * footer. Pure: the caller loads what the variables read; this decides what the email says.
 *
 * The footer is not part of the stored body, so no edit can remove it: it is appended here, on
 * every render of an outreach template, from the workspace's mail settings — the unsubscribe link
 * (FR-CRMS-7; its URL is `UNSUBSCRIBE_URL_PLACEHOLDER` until the send path resolves it per
 * recipient) and the postal address (FR-CRMS-12). With no postal address set, the render names
 * `workspace.postal_address` as missing and is not sendable.
 */

export interface ComposedEmail {
    subject: string;
    html: string;
    text: string;
    missing: string[];
    sendable: boolean;
}

/** The subject with its `{{tokens}}` filled; a missing one stays as its token and is named. */
export function renderSubject(subject: string, resolve: VariableResolver): { subject: string; missing: string[] } {
    const missing: string[] = [];
    const out = subject.replace(TEMPLATE_SUBJECT_TOKEN, (token, path: string) => {
        const value = resolve(path);
        if (value !== null) return value;
        missing.push(path);
        return `{{${path}}}`;
    });
    return { subject: out, missing };
}

/** One line of a postal address, as it reads at the foot of an email. */
export function formatPostalAddress(address: PostalAddress): string {
    return [address.line1, address.line2, address.city, address.region, address.postalCode, address.country]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join(', ');
}

function outreachFooter(settings: MailSettings): { html: string; text: string; missing: string[] } {
    const notice = settings.unsubscribeFooterText;
    const address = settings.postalAddress ? formatPostalAddress(settings.postalAddress) : null;
    const html =
        '<hr>' +
        `<p>${escapeHtml(notice)} <a href="${escapeHtml(UNSUBSCRIBE_URL_PLACEHOLDER)}">${escapeHtml(UNSUBSCRIBE_LINK_LABEL)}</a></p>` +
        `<p>${address === null ? missingMarker(MISSING_POSTAL_ADDRESS) : escapeHtml(address)}</p>`;
    const text = [
        '--',
        `${notice} ${UNSUBSCRIBE_LINK_LABEL}: ${UNSUBSCRIBE_URL_PLACEHOLDER}`,
        address ?? `{{${MISSING_POSTAL_ADDRESS}}}`,
    ].join('\n');
    return { html, text, missing: address === null ? [MISSING_POSTAL_ADDRESS] : [] };
}

export function composeEmail(
    template: Pick<EmailTemplateBody, 'kind' | 'subject' | 'body'>,
    resolve: VariableResolver,
    settings: MailSettings,
): ComposedEmail {
    const subject = renderSubject(template.subject, resolve);
    const body = renderBody(template.body, resolve);
    let { html, text } = body;
    const missing = [...subject.missing, ...body.missing];
    if (template.kind === 'outreach') {
        const footer = outreachFooter(settings);
        html += footer.html;
        text = text === '' ? footer.text : `${text}\n\n${footer.text}`;
        missing.push(...footer.missing);
    }
    const unique = [...new Set(missing)];
    return { subject: subject.subject, html, text, missing: unique, sendable: unique.length === 0 };
}

/**
 * An outreach email with its unsubscribe link resolved for one recipient (P3-1): every
 * `UNSUBSCRIBE_URL_PLACEHOLDER` the footer left becomes that recipient's link — escaped in the HTML,
 * as is in the text. The send path calls this once per recipient, with `UnsubscribeService.issue`'s
 * `pageUrl`, before building the MIME.
 */
export function withUnsubscribeUrl<E extends { html: string; text: string }>(email: E, url: string): E {
    if (!/^https?:\/\/\S+$/.test(url)) throw new Error('withUnsubscribeUrl: an absolute http(s) URL is required');
    return {
        ...email,
        html: email.html.replaceAll(escapeHtml(UNSUBSCRIBE_URL_PLACEHOLDER), escapeHtml(url)),
        text: email.text.replaceAll(UNSUBSCRIBE_URL_PLACEHOLDER, url),
    };
}
