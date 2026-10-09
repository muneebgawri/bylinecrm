import { onlineManager } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { useSyncExternalStore } from 'react';

function subscribe(notify: () => void): () => void {
    return onlineManager.subscribe(notify);
}

/**
 * Shown when the browser reports it is offline. It sits above the content and never hides it:
 * what is on screen stays readable, and the next request will say what failed.
 */
export function OfflineBanner() {
    const online = useSyncExternalStore(
        subscribe,
        () => onlineManager.isOnline(),
        () => true,
    );
    if (online) return null;
    return (
        <div
            role="status"
            className="flex items-center gap-2 border-b border-warning/30 bg-warning-soft px-5 py-2 text-[13px] text-warning"
        >
            <WifiOff aria-hidden className="size-4" />
            You are offline. What you see is the last loaded state; changes will not save until the connection is back.
        </div>
    );
}
