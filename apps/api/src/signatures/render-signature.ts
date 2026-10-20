import {
    BOOKING_LINK_LABEL,
    SIGNATURE_BOOKING_VARIABLE,
    SIGNATURE_IMAGE_MAX_WIDTH,
    SIGNATURE_LOGO_VARIABLE,
    SIGNATURE_MAX_CHARS,
    SIGNATURE_NODES,
    SOCIAL_ICON_SIZE,
    SOCIAL_NETWORK_LABEL,
    isSignatureVariable,
    type SocialNetwork,
    type FieldError,
    type RenderedSignature,
    type RichText,
    type SignatureVariablePath,
} from '@bylinecrm/shared';
import { imageProblems, subsetProblems, variablePathsOf, type Subset } from '../templates/render/body-subset';
import { escapeHtml, imageHtml, renderRichText } from '../templates/render/serializer';

/**
 * A signature as an email carries it (#193): the template serializer's one walk, with images and with
 * empty lines left out, and the signature's own variables — the sender's name, title, phone and booking
 * link, the workspace's name and logo. None of them is ever missing: an empty one renders empty, and a
 * line it leaves with nothing on it goes.
 */

/** What a signature's variables read, already scoped to the sending mailbox and its member. */
export interface SignatureValues {
    sender: {
        fullName: string | null;
        firstName: string | null;
        title: string | null;
        phone: string | null;
        bookingLink: string | null;
        /** The member's profiles, in `SOCIAL_NETWORKS` order. */
        socials: { network: SocialNetwork; url: string }[];
    };
    /** Where the CRM serves the social icons: `<base>/<network>.png`. */
    socialIconBase: string;
    workspace: { name: string; logo: { url: string; width: number; height: number } | null };
}

const text = (value: string | null) => ({ html: value ? escapeHtml(value) : '', text: value ?? '' });
const styled = (style: string, value: string | null) =>
    value ? { html: `<span style="${style}">${escapeHtml(value)}</span>`, text: value } : text(null);

/**
 * How a signature looks in an email: inline styles only, which every mail client keeps — a table of tight
 * rows in a system font, the name bold, the title grey, links in one colour without underline. Neutral
 * colours: a signature sits under any message, in any workspace.
 */
export const SIGNATURE_STYLE = {
    table: 'border-collapse:collapse;margin-top:16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#374151',
    row: 'padding:0 0 8px 0',
    line: 'margin:0',
    name: 'font-size:15px;font-weight:bold;color:#111827',
    title: 'color:#6b7280',
    link: 'color:#2563eb;text-decoration:none',
    logo: 'display:block;border:0',
    socialLink: 'display:inline-block;margin-right:6px;text-decoration:none',
    socialIcon: 'display:block;border:0',
} as const;

function variable(path: SignatureVariablePath, values: SignatureValues): { html: string; text: string } {
    const { sender, workspace } = values;
    switch (path) {
        case 'sender.fullName':
            return styled(SIGNATURE_STYLE.name, sender.fullName);
        case 'sender.firstName':
            return text(sender.firstName);
        case 'sender.title':
            return styled(SIGNATURE_STYLE.title, sender.title);
        case 'sender.phone':
            return text(sender.phone);
        case 'workspace.name':
            return text(workspace.name);
        case SIGNATURE_BOOKING_VARIABLE:
            return sender.bookingLink
                ? {
                      html: `<a href="${escapeHtml(sender.bookingLink)}" style="${SIGNATURE_STYLE.link}">${escapeHtml(BOOKING_LINK_LABEL)}</a>`,
                      text: `${BOOKING_LINK_LABEL}: ${sender.bookingLink}`,
                  }
                : text(null);
        case 'sender.socials':
            return sender.socials.length
                ? {
                      html: sender.socials
                          .map(
                              ({ network, url }) =>
                                  `<a href="${escapeHtml(url)}" style="${SIGNATURE_STYLE.socialLink}">` +
                                  imageHtml(
                                      `${values.socialIconBase}/${network}.png`,
                                      SOCIAL_NETWORK_LABEL[network],
                                      SOCIAL_ICON_SIZE,
                                      SOCIAL_ICON_SIZE,
                                      SIGNATURE_STYLE.socialIcon,
                                  ) +
                                  '</a>',
                          )
                          .join(''),
                      text: sender.socials
                          .map(({ network, url }) => `${SOCIAL_NETWORK_LABEL[network]}: ${url}`)
                          .join('\n'),
                  }
                : text(null);
        case SIGNATURE_LOGO_VARIABLE:
            return workspace.logo
                ? {
                      // Stored at twice the size it is shown (`LOGO_WIDTH`): sharp on a high-density screen.
                      html: imageHtml(
                          workspace.logo.url,
                          workspace.name,
                          Math.round(workspace.logo.width / 2),
                          Math.round(workspace.logo.height / 2),
                          SIGNATURE_STYLE.logo,
                      ),
                      text: '',
                  }
                : text(null);
    }
}

export function renderSignature(doc: RichText, values: SignatureValues): RenderedSignature {
    const out = renderRichText(
        doc,
        (path) => (isSignatureVariable(path) ? variable(path, values) : text(null)),
        {
            images: true,
            dropEmptyLines: true,
            layout: {
                block: (html) => `<tr><td style="${SIGNATURE_STYLE.row}">${html}</td></tr>`,
                paragraph: SIGNATURE_STYLE.line,
                link: SIGNATURE_STYLE.link,
            },
        },
        SIGNATURE_IMAGE_MAX_WIDTH,
    );
    if (out.html === '') return { html: '', text: out.text };
    return {
        html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${SIGNATURE_STYLE.table}">${out.html}</table>`,
        text: out.text,
    };
}

const SIGNATURE_SUBSET: Subset = { nodes: new Set<string>(SIGNATURE_NODES), at: 'signature', node: imageProblems };

/** Every way a signature leaves its subset, at its path under `signature`; empty when it is inside it. */
export function signatureProblems(doc: RichText, field = 'signature'): FieldError[] {
    if (JSON.stringify(doc).length > SIGNATURE_MAX_CHARS) {
        return [{ path: field, message: `a signature is at most ${SIGNATURE_MAX_CHARS} characters as stored` }];
    }
    const problems = subsetProblems(doc, { ...SIGNATURE_SUBSET, at: field });
    for (const { path, at } of variablePathsOf(doc, field)) {
        if (!isSignatureVariable(path)) {
            problems.push({ path: `${at}.attrs.path`, message: `a signature cannot use the variable "${path}"` });
        }
    }
    return problems;
}

/** Whether a signature names a variable anywhere in it. */
export function signatureNames(doc: RichText, path: SignatureVariablePath): boolean {
    return variablePathsOf(doc).some((found) => found.path === path);
}
