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
    if (rendered.missing.includes(MISSING_POSTAL_ADDRESS)) {
        return {
            tone: 'warning',
            text: 'The workspace postal address is not set, so this outreach email cannot be sent.',
        };
    }
    const empty = rendered.missing;
    if (empty.length > 0) {
        return {
            tone: 'warning',
            text: `${empty.length} of ${variableCount} variable${variableCount === 1 ? ' is' : 's are'} empty for ${recipient}: ${empty.join(', ')}.`,
        };
    }
    if (variableCount === 0) return { tone: 'success', text: `No variables to fill; ready for ${recipient}.` };
    return {
        tone: 'success',
        text: `All ${variableCount} variable${variableCount === 1 ? '' : 's'} resolve${variableCount === 1 ? 's' : ''} for ${recipient}.`,
    };
}

/** The design tokens the preview reads from the page it sits in, so it follows the theme. */
const PREVIEW_TOKENS = [
    '--bc-surface',
    '--bc-text',
    '--bc-text-muted',
    '--bc-border',
    '--bc-accent',
    '--bc-danger',
    '--bc-danger-soft',
    '--bc-font-sans',
] as const;

function tokenValues(): string {
    if (typeof document === 'undefined') return '';
    const style = getComputedStyle(document.documentElement);
    return PREVIEW_TOKENS.map((token) => `${token}:${style.getPropertyValue(token).trim()};`).join('');
}

/**
 * A whole HTML document around the API's rendered body, for `<iframe srcdoc sandbox>`. The body is
 * already safe (the API's allowlist renderer); the iframe's empty `sandbox` runs no script anyway.
 * A missing variable is highlighted with its name — never shown blank (FR-CRMS-3).
 */
export function previewDocument(html: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${tokenValues()}}
body{margin:0;padding:16px 18px;background:var(--bc-surface);color:var(--bc-text);font:14px/1.6 var(--bc-font-sans);}
a{color:var(--bc-accent);}
hr{border:0;border-top:1px solid var(--bc-border);margin:20px 0 12px;}
h2{font-size:18px;margin:16px 0 8px;}h3{font-size:15px;margin:14px 0 6px;}
[data-missing-variable]{background:var(--bc-danger-soft);color:var(--bc-danger);border-radius:4px;padding:0 4px;font-weight:600;}
</style></head><body>${html}</body></html>`;
}
