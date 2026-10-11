import { cn, useMediaQuery, useTheme } from '@bylinecrm/ui';
import { useCallback, useEffect, useRef } from 'react';

/**
 * An email body the API rendered or sanitised, shown in a sandboxed iframe that runs no script —
 * the one frame for a template preview (doc 50 §C) and a message in a thread (doc 50 §A).
 *
 * The HTML is already safe (the API's allowlist: no scripts, styles or images); the frame is the
 * second wall. Its sandbox never includes `allow-scripts`, and its document carries a CSP that
 * loads nothing. It is (re)written after the theme is applied and whenever the theme changes, so
 * it follows the page's tokens.
 *
 * `fit` sizes the frame to its content (a thread's messages read as one column, not a stack of
 * scroll boxes). That needs the page to read the frame's height, which `allow-same-origin` allows;
 * without `allow-scripts` the frame still runs nothing, and its links are opened by the page in a
 * new tab with no opener, so a message can never navigate the frame or the app.
 */
export function EmailFrame({
    html,
    title,
    fit = false,
    className,
}: {
    html: string;
    title: string;
    fit?: boolean;
    className?: string;
}) {
    const frame = useRef<HTMLIFrameElement>(null);
    const { theme } = useTheme();
    const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
    useEffect(() => {
        if (frame.current) frame.current.srcdoc = emailDocument(html);
    }, [html, theme, systemDark]);

    const onLoad = useCallback(() => {
        const doc = fit ? frame.current?.contentDocument : null;
        if (!frame.current || !doc) return;
        frame.current.style.height = `${doc.documentElement.scrollHeight}px`;
        doc.addEventListener('click', (event) => {
            const link = (event.target as Element | null)?.closest?.('a[href]');
            if (!link) return;
            event.preventDefault();
            const href = link.getAttribute('href') ?? '';
            if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
        });
    }, [fit]);

    return (
        <iframe
            ref={frame}
            title={title}
            sandbox={fit ? 'allow-same-origin' : ''}
            onLoad={onLoad}
            className={cn('w-full rounded-md border border-border bg-surface', className)}
        />
    );
}

/** The design tokens the frame reads from the page it sits in, so it follows the theme. */
const FRAME_TOKENS = [
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
    return FRAME_TOKENS.map((token) => `${token}:${style.getPropertyValue(token).trim()};`).join('');
}

/**
 * A whole HTML document around an email body, for `<iframe srcdoc sandbox>`: the page's tokens,
 * the body's typography, and a CSP that fetches nothing (no images, fonts or frames load from a
 * message). A missing variable is highlighted with its name — never shown blank (FR-CRMS-3).
 */
export function emailDocument(html: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
:root{${tokenValues()}}
body{margin:0;padding:16px 18px;background:var(--bc-surface);color:var(--bc-text);font:14px/1.6 var(--bc-font-sans);overflow-wrap:anywhere;}
a{color:var(--bc-accent);}
hr{border:0;border-top:1px solid var(--bc-border);margin:20px 0 12px;}
h2{font-size:18px;margin:16px 0 8px;}h3{font-size:15px;margin:14px 0 6px;}
blockquote{margin:8px 0;padding-left:12px;border-left:2px solid var(--bc-border);color:var(--bc-text-muted);}
[data-missing-variable]{background:var(--bc-danger-soft);color:var(--bc-danger);border-radius:4px;padding:0 4px;font-weight:600;}
</style></head><body>${html}</body></html>`;
}
