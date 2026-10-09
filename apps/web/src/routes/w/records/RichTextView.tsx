import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { cn } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/**
 * Renders a stored note or task body (a ProseMirror document from the editor) without loading
 * the editor: the handful of node types the editor can produce (paragraph, heading, lists,
 * links, marks) and nothing else. An unknown node renders its text, so nothing is lost and
 * nothing is executed.
 */
export function RichTextView({ body, className }: { body: RichText; className?: string }) {
    return <div className={cn('text-[13px] leading-relaxed', className)}>{(body.content ?? []).map(render)}</div>;
}

function render(node: RichTextNode, index: number): ReactNode {
    const children = (node.content ?? []).map(render);
    switch (node.type) {
        case 'paragraph':
            return (
                <p key={index} className="m-0 min-h-5 [&+p]:mt-2">
                    {children}
                </p>
            );
        case 'heading': {
            const level =
                typeof node['attrs'] === 'object' && node['attrs'] && 'level' in node['attrs']
                    ? Number((node['attrs'] as { level?: unknown }).level)
                    : 2;
            const Tag = level <= 1 ? 'h3' : 'h4';
            return (
                <Tag key={index} className="mt-3 mb-1 text-sm font-semibold first:mt-0">
                    {children}
                </Tag>
            );
        }
        case 'bulletList':
            return (
                <ul key={index} className="my-1.5 list-disc pl-5">
                    {children}
                </ul>
            );
        case 'orderedList':
            return (
                <ol key={index} className="my-1.5 list-decimal pl-5">
                    {children}
                </ol>
            );
        case 'listItem':
            return <li key={index}>{children}</li>;
        case 'hardBreak':
            return <br key={index} />;
        case 'text':
            return <Marked key={index} node={node} />;
        default:
            return children.length ? (
                <span key={index}>{children}</span>
            ) : node.text ? (
                <span key={index}>{node.text}</span>
            ) : null;
    }
}

function Marked({ node }: { node: RichTextNode }) {
    const marks = Array.isArray(node['marks']) ? (node['marks'] as { type?: string; attrs?: { href?: string } }[]) : [];
    let out: ReactNode = node.text ?? '';
    for (const mark of marks) {
        switch (mark.type) {
            case 'bold':
                out = <strong>{out}</strong>;
                break;
            case 'italic':
                out = <em>{out}</em>;
                break;
            case 'link': {
                const href =
                    typeof mark.attrs?.href === 'string' && /^https?:\/\//.test(mark.attrs.href)
                        ? mark.attrs.href
                        : undefined;
                out = href ? (
                    <a
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent underline underline-offset-2"
                    >
                        {out}
                    </a>
                ) : (
                    out
                );
                break;
            }
            default:
                break;
        }
    }
    return <>{out}</>;
}
