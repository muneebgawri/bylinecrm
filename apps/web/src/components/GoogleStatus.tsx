import { Link } from 'react-router';
import type { GoogleOAuthClientStatusView } from '../api/types';
import { useCan } from '../auth/capabilities';
import { paths } from '../routes/paths';

/**
 * Whether the workspace's Google OAuth client is set up, in words a member can act on (doc 50 §E):
 * an admin is pointed at Google setup; anyone else is told to ask one. Reads only `/status`, so it
 * says nothing about the client itself.
 */
export function GoogleStatus({ workspaceId, status }: { workspaceId: string; status: GoogleOAuthClientStatusView }) {
    const admin = useCan('workspace:admin');
    if (status.configured) {
        return (
            <p className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
                <span className="font-medium text-text">Your admin has set up Google.</span>{' '}
                {status.verified
                    ? 'Mailboxes connect through the workspace’s own OAuth client.'
                    : 'No mailbox has connected through it yet; the first one confirms the setup.'}
            </p>
        );
    }
    return (
        <p role="status" className="m-0 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning">
            {admin ? (
                <>
                    <span className="font-medium">Google isn’t set up yet.</span> Mailboxes connect through the
                    workspace’s own OAuth client.{' '}
                    <Link className="font-medium underline" to={paths.settingsGoogle(workspaceId)}>
                        Set up Google
                    </Link>
                </>
            ) : (
                'Google isn’t set up yet — ask an admin.'
            )}
        </p>
    );
}
