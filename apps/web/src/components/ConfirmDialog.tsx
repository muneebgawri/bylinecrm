import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/**
 * The one "are you sure?" for a destructive action — built into the page, never `confirm()`.
 * When the server refuses, `error` carries its words and `children` what the person can do
 * instead (choose where a stage's deals go); the action stays offered for a retry, and
 * `confirmDisabled` holds it until the person has made the choice it needs.
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
    confirmDisabled = false,
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
    confirmDisabled?: boolean;
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
                    <Button
                        shape="square"
                        variant="danger"
                        loading={pending}
                        disabled={confirmDisabled}
                        onClick={onConfirm}
                    >
                        {confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
