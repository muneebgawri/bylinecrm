import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Skeleton,
} from '@bylinecrm/ui';
import { useMutation } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import { mail } from '../../../api/mail';
import type { PreviewMailInput } from '../../../api/types';
import { EmailFrame } from '../../../components/EmailFrame';
import { failureText } from '../../../lib/errors';

/**
 * The email as it would go out (`POST /mail/preview`): the subject and body with every variable filled in for the
 * person, and the signature that follows it — rendered by the send's own path, never sent. What the composer holds
 * when it is opened; a variable with no value is named, as Send would refuse it.
 */
export function ComposerPreview({
    workspaceId,
    personName,
    input,
    disabled,
}: {
    workspaceId: string;
    personName: string;
    /** The message as the composer would send it now. */
    input: () => PreviewMailInput;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const preview = useMutation({ mutationFn: (body: PreviewMailInput) => mail.preview(workspaceId, body) });
    const rendered = preview.data;
    return (
        <>
            <Button
                size="sm"
                shape="square"
                variant="ghost"
                disabled={disabled}
                onClick={() => {
                    setOpen(true);
                    preview.mutate(input());
                }}
            >
                <Eye aria-hidden />
                Preview
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-3xl">
                    <DialogTitle>Preview</DialogTitle>
                    <DialogDescription>
                        As {personName} will receive it, with your signature. Nothing is sent.
                    </DialogDescription>
                    <DialogBody className="flex flex-col gap-3">
                        {preview.isError ? (
                            <p role="alert" className="m-0 text-sm text-danger">
                                The preview could not be loaded: {failureText(preview.error)}
                            </p>
                        ) : !rendered || preview.isPending ? (
                            <div role="status" aria-label="Rendering preview" className="flex flex-col gap-2">
                                <Skeleton className="h-5 w-2/3" />
                                <Skeleton className="h-72 w-full" />
                            </div>
                        ) : (
                            <>
                                <p className="m-0 text-sm">
                                    <span className="text-text-muted">Subject: </span>
                                    <span className="font-medium">{rendered.subject || '(no subject)'}</span>
                                </p>
                                <EmailFrame
                                    html={rendered.html}
                                    title={`Email preview for ${personName}`}
                                    className="h-96 max-md:h-[55vh]"
                                />
                                {rendered.missing.length > 0 && (
                                    <p role="status" className="m-0 text-[13px] text-warning">
                                        ⚠ {rendered.missing.join(', ')} {rendered.missing.length === 1 ? 'has' : 'have'}{' '}
                                        no value for {personName}, so this would not send.
                                    </p>
                                )}
                            </>
                        )}
                    </DialogBody>
                    <DialogFooter>
                        <Button variant="secondary" size="sm" shape="square" onClick={() => setOpen(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
