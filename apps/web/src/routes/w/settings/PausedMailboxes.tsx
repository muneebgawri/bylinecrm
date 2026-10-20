import { Badge, Button, toast } from '@bylinecrm/ui';
import { usePausedMailboxes, useResumeMailbox } from '../../../api/reputation';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';

/**
 * REP-2 (#205): mailboxes paused by the reply-rate floor, the spam-rate kill switch or the pool's rates — each
 * with why — and a reviewer's resume. Shown only while one is paused.
 */
export function PausedMailboxes({ workspaceId }: { workspaceId: string }) {
    const paused = usePausedMailboxes(workspaceId);
    const resume = useResumeMailbox(workspaceId);
    const rows = paused.data ?? [];
    if (rows.length === 0) return null;
    return (
        <section aria-labelledby="paused-mailboxes-title" className="mb-4 rounded-md border border-border p-3">
            <h3 id="paused-mailboxes-title" className="m-0 mb-2 text-sm font-semibold">
                Paused mailboxes
            </h3>
            <ul className="m-0 grid list-none gap-2 p-0">
                {rows.map((m) => (
                    <li key={m.mailboxId} className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="font-medium">{m.email}</span>
                        <Badge status="warning">{m.purpose === 'pool' ? 'Pool' : 'Personal'}</Badge>
                        <span className="text-text-muted">
                            {m.pause.message} · {formatRelative(m.pausedAt)}
                        </span>
                        <Button
                            size="sm"
                            shape="square"
                            className="ml-auto"
                            disabled={resume.isPending}
                            onClick={() =>
                                resume.mutate(
                                    { mailboxId: m.mailboxId, note: 'Resumed from Guardrails' },
                                    {
                                        onSuccess: () => toast({ title: `${m.email} resumed`, tone: 'success' }),
                                        onError: (e) => toast({ title: failureText(e), tone: 'danger' }),
                                    },
                                )
                            }
                        >
                            Resume
                        </Button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
