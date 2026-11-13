import { Button, cn } from '@bylinecrm/ui';
import { Bell } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useNotifications, useNotificationSettings } from '../api/notifications';
import { chime } from '../lib/chime';

/** The panel is its own chunk: the first frame carries the bell and its count, not the list. */
const NotificationsPanel = lazy(() => import('./NotificationsPanel').then((m) => ({ default: m.NotificationsPanel })));

/**
 * The top bar's bell (#192): how many of the member's task notifications are unread, asked again
 * every minute. The first press loads the panel (`NotificationsPanel`), which then owns opening and
 * closing.
 *
 * It tells without interrupting: while anything is unread the bell turns blue, and when the count
 * rises while the app is open it swings once and (unless the member turned the sound off) chimes. What was
 * already unread when the app opened makes no sound.
 */
export function NotificationsBell({ workspaceId }: { workspaceId: string }) {
    const inbox = useNotifications(workspaceId);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const settings = useNotificationSettings(workspaceId);
    const unread = inbox.data?.unread ?? 0;
    const sound = settings.data?.notifySound ?? false;
    /** The count last seen; undefined until the first answer, which is not news. */
    const seen = useRef<number | undefined>(undefined);
    const [rings, setRings] = useState(0);
    const count = inbox.data?.unread;
    useEffect(() => {
        if (count === undefined) return;
        const before = seen.current;
        seen.current = count;
        if (before === undefined || count <= before) return;
        setRings((n) => n + 1);
        if (sound) chime();
    }, [count, sound]);
    const button = (first?: () => void) => (
        <Button
            variant="ghost"
            size="icon"
            shape="square"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
            className={cn('relative', unread > 0 && 'bg-info-soft text-info hover:bg-info-soft hover:text-info')}
            onClick={first}
        >
            <Bell key={rings} aria-hidden className={rings > 0 ? 'bell-ring' : undefined} />
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
