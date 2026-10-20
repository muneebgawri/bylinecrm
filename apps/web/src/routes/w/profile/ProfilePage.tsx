import { DISPLAY_NAME_MAX_LENGTH } from '@bylinecrm/shared';
import { Button, Field, Input, LoadingRegion, PageHeader, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useProfile, useUpdateProfile } from '../../../api/queries';
import { useCan, useMembership } from '../../../auth/capabilities';
import { useWorkspaceId } from '../../params';
import { DetailsForm, OwnMailboxSignatures } from '../settings/Signatures';

/**
 * The person's own profile, from the account menu: every member's way to their name, the details their
 * signature reads (title, phone, socials, Slotline) and the signatures of their own mailboxes. The same
 * forms and endpoints as Settings → Signatures, which only an admin reaches from the sidebar; nothing here
 * shows another member's details or a workspace setting, and the admin's locks show as locked.
 */
export function ProfilePage() {
    const workspaceId = useWorkspaceId();
    const memberId = useMembership()?.memberId ?? null;
    const readsMailboxes = useCan('mailbox:read');
    return (
        <div className="p-7">
            <PageHeader
                title="Profile"
                subtitle="Your name, the details your signature shows, and the signature of each of your mailboxes."
            />
            <div className="mt-5 flex max-w-3xl flex-col gap-6">
                <NameSection />
                {memberId ? (
                    <>
                        <DetailsForm workspaceId={workspaceId} memberId={memberId} />
                        {readsMailboxes ? (
                            <OwnMailboxSignatures workspaceId={workspaceId} memberId={memberId} />
                        ) : (
                            <p className="m-0 text-[13px] text-text-muted">
                                Your role cannot see mailboxes, so it has no signatures to set.
                            </p>
                        )}
                    </>
                ) : (
                    <LoadingRegion label="Loading your details" className="h-24" />
                )}
            </div>
        </div>
    );
}

function NameSection() {
    const profile = useProfile();
    if (profile.isError) throw profile.error;
    if (!profile.data) return <LoadingRegion label="Loading your name" className="h-16" />;
    return (
        <NameForm
            key={profile.data.displayName ?? ''}
            name={profile.data.displayName ?? ''}
            email={profile.data.email}
        />
    );
}

function NameForm({ name: initial, email }: { name: string; email: string }) {
    const update = useUpdateProfile();
    const [name, setName] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return setError('Enter the name your team should see.');
        if (trimmed.length > DISPLAY_NAME_MAX_LENGTH)
            return setError(`Keep it to ${DISPLAY_NAME_MAX_LENGTH} characters.`);
        setError(null);
        update.mutate(trimmed, {
            onSuccess: () => toast({ title: 'Name saved', tone: 'success' }),
            onError: (failure) =>
                setError(
                    fieldErrorAt(failure, 'displayName') ??
                        (failure instanceof ApiError ? failure.message : 'The server could not be reached.'),
                ),
        });
    };
    return (
        <section aria-labelledby="profile-name-title" className="rounded-lg border border-border bg-surface p-4">
            <h3 id="profile-name-title" className="m-0 mb-1 text-sm font-semibold">
                Your name
            </h3>
            <p className="m-0 mb-3 text-xs text-text-muted">
                Shown to the people in every workspace you belong to. You sign in as {email}.
            </p>
            <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
                <Field label="Name" required error={error ?? undefined} className="min-w-0 flex-1">
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={DISPLAY_NAME_MAX_LENGTH + 20}
                        autoComplete="name"
                    />
                </Field>
                <Button type="submit" shape="square" loading={update.isPending}>
                    Save name
                </Button>
            </form>
        </section>
    );
}
