import { Button } from '@bylinecrm/ui';
import { Bell } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useNotifications } from '../api/notifications';

/** The panel is its own chunk: the first frame carries the bell and its count, not the list. */
const NotificationsPanel = lazy(() => import('./NotificationsPanel').then((m) => ({ default: m.NotificationsPanel })));

/**
 * The top bar's bell (#192): how many of the member's task notifications are unread, asked again
 * every minute. The first press loads the panel (`NotificationsPanel`), which then owns opening and
 * closing.
 */
export function NotificationsBell({ workspaceId }: { workspaceId: string }) {
    const inbox = useNotifications(workspaceId);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const unread = inbox.data?.unread ?? 0;
    const button = (first?: () => void) => (
        <Button
            variant="ghost"
            size="icon"
            shape="square"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
            className="relative"
            onClick={first}
        >
            <Bell aria-hidden />
            {unread > 0 && (
                <span
                    aria-hidden
                    className="absolute top-1.75 right-1.75 size-1.75 rounded-full border-2 border-surface bg-danger"
                />
            )}
        </Button>
    );
    if (!loaded) {
        return button(() => {
            setLoaded(true);
            setOpen(true);
        });
    }
    return (
        <Suspense fallback={button()}>
            <NotificationsPanel
                workspaceId={workspaceId}
                inbox={inbox.data}
                trigger={button()}
                open={open}
                onOpenChange={setOpen}
            />
        </Suspense>
    );
}
