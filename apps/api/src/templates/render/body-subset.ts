import {
    TEMPLATE_BODY_MARKS,
    TEMPLATE_BODY_NODES,
    TEMPLATE_HEADING_LEVELS,
    TEMPLATE_SUBJECT_TOKEN,
    type FieldError,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';
import { safeHref } from './serializer';

/**
 * What a template body may contain, checked on save (P2-4). A body outside the subset is refused
 * with one field error per problem at its path in the request body, so the editor can point at
 * it; the renderer drops the same things again on the way out.
 */

const NODES = new Set<string>(TEMPLATE_BODY_NODES);
const MARKS = new Set<string>(TEMPLATE_BODY_MARKS);
const LEVELS = new Set<number>(TEMPLATE_HEADING_LEVELS);

/** A subset to check a document against: its nodes, where it sits in the request, and checks of its own. */
export interface Subset {
    nodes: ReadonlySet<string>;
    /** The request field the document is: `body` for a template, `signature` for a signature (#193). */
    at: string;
    /** Problems with one node the generic walk does not know about (a signature's image). */
    node?: (node: RichTextNode, at: string) => FieldError[];
}

const TEMPLATE_SUBSET: Subset = { nodes: NODES, at: 'body' };

function attrsOf(node: object): Record<string, unknown> {
    const attrs = (node as { attrs?: unknown }).attrs;
    return attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
}

/** Every way the body leaves the template subset; empty when it is inside it. */
export function bodyProblems(doc: RichText): FieldError[] {
    return subsetProblems(doc, TEMPLATE_SUBSET);
}

/** Every way a document leaves a subset: its nodes, heading levels, variables' paths, marks and links. */
export function subsetProblems(doc: RichText, subset: Subset): FieldError[] {
    const problems: FieldError[] = [];
    const what = subset.at === 'body' ? 'a template body' : `a ${subset.at}`;
    const walk = (node: RichTextNode, at: string): void => {
        if (!subset.nodes.has(node.type)) {
            problems.push({ path: at, message: `${what} cannot contain "${node.type}"` });
            return;
        }
        if (subset.node) problems.push(...subset.node(node, at));
        if (node.type === 'heading' && !LEVELS.has(Number(attrsOf(node)['level']))) {
            problems.push({ path: `${at}.attrs.level`, message: 'headings are level 2 or 3' });
        }
        if (node.type === 'variable') {
            const path = attrsOf(node)['path'];
            if (typeof path !== 'string' || path === '') {
                problems.push({ path: `${at}.attrs.path`, message: 'a variable needs a path' });
            }
        }
        const marks = Array.isArray(node['marks']) ? (node['marks'] as { type?: unknown; attrs?: unknown }[]) : [];
        marks.forEach((mark, i) => {
            const markAt = `${at}.marks.${i}`;
            const type = typeof mark.type === 'string' ? mark.type : '';
            if (!MARKS.has(type)) {
                problems.push({ path: markAt, message: `${what} cannot use the mark "${type}"` });
            } else if (type === 'link' && safeHref(attrsOf(mark)['href']) === null) {
                problems.push({ path: `${markAt}.attrs.href`, message: 'a link must start with https: or mailto:' });
            }
        });
        (node.content ?? []).forEach((child, i) => walk(child, `${at}.content.${i}`));
    };
    (doc.content ?? []).forEach((node, i) => walk(node, `${subset.at}.content.${i}`));
    return problems;
}

/** The variables a body uses, each with where it sits in the request body (`body`, or `signature`). */
export function variablePathsOf(doc: RichText, field = 'body'): { path: string; at: string }[] {
    const found: { path: string; at: string }[] = [];
    const walk = (node: RichTextNode, at: string): void => {
        if (node.type === 'variable') {
            const path = attrsOf(node)['path'];
            if (typeof path === 'string' && path !== '') found.push({ path, at });
        }
        (node.content ?? []).forEach((child, i) => walk(child, `${at}.content.${i}`));
    };
    (doc.content ?? []).forEach((node, i) => walk(node, `${field}.content.${i}`));
    return found;
}

/** The `{{ path }}` tokens of a subject line, in order. */
export function subjectVariablePaths(subject: string): string[] {
    return [...subject.matchAll(TEMPLATE_SUBJECT_TOKEN)].map((m) => m[1]!);
}
