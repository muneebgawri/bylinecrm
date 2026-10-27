import {
    LOGO_MAX_BYTES,
    LOGO_MIME_TYPES,
    SIGNATURE_LOCKABLE,
    SIGNATURE_VARIABLES,
    SOCIAL_NETWORKS,
    SOCIAL_NETWORK_HOSTS,
    SOCIAL_NETWORK_LABEL,
    type SocialLinks,
    type MailboxSignatureView,
    type RichText,
    type SignatureLockable,
    type SignatureProfileView,
    type SignatureSettingsView,
} from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
    Field,
    Input,
    LoadingRegion,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    buttonVariants,
    cn,
    toast,
} from '@bylinecrm/ui';
import { Lock } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import { useMailboxes } from '../../../api/mailAdmin';
import {
    useImportSignature,
    useMailboxSignature,
    usePutMailboxSignature,
    usePutSignatureProfile,
    usePutSignatureSettings,
    usePickSlotlineEvent,
    useSignatureProfile,
    useSignatureProfiles,
    useSlotlineEventTypes,
    useSlotlineKey,
    useSignatureSettings,
    useWorkspaceLogo,
} from '../../../api/signatures';
import type { MailboxView } from '../../../api/types';
import { useCan, useMembership } from '../../../auth/capabilities';
import { RichTextEditor, type RichTextHandle } from '../../../components/rich-text/RichTextEditor';
import { failureText } from '../../../lib/errors';
import { useWorkspaceId } from '../../params';
import { SelectField } from './fields';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

const APPLIES_TEXT: Record<MailboxSignatureView['applies'], string> = {
    own: 'Its own signature',
    default: 'The workspace signature',
    none: 'No signature',
};

const LOCK_LABEL: Record<SignatureLockable, string> = { logo: 'Lock the logo', bookingLink: 'Lock the booking link' };

/**
 * Settings → Signatures (#193). Every member sets what their signature reads of them — title, phone, their
 * Slotline username for "Book a quick meeting" — and the signature of each of their mailboxes, written here
 * or imported from Gmail. An admin also uploads the company logo, sets the workspace signature any mailbox
 * without its own carries, locks the two pre-fills into every signature, and signs the pool mailboxes.
 */
export function Signatures() {
    const workspaceId = useWorkspaceId();
    const memberId = useMembership()?.memberId ?? null;
    const isAdmin = useCan('workspace:admin');
    const settings = useSignatureSettings(workspaceId);
    const mailboxes = useMailboxes(workspaceId);
    if (settings.isError) throw settings.error;
    if (mailboxes.isError) throw mailboxes.error;
    const live = (mailboxes.data ?? []).filter((m) => m.status !== 'disconnected');
    const own = live.filter((m) => m.purpose === 'personal' && m.ownerMemberId === memberId);
    const pool = isAdmin ? live.filter((m) => m.purpose === 'pool') : [];

    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="flex max-w-3xl flex-col gap-6">
            <div>
                <p className="m-0 max-w-[70ch] text-[13px] text-text-muted">
                    A signature goes at the end of the mail a mailbox sends — your own emails and replies, and a
                    sequence’s steps above the unsubscribe footer. Every signature starts with the company logo and your
                    “Book a quick meeting” link.
                </p>
            </div>
            {memberId && <DetailsForm workspaceId={workspaceId} memberId={memberId} />}
            {isAdmin && <MembersDetails workspaceId={workspaceId} selfId={memberId} />}
            {!settings.data || !mailboxes.data ? (
                <LoadingRegion label="Loading signatures" className="h-24" />
            ) : (
                <>
                    {isAdmin && <LogoSection workspaceId={workspaceId} settings={settings.data} />}
                    {isAdmin && (
                        <WorkspaceSignature
                            key={JSON.stringify(settings.data.defaultSignature)}
                            workspaceId={workspaceId}
                            settings={settings.data}
                        />
                    )}
                    <MailboxList
                        title="Your mailboxes"
                        empty="Connect a mailbox under Mailboxes to give it a signature."
                        workspaceId={workspaceId}
                        mailboxes={own}
                        settings={settings.data}
                    />
                    {pool.length > 0 && (
                        <MailboxList
                            title="Pool mailboxes"
                            workspaceId={workspaceId}
                            mailboxes={pool}
                            settings={settings.data}
                        />
                    )}
                </>
            )}
        </section>
    );
}

/**
 * The signed-in member's own mailboxes and their signatures (#193), with the admin's locks named: what the
 * Profile page (from the account menu) shows every member, and Settings → Signatures shows too.
 */
export function OwnMailboxSignatures({ workspaceId, memberId }: { workspaceId: string; memberId: string }) {
    const settings = useSignatureSettings(workspaceId);
    const mailboxes = useMailboxes(workspaceId);
    if (settings.isError) throw settings.error;
    if (mailboxes.isError) throw mailboxes.error;
    if (!settings.data || !mailboxes.data) return <LoadingRegion label="Loading your signatures" className="h-24" />;
    const own = mailboxes.data.filter(
        (m) => m.status !== 'disconnected' && m.purpose === 'personal' && m.ownerMemberId === memberId,
    );
    return (
        <MailboxList
            title="Your signatures"
            empty="Connect a mailbox under Mailboxes to give it a signature."
            workspaceId={workspaceId}
            mailboxes={own}
            settings={settings.data}
        />
    );
}

/** What an admin locked into every signature, named with why it cannot be taken out; nothing when none is. */
export function LockedNotice({ locked }: { locked: SignatureSettingsView['locked'] }) {
    const names = SIGNATURE_LOCKABLE.filter((l) => locked[l]).map((l) => LOCKED_NAME[l]);
    if (names.length === 0) return null;
    return (
        <p role="note" className="m-0 flex items-start gap-2 text-[13px] text-text-muted">
            <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
                Locked by an admin: {names.join(' and ')} {names.length === 1 ? 'stays' : 'stay'} in every signature, so
                the workspace’s mail looks the same — a signature without {names.length === 1 ? 'it' : 'them'} is not
                saved.
            </span>
        </p>
    );
}

const LOCKED_NAME: Record<SignatureLockable, string> = {
    logo: 'the company logo',
    bookingLink: 'the “Book a quick meeting” link',
};

export function DetailsForm({ workspaceId, memberId }: { workspaceId: string; memberId: string }) {
    const profile = useSignatureProfile(workspaceId, memberId);
    if (profile.isError) throw profile.error;
    if (!profile.data) return <LoadingRegion label="Loading your details" className="h-24" />;
    return (
        <section aria-labelledby="signature-details-title" className="rounded-lg border border-border bg-surface p-4">
            <h3 id="signature-details-title" className="m-0 mb-3 text-sm font-semibold">
                Your details
            </h3>
            <DetailsFields
                key={JSON.stringify(profile.data)}
                workspaceId={workspaceId}
                memberId={memberId}
                profile={profile.data}
                own
            />
            {profile.data.slotlineConfigured && (
                <SlotlineAccount workspaceId={workspaceId} memberId={memberId} profile={profile.data} />
            )}
        </section>
    );
}

/** The value the picker gives "Your Slotline page": a Select item cannot have an empty value. */
const PROFILE_PAGE = '__page';

/**
 * The member's own Slotline account (#196): their API key — kept once Slotline accepts it, shown by its last
 * four after — and, with it, every event type on the account, hidden ones too, to choose what "Book a quick
 * meeting" opens.
 */
function SlotlineAccount({
    workspaceId,
    memberId,
    profile,
}: {
    workspaceId: string;
    memberId: string;
    profile: SignatureProfileView;
}) {
    const key = useSlotlineKey(workspaceId, memberId);
    const pick = usePickSlotlineEvent(workspaceId, memberId);
    const types = useSlotlineEventTypes(workspaceId, memberId, profile.slotlineKey !== null);
    const [apiKey, setApiKey] = useState('');
    const options =
        types.data ??
        (profile.slotlineEvent ? [{ ...profile.slotlineEvent, lengthInMinutes: null, hidden: false }] : []);
    return (
        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4">
            <h4 className="m-0 text-[13px] font-semibold">Slotline account</h4>
            {profile.slotlineKey ? (
                <>
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span>
                            Connected as {profile.slotlineUsername} · Key ending {profile.slotlineKey.last4}
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            loading={key.isPending}
                            onClick={() =>
                                key.mutate(null, {
                                    onError: (e) =>
                                        toast({
                                            title: 'The key was not removed',
                                            description: failureText(e),
                                            tone: 'danger',
                                        }),
                                })
                            }
                        >
                            Remove key
                        </Button>
                    </div>
                    <SelectField
                        label="Book a quick meeting opens"
                        value={profile.slotlineEvent?.slug ?? PROFILE_PAGE}
                        onValueChange={(value) =>
                            pick.mutate(value === PROFILE_PAGE ? null : value, {
                                onSuccess: () => toast({ title: 'Booking link saved', tone: 'success' }),
                                onError: (e) =>
                                    toast({
                                        title: 'The booking link was not saved',
                                        description: failureText(e),
                                        tone: 'danger',
                                    }),
                            })
                        }
                        options={[
                            { value: PROFILE_PAGE, label: 'Your Slotline page' },
                            ...options.map((t) => ({
                                value: t.slug,
                                label: [
                                    t.title,
                                    t.lengthInMinutes ? `${t.lengthInMinutes} min` : null,
                                    t.hidden ? 'hidden' : null,
                                ]
                                    .filter(Boolean)
                                    .join(' · '),
                            })),
                        ]}
                        hint={
                            types.isError
                                ? `Your event types could not be listed: ${failureText(types.error)}`
                                : 'Every event type on your Slotline account, hidden ones too — a hidden one is bookable by its link.'
                        }
                    />
                </>
            ) : (
                <form
                    noValidate
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        key.mutate(apiKey.trim(), {
                            onSuccess: () => {
                                setApiKey('');
                                toast({ title: 'Slotline account connected', tone: 'success' });
                            },
                        });
                    }}
                >
                    <Field
                        label="Slotline API key"
                        hint="Create one in Slotline under Settings → Developer → API keys. With it the CRM lists all your event types, hidden ones too; only its last four characters are shown again."
                        error={key.error ? (fieldErrorAt(key.error, 'apiKey') ?? failureText(key.error)) : undefined}
                        className="min-w-0 flex-1"
                    >
                        <Input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                    </Field>
                    <Button
                        type="submit"
                        variant="secondary"
                        shape="square"
                        loading={key.isPending}
                        disabled={apiKey.trim() === ''}
                    >
                        Connect Slotline account
                    </Button>
                </form>
            )}
        </div>
    );
}

/** An admin's list of the other members' details (#193): to set a member's Slotline username for them. */
function MembersDetails({ workspaceId, selfId }: { workspaceId: string; selfId: string | null }) {
    const profiles = useSignatureProfiles(workspaceId);
    const [open, setOpen] = useState<string | null>(null);
    if (profiles.isError) throw profiles.error;
    const others = (profiles.data ?? []).filter((p) => p.memberId !== selfId);
    return (
        <section aria-label="Members’ details" className="rounded-lg border border-border bg-surface p-4">
            <h3 className="m-0 mb-1 text-sm font-semibold">Members’ details</h3>
            <p className="m-0 mb-3 text-[13px] text-text-muted">
                What each member’s signature reads of them. Set a Slotline username for a member who has not.
            </p>
            {!profiles.data ? (
                <LoadingRegion label="Loading members’ details" className="h-16" />
            ) : others.length === 0 ? (
                <p className="m-0 text-[13px] text-text-muted">No other members yet.</p>
            ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
                    {others.map((p) => {
                        const name = p.name ?? 'A member';
                        return (
                            <li key={p.memberId} className="py-2.5 first:pt-0 last:pb-0">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                    <span className="min-w-0 flex-1 text-[13px] font-medium">{name}</span>
                                    <span className="text-xs text-text-muted">
                                        {p.slotlineUsername
                                            ? `Slotline: ${p.slotlineUsername}`
                                            : 'No Slotline username'}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        shape="square"
                                        aria-expanded={open === p.memberId}
                                        aria-label={`Edit ${name}’s details`}
                                        onClick={() => setOpen((o) => (o === p.memberId ? null : p.memberId))}
                                    >
                                        {open === p.memberId ? 'Close' : 'Edit'}
                                    </Button>
                                </div>
                                {open === p.memberId && (
                                    <div className="mt-3">
                                        <DetailsFields
                                            key={JSON.stringify(p)}
                                            workspaceId={workspaceId}
                                            memberId={p.memberId}
                                            profile={p}
                                            own={false}
                                        />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

function DetailsFields({
    workspaceId,
    memberId,
    profile,
    own,
}: {
    workspaceId: string;
    memberId: string;
    profile: SignatureProfileView;
    /** The caller's own details, or a member's an admin sets. */
    own: boolean;
}) {
    const put = usePutSignatureProfile(workspaceId, memberId);
    const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? '');
    const [phone, setPhone] = useState(profile.phone ?? '');
    const [username, setUsername] = useState(profile.slotlineUsername ?? '');
    const [socials, setSocials] = useState<SocialLinks>(profile.socials);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        put.mutate(
            {
                jobTitle: jobTitle.trim() || null,
                phone: phone.trim() || null,
                slotlineUsername: username.trim() || null,
                // Only the networks filled in: an empty one is no icon.
                socials: Object.fromEntries(
                    SOCIAL_NETWORKS.flatMap((n) => (socials[n]?.trim() ? [[n, socials[n]!.trim()]] : [])),
                ) as SocialLinks,
            },
            {
                onSuccess: () => toast({ title: 'Details saved', tone: 'success' }),
                onError: (e) => toast({ title: 'Details were not saved', description: failureText(e), tone: 'danger' }),
            },
        );
    };
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <div className="grid gap-4 md:grid-cols-2">
                <Field label="Job title" error={fieldErrorAt(put.error, 'jobTitle')}>
                    <Input
                        value={jobTitle}
                        onChange={(e) => setJobTitle(e.target.value)}
                        autoComplete={own ? 'organization-title' : 'off'}
                    />
                </Field>
                <Field label="Phone" error={fieldErrorAt(put.error, 'phone')}>
                    <Input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        autoComplete={own ? 'tel' : 'off'}
                    />
                </Field>
            </div>
            <Field
                label="Slotline username"
                hint={
                    profile.slotlineKey
                        ? 'From the connected Slotline account.'
                        : profile.slotlineConfigured
                          ? `${own ? 'Your' : 'Their'} booking page is the Slotline site followed by this. Without it, ${own ? 'your' : 'their'} signature leaves out “Book a quick meeting”.`
                          : 'Slotline is not set up yet: an admin connects it under Settings → Slotline.'
                }
                error={fieldErrorAt(put.error, 'slotlineUsername')}
            >
                <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    readOnly={profile.slotlineKey !== null}
                    autoComplete="off"
                    spellCheck={false}
                    className="max-w-[20rem]"
                />
            </Field>
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
                <legend className="mb-1 text-[13px] font-medium">Social profiles</legend>
                <p className="m-0 -mt-1 text-xs text-text-muted">
                    Each one filled in shows as an icon in {own ? 'your' : 'their'} signature, linking to the profile.
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                    {SOCIAL_NETWORKS.map((network) => (
                        <Field
                            key={network}
                            label={SOCIAL_NETWORK_LABEL[network]}
                            error={fieldErrorAt(put.error, `socials.${network}`)}
                        >
                            <Input
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={`https://${SOCIAL_NETWORK_HOSTS[network][0]}/…`}
                                value={socials[network] ?? ''}
                                onChange={(e) => setSocials((all) => ({ ...all, [network]: e.target.value }))}
                            />
                        </Field>
                    ))}
                </div>
            </fieldset>
            {profile.bookingLink && (
                <p className="m-0 text-[13px] text-text-muted">
                    {own ? 'Your booking link:' : 'Booking link:'}{' '}
                    <a
                        href={profile.bookingLink}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-accent underline-offset-2 hover:underline"
                    >
                        {profile.bookingLink}
                    </a>
                </p>
            )}
            <div>
                <Button type="submit" shape="square" loading={put.isPending}>
                    Save details
                </Button>
            </div>
        </form>
    );
}

function LogoSection({ workspaceId, settings }: { workspaceId: string; settings: SignatureSettingsView }) {
    const logo = useWorkspaceLogo(workspaceId);
    const inputId = useId();
    const pick = (file: File | undefined) => {
        if (!file) return;
        if (!(LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
            toast({ title: 'Choose a PNG or JPEG file', tone: 'danger' });
            return;
        }
        if (file.size > LOGO_MAX_BYTES) {
            toast({ title: `A logo is at most ${Math.round(LOGO_MAX_BYTES / 1024)} KB`, tone: 'danger' });
            return;
        }
        logo.mutate(file, {
            onSuccess: () => toast({ title: 'Logo saved', tone: 'success' }),
            onError: (e) => toast({ title: 'The logo was not saved', description: failureText(e), tone: 'danger' }),
        });
    };
    return (
        <section aria-label="Company logo" className="rounded-lg border border-border bg-surface p-4">
            <h3 className="m-0 mb-1 text-sm font-semibold">Company logo</h3>
            <p className="m-0 mb-3 text-[13px] text-text-muted">
                Shown in every signature that has the logo. It is served from a public address, so recipients’ mail apps
                show it; replacing it keeps the old one working for 30 days for mail already sent.
            </p>
            <div className="flex flex-wrap items-center gap-3">
                {settings.logo ? (
                    <img
                        src={settings.logo.url}
                        alt="Company logo"
                        width={settings.logo.width}
                        height={settings.logo.height}
                        className="h-auto max-h-20 w-auto max-w-full rounded border border-border bg-white p-1"
                    />
                ) : (
                    <span className="text-[13px] text-text-faint">No logo yet.</span>
                )}
                <label
                    htmlFor={inputId}
                    className={cn(
                        buttonVariants({ variant: 'secondary', size: 'sm', shape: 'square' }),
                        'cursor-pointer',
                    )}
                >
                    {settings.logo ? 'Replace' : 'Upload a logo'}
                    <span className="sr-only"> (PNG or JPEG, at most 200 KB)</span>
                </label>
                <input
                    id={inputId}
                    type="file"
                    accept={LOGO_MIME_TYPES.join(',')}
                    className="sr-only"
                    aria-label="Upload a logo (PNG or JPEG, at most 200 KB)"
                    disabled={logo.isPending}
                    onChange={(e) => {
                        pick(e.target.files?.[0]);
                        e.target.value = '';
                    }}
                />
                {settings.logo && (
                    <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        disabled={logo.isPending}
                        onClick={() => logo.mutate(null)}
                    >
                        Remove
                    </Button>
                )}
            </div>
        </section>
    );
}

function WorkspaceSignature({ workspaceId, settings }: { workspaceId: string; settings: SignatureSettingsView }) {
    const put = usePutSignatureSettings(workspaceId);
    const [draft, setDraft] = useState<RichText | null>(settings.defaultSignature);
    const [editing, setEditing] = useState(false);
    const [locked, setLocked] = useState(settings.locked);
    const save = (defaultSignature: RichText | null, nextLocked = locked) =>
        put.mutate(
            { defaultSignature, locked: nextLocked },
            {
                onSuccess: () => {
                    setEditing(false);
                    toast({ title: 'Workspace signature saved', tone: 'success' });
                },
                onError: (e) =>
                    toast({
                        title: 'The workspace signature was not saved',
                        description: failureText(e),
                        tone: 'danger',
                    }),
            },
        );
    return (
        <section aria-label="Workspace signature" className="rounded-lg border border-border bg-surface p-4">
            <h3 className="m-0 mb-1 text-sm font-semibold">Workspace signature</h3>
            <p className="m-0 mb-3 text-[13px] text-text-muted">
                Carried by every mailbox without a signature of its own, unless its member switches it off.
            </p>
            {editing && draft ? (
                <div className="flex flex-col gap-3">
                    <SignatureField label="Workspace signature" value={draft} onChange={setDraft} />
                    <fieldset className="m-0 flex flex-wrap gap-x-5 gap-y-2 border-0 p-0">
                        <legend className="mb-1 text-[13px] font-medium">Keep in every signature</legend>
                        {(Object.keys(LOCK_LABEL) as SignatureLockable[]).map((lock) => (
                            <LockBox
                                key={lock}
                                label={LOCK_LABEL[lock]}
                                checked={locked[lock]}
                                onChange={(on) => setLocked((l) => ({ ...l, [lock]: on }))}
                            />
                        ))}
                    </fieldset>
                    <div className="flex flex-wrap gap-2">
                        <Button shape="square" loading={put.isPending} onClick={() => save(draft)}>
                            Save workspace signature
                        </Button>
                        <Button variant="ghost" shape="square" onClick={() => setEditing(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px]">{settings.defaultSignature ? 'Set' : 'No workspace signature'}</span>
                    {Object.values(settings.locked).some(Boolean) && <Badge>Locked pre-fills</Badge>}
                    <Button
                        variant="secondary"
                        size="sm"
                        shape="square"
                        onClick={() => {
                            setDraft(settings.defaultSignature ?? settings.starter);
                            setEditing(true);
                        }}
                    >
                        {settings.defaultSignature ? 'Edit' : 'Set a workspace signature'}
                    </Button>
                    {settings.defaultSignature && (
                        <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            disabled={put.isPending}
                            onClick={() => save(null, { logo: false, bookingLink: false })}
                        >
                            Remove
                        </Button>
                    )}
                </div>
            )}
        </section>
    );
}

function LockBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
    const id = useId();
    return (
        <span className="inline-flex items-center gap-2 max-md:min-h-touch">
            <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
            <label htmlFor={id} className="text-[13px]">
                {label}
            </label>
        </span>
    );
}

function MailboxList({
    title,
    empty,
    workspaceId,
    mailboxes,
    settings,
}: {
    title: string;
    empty?: string;
    workspaceId: string;
    mailboxes: readonly MailboxView[];
    settings: SignatureSettingsView;
}) {
    const id = useId();
    const starter = settings.starter;
    return (
        <section aria-labelledby={id} className="flex flex-col gap-3">
            <h3 id={id} className="m-0 text-sm font-semibold">
                {title}
            </h3>
            {mailboxes.length > 0 && <LockedNotice locked={settings.locked} />}
            {mailboxes.length === 0 && empty && <p className="m-0 text-[13px] text-text-muted">{empty}</p>}
            {mailboxes.map((m) => (
                <MailboxSignatureCard key={m.id} workspaceId={workspaceId} mailbox={m} starter={starter} />
            ))}
        </section>
    );
}

function MailboxSignatureCard({
    workspaceId,
    mailbox,
    starter,
}: {
    workspaceId: string;
    mailbox: MailboxView;
    starter: RichText;
}) {
    const view = useMailboxSignature(workspaceId, mailbox.id);
    if (view.isError) throw view.error;
    return (
        <section aria-label={mailbox.email} className="rounded-lg border border-border bg-surface p-4">
            <h4 className="m-0 mb-2 break-all text-[13px] font-semibold">{mailbox.email}</h4>
            {view.data ? (
                <MailboxSignatureForm workspaceId={workspaceId} mailbox={mailbox} view={view.data} starter={starter} />
            ) : (
                <LoadingRegion label={`Loading the signature of ${mailbox.email}`} className="h-12" />
            )}
        </section>
    );
}

function MailboxSignatureForm({
    workspaceId,
    mailbox,
    view,
    starter,
}: {
    workspaceId: string;
    mailbox: MailboxView;
    view: MailboxSignatureView;
    starter: RichText;
}) {
    const put = usePutMailboxSignature(workspaceId, mailbox.id);
    const importer = useImportSignature(workspaceId, mailbox.id);
    const [draft, setDraft] = useState<RichText | null>(null);
    // The editor takes its content when it mounts: an import remounts it.
    const [generation, setGeneration] = useState(0);
    const [note, setNote] = useState<string | null>(null);
    const [bookingLink, setBookingLink] = useState(view.bookingLink ?? '');
    const pool = mailbox.purpose === 'pool';

    const save = (own: RichText | null, useDefault = view.useDefault, link?: string) =>
        put.mutate(
            { own, useDefault, ...(pool && link !== undefined ? { bookingLink: link.trim() || null } : {}) },
            {
                onSuccess: () => {
                    setDraft(null);
                    setNote(null);
                    toast({ title: 'Signature saved', tone: 'success' });
                },
                onError: (e) =>
                    toast({ title: 'The signature was not saved', description: failureText(e), tone: 'danger' }),
            },
        );
    const edit = (doc: RichText) => {
        setDraft(doc);
        setGeneration((g) => g + 1);
    };

    return (
        <div className="flex flex-col gap-3">
            <p className="m-0 text-[13px] text-text-muted">{APPLIES_TEXT[view.applies]}</p>
            {draft ? (
                <>
                    <SignatureField
                        key={generation}
                        label={`Signature for ${mailbox.email}`}
                        value={draft}
                        onChange={setDraft}
                    />
                    {note && <p className="m-0 text-xs text-text-muted">{note}</p>}
                    <div className="flex flex-wrap gap-2">
                        <Button shape="square" loading={put.isPending} onClick={() => save(draft)}>
                            Save signature
                        </Button>
                        <Button variant="ghost" shape="square" onClick={() => setDraft(null)}>
                            Cancel
                        </Button>
                    </div>
                </>
            ) : (
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        shape="square"
                        onClick={() => edit(view.own ?? view.effective ?? starter)}
                    >
                        {view.own ? 'Edit its signature' : 'Write its own signature'}
                    </Button>
                    {!pool && (
                        <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            loading={importer.isPending}
                            onClick={() =>
                                importer.mutate(undefined, {
                                    onSuccess: (imported) => {
                                        edit(imported.signature ?? { type: 'doc', content: [{ type: 'paragraph' }] });
                                        setNote(
                                            imported.droppedImages === 0
                                                ? imported.signature
                                                    ? null
                                                    : 'Gmail has no signature for this mailbox.'
                                                : `${imported.droppedImages} ${imported.droppedImages === 1 ? 'image' : 'images'} not on https ${imported.droppedImages === 1 ? 'was' : 'were'} left out.`,
                                        );
                                    },
                                    onError: (e) =>
                                        toast({
                                            title: 'Gmail’s signature was not imported',
                                            description: failureText(e),
                                            tone: 'danger',
                                        }),
                                })
                            }
                        >
                            Import from Gmail
                        </Button>
                    )}
                    {view.own && (
                        <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            disabled={put.isPending}
                            onClick={() => save(null)}
                        >
                            Remove its own
                        </Button>
                    )}
                </div>
            )}
            <label className="inline-flex items-center gap-2 text-[13px] max-md:min-h-touch">
                <Switch
                    checked={view.useDefault}
                    disabled={put.isPending}
                    onCheckedChange={(on) => save(view.own, on)}
                    aria-label="Use the workspace signature when it has none of its own"
                />
                Use the workspace signature when it has none of its own
            </label>
            {pool && (
                <form
                    noValidate
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        save(view.own, view.useDefault, bookingLink);
                    }}
                >
                    <Field
                        label="Booking page"
                        hint="The Slotline page its “Book a quick meeting” links to."
                        error={fieldErrorAt(put.error, 'bookingLink')}
                        className="min-w-0 flex-1"
                    >
                        <Input
                            type="url"
                            inputMode="url"
                            value={bookingLink}
                            onChange={(e) => setBookingLink(e.target.value)}
                            placeholder="https://"
                            spellCheck={false}
                        />
                    </Field>
                    <Button type="submit" variant="secondary" shape="square" loading={put.isPending}>
                        Save booking page
                    </Button>
                </form>
            )}
        </div>
    );
}

/** The signature editor with its variables offered: what the logo and the booking link are, by name. */
function SignatureField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: RichText;
    onChange: (doc: RichText) => void;
}) {
    const handle = useRef<RichTextHandle>(null);
    return (
        <div className="flex flex-col gap-2">
            <RichTextEditor profile="signature" value={value} onChange={onChange} aria-label={label} handle={handle} />
            <div className="max-w-64">
                <Select value="" onValueChange={(path) => handle.current?.insertVariable(path)}>
                    <SelectTrigger aria-label="Insert into the signature" className="h-8 text-[13px] max-md:h-touch">
                        <SelectValue placeholder="Insert…" />
                    </SelectTrigger>
                    <SelectContent>
                        {SIGNATURE_VARIABLES.map((v) => (
                            <SelectItem key={v.path} value={v.path}>
                                {v.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}
