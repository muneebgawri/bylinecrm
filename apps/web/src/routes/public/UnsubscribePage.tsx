import { Button, Skeleton } from '@bylinecrm/ui';
import { CircleCheck } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useConfirmUnsubscribe, useUnsubscribeStatus } from '../../api/mailAdmin';
import { failureText } from '../../lib/errors';
import { useUnsubscribeToken } from '../params';

/**
 * A recipient's unsubscribe page (P3-1, FR-CRMS-7): what the visible link in an outreach email
 * opens, and where a mail client that opens the header's link lands. Opening it changes nothing —
 * link scanners open links too — the button does. No sign-in, no app chrome and no product name:
 * the person reading it received someone else's mail, not ours.
 */
export function UnsubscribePage() {
    const token = useUnsubscribeToken();
    const status = useUnsubscribeStatus(token);
    const confirm = useConfirmUnsubscribe(token);
    // The tab names the page, not the product: the reader received someone else's mail.
    useEffect(() => {
        document.title = 'Unsubscribe';
    }, []);

    if (status.isPending) {
        return (
            <Frame title="Unsubscribe">
                <div aria-busy="true" aria-label="Loading" className="grid gap-3">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-11 w-full" />
                </div>
            </Frame>
        );
    }
    if (status.isError) {
        const missing = status.error instanceof ApiError && status.error.status === 404;
        return (
            <Frame title={missing ? 'This link is not valid' : 'Something went wrong'}>
                <p className="m-0 text-text-muted">
                    {missing
                        ? 'Check that the whole link from the email was opened. If it still does not work, reply to the email and ask to be removed.'
                        : `${failureText(status.error)} Try again in a moment.`}
                </p>
            </Frame>
        );
    }
    if (status.data.unsubscribed) {
        return (
            <Frame title="You’re unsubscribed">
                <p className="m-0 flex items-start gap-2 text-text-muted">
                    <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
                    <span>
                        <span className="font-medium text-text">{status.data.recipient}</span> will not get these emails
                        again.
                    </span>
                </p>
            </Frame>
        );
    }
    return (
        <Frame title="Unsubscribe">
            <p className="m-0 mb-5 text-text-muted">
                Stop emails like this one to <span className="font-medium text-text">{status.data.recipient}</span>?
            </p>
            {confirm.isError && (
                <p role="alert" className="m-0 mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                    {failureText(confirm.error)}
                </p>
            )}
            <Button
                variant="primary"
                shape="square"
                className="w-full"
                data-primary-action
                loading={confirm.isPending}
                onClick={() => confirm.mutate()}
            >
                Unsubscribe
            </Button>
        </Frame>
    );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
    return (
        <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-text">
            <div className="w-full max-w-100 rounded-lg border border-border bg-surface p-6 shadow-sm">
                <h1 className="m-0 mb-3 text-xl font-semibold tracking-tight">{title}</h1>
                {children}
            </div>
        </main>
    );
}
