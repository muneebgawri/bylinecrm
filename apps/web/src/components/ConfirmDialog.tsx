import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/**
 * The one "are you sure?" for a destructive action — built into the page, never `confirm()`.
 * When the server refuses, `error` carries its words and `children` what the person can do
 * instead (open the deals that block a stage's removal); the action stays offered for a retry.
 */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    body,
    confirm,
    pending,
    onConfirm,
    error,
    children,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    body: string;
    confirm: string;
    pending: boolean;
    onConfirm: () => void;
    error?: string | undefined;
    children?: ReactNode;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{body}</DialogDescription>
                {(error || children) && (
                    <DialogBody className="grid gap-3">
                        {error && (
                            <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                                {error}
                            </p>
                        )}
                        {children}
                    </DialogBody>
                )}
                <DialogFooter>
                    <Button shape="square" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button shape="square" variant="danger" loading={pending} onClick={onConfirm}>
                        {confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
