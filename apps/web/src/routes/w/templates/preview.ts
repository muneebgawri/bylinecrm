import { MISSING_POSTAL_ADDRESS, TEMPLATE_SUBJECT_TOKEN, type RichText, type RichTextNode } from '@bylinecrm/shared';
import type { RenderedEmailView } from '../../../api/types';
import { VARIABLE_NODE } from '../../../components/rich-text/variableNode';

/**
 * The preview pane's words and document (doc 50 §C). The API renders (P2-4); this only counts what
 * was asked for, says what came back, and frames the rendered HTML for a sandboxed iframe.
 */

/** Every distinct variable a template uses, subject first, in order of first use. */
export function templateVariablePaths(subject: string, body: RichText): string[] {
    const seen = new Set<string>();
    for (const match of subject.matchAll(new RegExp(TEMPLATE_SUBJECT_TOKEN.source, 'g'))) {
        if (match[1]) seen.add(match[1]);
    }
    const walk = (nodes: readonly RichTextNode[] | undefined) => {
        for (const node of nodes ?? []) {
            if (node.type === VARIABLE_NODE) {
                const path = (node.attrs as { path?: unknown } | undefined)?.path;
                if (typeof path === 'string' && path) seen.add(path);
            }
            walk(node.content);
        }
    };
    walk(body.content);
    return [...seen];
}

export interface ResolutionLine {
    tone: 'success' | 'warning';
    text: string;
}

/** The line under the preview: does every variable have a value for this person, and if not, which. */
export function resolutionLine(
    rendered: Pick<RenderedEmailView, 'missing' | 'sendable'>,
    variableCount: number,
    recipient: string,
): ResolutionLine {
    const noAddress = rendered.missing.includes(MISSING_POSTAL_ADDRESS);
    const empty = rendered.missing.filter((path) => path !== MISSING_POSTAL_ADDRESS);
    const parts: string[] = [];
    if (empty.length > 0) {
        const noun = variableCount === 1 ? 'variable' : 'variables';
        const verb = empty.length === 1 ? 'is' : 'are';
        parts.push(`${empty.length} of ${variableCount} ${noun} ${verb} empty for ${recipient}: ${empty.join(', ')}.`);
    }
    if (noAddress) parts.push('The workspace postal address is not set, so this outreach email cannot be sent.');
    if (parts.length > 0) return { tone: 'warning', text: parts.join(' ') };
    if (variableCount === 0) return { tone: 'success', text: `No variables to fill; ready for ${recipient}.` };
    return {
        tone: 'success',
        text: `All ${variableCount} variable${variableCount === 1 ? '' : 's'} resolve${variableCount === 1 ? 's' : ''} for ${recipient}.`,
    };
}
