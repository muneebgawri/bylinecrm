import { EmptyState } from '@bylinecrm/ui';
import { Mail } from 'lucide-react';

/**
 * Where the compose box will be (doc 50 §A). Mail arrives with Phase 2; until then this is a
 * designed empty state that says so — no fake inputs that would refuse on send (FR-CRMS-UI-7).
 * `notice` is the line the `e` shortcut sets so the key does something honest.
 */
export function ComposePlaceholder({ notice }: { notice?: string | null }) {
    return (
        <div>
            <EmptyState
                icon={<Mail />}
                title="Connect a mailbox to email from here"
                body="Sending and reading mail on this record arrives in Phase 2. Notes and tasks work now."
                className="py-7"
            />
            <p role="status" aria-live="polite" className="m-0 mt-1 min-h-4 text-center text-xs text-text-faint">
                {notice}
            </p>
        </div>
    );
}
