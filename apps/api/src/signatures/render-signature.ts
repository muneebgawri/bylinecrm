import {
    BOOKING_LINK_LABEL,
    SIGNATURE_BOOKING_VARIABLE,
    SIGNATURE_IMAGE_ALT_MAX,
    SIGNATURE_IMAGE_MAX_WIDTH,
    SIGNATURE_LOGO_VARIABLE,
    SIGNATURE_MAX_CHARS,
    SIGNATURE_NODES,
    isSignatureVariable,
    type FieldError,
    type RenderedSignature,
    type RichText,
    type RichTextNode,
    type SignatureVariablePath,
} from '@bylinecrm/shared';
import { subsetProblems, variablePathsOf, type Subset } from '../templates/render/body-subset';
import { escapeHtml, imageHtml, renderRichText, safeImageSrc } from '../templates/render/serializer';

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
    };
    workspace: { name: string; logo: { url: string; width: number; height: number } | null };
}

const text = (value: string | null) => ({ html: value ? escapeHtml(value) : '', text: value ?? '' });

function variable(path: SignatureVariablePath, values: SignatureValues): { html: string; text: string } {
    const { sender, workspace } = values;
    switch (path) {
        case 'sender.fullName':
            return text(sender.fullName);
        case 'sender.firstName':
            return text(sender.firstName);
        case 'sender.title':
            return text(sender.title);
        case 'sender.phone':
            return text(sender.phone);
        case 'workspace.name':
            return text(workspace.name);
        case SIGNATURE_BOOKING_VARIABLE:
            return sender.bookingLink
                ? {
                      html: `<a href="${escapeHtml(sender.bookingLink)}">${escapeHtml(BOOKING_LINK_LABEL)}</a>`,
                      text: `${BOOKING_LINK_LABEL}: ${sender.bookingLink}`,
                  }
                : text(null);
        case SIGNATURE_LOGO_VARIABLE:
            return workspace.logo
                ? {
                      html: imageHtml(workspace.logo.url, workspace.name, workspace.logo.width, workspace.logo.height),
                      text: '',
                  }
                : text(null);
    }
}

export function renderSignature(doc: RichText, values: SignatureValues): RenderedSignature {
    const out = renderRichText(
        doc,
        (path) => (isSignatureVariable(path) ? variable(path, values) : text(null)),
        { images: true, dropEmptyLines: true },
        SIGNATURE_IMAGE_MAX_WIDTH,
    );
    return { html: out.html, text: out.text };
}

function imageProblems(node: RichTextNode, at: string): FieldError[] {
    if (node.type !== 'image') return [];
    const attrs = (node['attrs'] ?? {}) as Record<string, unknown>;
    const problems: FieldError[] = [];
    if (safeImageSrc(attrs['src']) === null) {
        problems.push({ path: `${at}.attrs.src`, message: 'an image is linked by an https: URL' });
    }
    const alt = attrs['alt'];
    if (alt !== undefined && alt !== null && (typeof alt !== 'string' || alt.length > SIGNATURE_IMAGE_ALT_MAX)) {
        problems.push({
            path: `${at}.attrs.alt`,
            message: `alt text is at most ${SIGNATURE_IMAGE_ALT_MAX} characters`,
        });
    }
    const width = attrs['width'];
    if (
        width !== undefined &&
        width !== null &&
        !(Number.isInteger(width) && (width as number) >= 1 && (width as number) <= SIGNATURE_IMAGE_MAX_WIDTH)
    ) {
        problems.push({
            path: `${at}.attrs.width`,
            message: `an image is 1 to ${SIGNATURE_IMAGE_MAX_WIDTH} pixels wide`,
        });
    }
    return problems;
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
