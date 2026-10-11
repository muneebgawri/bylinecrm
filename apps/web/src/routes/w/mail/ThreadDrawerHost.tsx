import { Drawer, DrawerContent } from '@bylinecrm/ui';
import { useLocation, useNavigate } from 'react-router';
import { useMailThread } from '../../../api/mail';
import { useWorkspaceId } from '../../params';
import { THREAD_PARAM, withThread } from './thread';
import { ThreadView } from './ThreadView';

/**
 * The thread view over any workspace page (doc 50 §A): `?thread=<id>` opens it — a side drawer on a
 * desktop, the whole screen on a phone (the drawer is as wide as the screen there). It stacks over
 * the record drawer when a thread is opened from one; Esc closes the top one only.
 */
export function ThreadDrawerHost() {
    const location = useLocation();
    const threadId = new URLSearchParams(location.search).get(THREAD_PARAM);
    if (!threadId) return null;
    return <ThreadDrawer threadId={threadId} />;
}

function ThreadDrawer({ threadId }: { threadId: string }) {
    const workspaceId = useWorkspaceId();
    const location = useLocation();
    const navigate = useNavigate();
    // The same cached read the view makes: the drawer's title is the thread's subject.
    const thread = useMailThread(workspaceId, threadId);
    const close = () =>
        navigate({ pathname: location.pathname, search: withThread(location.search, null) }, { replace: true });
    return (
        <Drawer open onOpenChange={(open) => !open && close()}>
            <DrawerContent
                title={thread.data?.subject || 'Email thread'}
                description="The messages in this email thread, oldest first"
                className="max-md:border-l-0"
            >
                <ThreadView workspaceId={workspaceId} threadId={threadId} />
            </DrawerContent>
        </Drawer>
    );
}
