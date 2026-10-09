import { DISPLAY_NAME_MAX_LENGTH } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useUpdateProfile } from '../api/queries';
import type { ProfileView } from '../api/types';

export interface ProfileDialogProps {
    profile: ProfileView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** `prompt`: asked once after sign-up; dismissing it keeps the suggested name. `edit`: from the menu. */
    mode: 'prompt' | 'edit';
}

/**
 * The person's own name, as every workspace shows it (P1-UI-10). One dialog for both moments: asked
 * once after sign-up with a suggestion (the address's local part), and opened later from the user
 * menu or the palette. On a phone the design system draws it as a bottom sheet (FR-CRMS-UI-12).
 */
export function ProfileDialog({ profile, open, onOpenChange, mode }: ProfileDialogProps) {
    const update = useUpdateProfile();
    const suggested = profile.displayName ?? '';

    // Closing the first-time prompt any way (Esc, the scrim, "Not now") keeps the suggestion, so it
    // is asked once: saving the name the person already has is what confirms it.
    const close = (next: boolean) => {
        if (!next && mode === 'prompt' && !update.isPending) update.mutate(suggested);
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent>
                {open && (
                    <ProfileForm
                        key={suggested}
                        suggested={suggested}
                        email={profile.email}
                        mode={mode}
                        saving={update.isPending}
                        onSave={(name, onError) =>
                            update.mutate(name, {
                                onSuccess: () => {
                                    if (mode === 'edit') toast({ title: 'Name saved', tone: 'success' });
                                    onOpenChange(false);
                                },
                                onError,
                            })
                        }
                        onCancel={() => close(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ProfileForm({
    suggested,
    email,
    mode,
    saving,
    onSave,
    onCancel,
}: {
    suggested: string;
    email: string;
    mode: 'prompt' | 'edit';
    saving: boolean;
    onSave: (name: string, onError: (error: unknown) => void) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState(suggested);
    const [error, setError] = useState<string | null>(null);

    function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return setError('Enter the name your team should see.');
        if (trimmed.length > DISPLAY_NAME_MAX_LENGTH)
            return setError(`Keep it to ${DISPLAY_NAME_MAX_LENGTH} characters.`);
        setError(null);
        onSave(trimmed, (failure) => {
            const field =
                failure instanceof ApiError ? failure.fieldErrors.find((f) => f.path === 'displayName') : null;
            setError(
                field?.message ?? (failure instanceof ApiError ? failure.message : 'The server could not be reached.'),
            );
        });
    }

    return (
        <form onSubmit={submit} noValidate className="contents">
            <DialogTitle>{mode === 'prompt' ? 'What should your team call you?' : 'Your profile'}</DialogTitle>
            <DialogDescription>
                Your name is shown to the people in every workspace you belong to. You sign in as {email}.
            </DialogDescription>
            <DialogBody className="flex flex-col gap-4">
                <Field label="Your name" required error={error ?? undefined}>
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={DISPLAY_NAME_MAX_LENGTH + 20}
                        autoComplete="name"
                        autoFocus
                    />
                </Field>
            </DialogBody>
            <DialogFooter>
                <Button type="button" variant="secondary" shape="square" onClick={onCancel} disabled={saving}>
                    {mode === 'prompt' ? 'Not now' : 'Cancel'}
                </Button>
                <Button type="submit" variant="primary" shape="square" loading={saving}>
                    Save
                </Button>
            </DialogFooter>
        </form>
    );
}
