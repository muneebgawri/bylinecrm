import { Button } from '@bylinecrm/ui';
import { useRef, useState } from 'react';

/**
 * A value someone has to copy into another system (a new API key, the redirect URI Google must be
 * told), with a Copy button whose result is announced, never assumed. The clipboard is written inside
 * the click; where that is refused the value is selected so it can be copied by hand.
 */
export function CopyValue({ value, label = 'Copy' }: { value: string; label?: string }) {
    const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
    const code = useRef<HTMLElement>(null);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied('copied');
        } catch {
            const node = code.current;
            if (node) window.getSelection()?.selectAllChildren(node);
            setCopied('failed');
        }
    };
    return (
        <div className="grid gap-2">
            <code
                ref={code}
                className="block rounded-md border border-border bg-surface-raised px-3 py-2 text-sm break-all select-all"
            >
                {value}
            </code>
            <div className="flex items-center gap-2">
                <Button size="sm" shape="square" className="max-md:h-touch" aria-label={label} onClick={copy}>
                    Copy
                </Button>
                <span role="status" className="text-xs text-text-muted">
                    {copied === 'copied'
                        ? 'Copied.'
                        : copied === 'failed'
                          ? 'Could not copy — it is selected; copy it by hand.'
                          : ''}
                </span>
            </div>
        </div>
    );
}
