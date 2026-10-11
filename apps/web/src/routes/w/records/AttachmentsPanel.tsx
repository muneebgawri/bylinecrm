import type { RecordTarget } from '@bylinecrm/shared';
import { Button, cn, focusRing } from '@bylinecrm/ui';
import { Paperclip, Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { attachments as attachmentRoutes } from '../../../api/records';
import { useAttachments, useDeleteAttachment, useUploadAttachment } from '../../../api/records';
import { usePermission } from '../../../auth/capabilities';
import { formatBytes, formatWhen } from '../../../lib/format';
import { messageFor } from './InlineEdit';
import { RailCard, RailEmpty, RailLoading } from './RailCard';

/**
 * Files on a record: a drop zone (or the picker), the list with download links, delete with the
 * question asked in place. Size and type limits are the API's; its refusal is shown as it says it.
 */
export function AttachmentsPanel({ workspaceId, target }: { workspaceId: string; target: RecordTarget }) {
    const list = useAttachments(workspaceId, target);
    const upload = useUploadAttachment(workspaceId, target);
    const remove = useDeleteAttachment(workspaceId, target);
    const write = usePermission('record:write');
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);
    const [confirming, setConfirming] = useState<string | null>(null);

    const send = (files: FileList | null) => {
        const file = files?.[0];
        if (file) upload.mutate(file);
    };
    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        if (write.allowed) send(e.dataTransfer.files);
    };

    return (
        <RailCard
            title="Files"
            count={list.data?.length}
            action={
                write.allowed ? (
                    <Button
                        size="xs"
                        shape="square"
                        variant="ghost"
                        onClick={() => input.current?.click()}
                        disabled={upload.isPending}
                    >
                        <Upload className="size-3.5" />
                        {upload.isPending ? 'Uploading…' : 'Upload'}
                    </Button>
                ) : (
                    <span className="text-xs text-text-faint" title={write.reason}>
                        read only
                    </span>
                )
            }
        >
            <input
                ref={input}
                type="file"
                className="sr-only"
                aria-label="Choose a file"
                onChange={(e) => send(e.target.files)}
            />
            {write.allowed && (
                <div
                    onDragOver={(e) => {
                        e.preventDefault();
                        setOver(true);
                    }}
                    onDragLeave={() => setOver(false)}
                    onDrop={onDrop}
                    className={cn(
                        'mx-4 mt-3 rounded-md border border-dashed px-3 py-2 text-center text-xs text-text-faint',
                        over ? 'border-accent bg-accent-soft text-accent' : 'border-border',
                    )}
                >
                    Drop a file here
                </div>
            )}
            {upload.isError && (
                <p role="alert" className="m-0 px-4 pt-2 text-xs text-danger">
                    {messageFor(upload.error, 'file')}
                </p>
            )}
            {list.isPending ? (
                <RailLoading />
            ) : list.isError ? (
                <RailEmpty>Files could not be loaded.</RailEmpty>
            ) : list.data.length === 0 ? (
                <RailEmpty>No files yet.</RailEmpty>
            ) : (
                <ul className="m-0 mt-2 list-none p-0">
                    {list.data.map((file) => (
                        <li
                            key={file.id}
                            className="flex items-center gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0"
                        >
                            <Paperclip aria-hidden className="size-4 shrink-0 text-text-faint" />
                            <div className="min-w-0 flex-1">
                                <a
                                    href={attachmentRoutes.contentUrl(workspaceId, file.id)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className={cn(
                                        'block truncate text-[13px] font-medium hover:underline max-md:flex max-md:min-h-touch max-md:items-center',
                                        focusRing,
                                    )}
                                >
                                    {file.name}
                                </a>
                                <span className="block text-xs text-text-muted">
                                    {formatBytes(file.sizeBytes)} · {formatWhen(file.createdAt)}
                                </span>
                            </div>
                            {write.allowed &&
                                (confirming === file.id ? (
                                    <span className="flex items-center gap-1">
                                        <Button
                                            size="xs"
                                            shape="square"
                                            variant="danger"
                                            disabled={remove.isPending}
                                            onClick={() =>
                                                remove.mutate(file.id, { onSettled: () => setConfirming(null) })
                                            }
                                        >
                                            Delete
                                        </Button>
                                        <Button
                                            size="xs"
                                            shape="square"
                                            variant="ghost"
                                            onClick={() => setConfirming(null)}
                                        >
                                            Keep
                                        </Button>
                                    </span>
                                ) : (
                                    <Button
                                        size="xs"
                                        shape="square"
                                        variant="ghost"
                                        onClick={() => setConfirming(file.id)}
                                        aria-label={`Delete ${file.name}`}
                                    >
                                        Delete
                                    </Button>
                                ))}
                        </li>
                    ))}
                </ul>
            )}
            {remove.isError && (
                <p role="alert" className="m-0 px-4 pb-2 text-xs text-danger">
                    {messageFor(remove.error, 'attachment')}
                </p>
            )}
        </RailCard>
    );
}
