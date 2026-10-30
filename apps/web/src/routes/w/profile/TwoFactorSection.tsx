import {
    Badge,
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    LoadingRegion,
    PasswordInput,
    Skeleton,
    toast,
} from '@bylinecrm/ui';
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import type { TwoFactorSetupView } from '../../../api/types';
import {
    useTwoFactorDisable,
    useTwoFactorEnable,
    useTwoFactorRecoveryCodes,
    useTwoFactorSetup,
    useTwoFactorStatus,
} from '../../../api/queries';
import { formatDate } from '../../../lib/format';

/**
 * Two-factor sign-in (2FA-1) on the person's own profile: whether it is on, since when, how many
 * recovery codes are left, and the ways to turn it on (scan, prove with one code, save the codes),
 * make new codes, or turn it off with the password.
 */
export function TwoFactorSection() {
    const status = useTwoFactorStatus();
    const setup = useTwoFactorSetup();
    const [enrolling, setEnrolling] = useState(0);
    const [codes, setCodes] = useState<string[] | null>(null);
    const [disabling, setDisabling] = useState(false);
    const [recoding, setRecoding] = useState(false);
    if (status.isError) throw status.error;
    const data = status.data;
    return (
        <section aria-labelledby="profile-2fa-title" className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 id="profile-2fa-title" className="m-0 mb-1 flex items-center gap-2 text-sm font-semibold">
                        <ShieldCheck aria-hidden className="size-4 text-text-muted" />
                        Two-factor sign-in
                        {data && (
                            <Badge dot shape="pill" status={data.enabled ? 'success' : 'neutral'}>
                                {data.enabled ? 'On' : 'Off'}
                            </Badge>
                        )}
                    </h3>
                    <p className="m-0 text-xs text-text-muted">
                        {!data
                            ? 'Checking…'
                            : data.enabled
                              ? `Signing in asks for a code from your authenticator app, since ${formatDate(data.enabledAt ?? '')}. ${data.recoveryCodesLeft} recovery ${data.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.`
                              : 'Add a code from an authenticator app to every sign-in, so a password alone cannot open your account.'}
                    </p>
                </div>
                {!data ? (
                    <LoadingRegion label="Loading two-factor status">
                        <Skeleton className="h-9 w-28" />
                    </LoadingRegion>
                ) : data.enabled ? (
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => setRecoding(true)}>
                            <KeyRound aria-hidden /> New recovery codes
                        </Button>
                        <Button variant="secondary" onClick={() => setDisabling(true)}>
                            <ShieldOff aria-hidden /> Turn off
                        </Button>
                    </div>
                ) : (
                    <Button
                        variant="primary"
                        loading={setup.isPending}
                        onClick={() => setup.mutate(undefined, { onSuccess: () => setEnrolling((n) => n + 1) })}
                    >
                        <ShieldCheck aria-hidden /> Turn on
                    </Button>
                )}
            </div>
            {setup.data && (
                <EnrolDialog
                    key={enrolling}
                    open={enrolling > 0}
                    setup={setup.data}
                    onClose={() => setEnrolling(0)}
                    onEnabled={(c) => {
                        setEnrolling(0);
                        setCodes(c);
                    }}
                />
            )}
            <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} />
            <PasswordDialog
                key={`off-${disabling}`}
                open={disabling}
                onClose={() => setDisabling(false)}
                title="Turn off two-factor sign-in"
                description="Your password confirms it is you. From then on a password alone signs you in."
                action="Turn off"
                destructive
                run={useTwoFactorDisable()}
                onDone={() => {
                    setDisabling(false);
                    toast({ title: 'Two-factor sign-in is off', tone: 'success' });
                }}
            />
            <PasswordDialog
                key={`codes-${recoding}`}
                open={recoding}
                onClose={() => setRecoding(false)}
                title="Make new recovery codes"
                description="Your password confirms it is you. The codes you have now stop working the moment the new ones exist."
                action="Make new codes"
                run={useTwoFactorRecoveryCodes()}
                onDone={(result) => {
                    setRecoding(false);
                    if (result && typeof result === 'object' && 'codes' in result) setCodes(result.codes);
                }}
            />
        </section>
    );
}

/** Scan, then prove the app with the first code it shows. Mounted fresh for every setup. */
function EnrolDialog({
    open,
    setup,
    onClose,
    onEnabled,
}: {
    open: boolean;
    setup: TwoFactorSetupView;
    onClose: () => void;
    onEnabled: (codes: string[]) => void;
}) {
    const enable = useTwoFactorEnable();
    const [qr, setQr] = useState<string | null>(null);
    const [code, setCode] = useState('');
    useEffect(() => {
        let live = true;
        void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 192 }).then((url) => {
            if (live) setQr(url);
        });
        return () => {
            live = false;
        };
    }, [setup.otpauthUrl]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        enable.mutate(code, { onSuccess: (r) => onEnabled(r.codes) });
    };
    const failure = enable.error instanceof ApiError ? enable.error : null;
    const message =
        failure?.code === 'two_factor.code_invalid'
            ? 'That code is not right. Wait for the next one and try again.'
            : failure
              ? failure.message
              : enable.isError
                ? 'Could not reach the server.'
                : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogTitle>Set up two-factor sign-in</DialogTitle>
                <DialogDescription>
                    Scan the code with an authenticator app such as Google Authenticator, 1Password or Authy, then enter
                    the six digits it shows.
                </DialogDescription>
                <form onSubmit={submit} noValidate>
                    <DialogBody className="flex flex-col gap-4 sm:flex-row">
                        <div className="grid size-48 shrink-0 place-items-center rounded-lg border border-border bg-white p-2">
                            {qr ? (
                                <img src={qr} alt="QR code for your authenticator app" className="size-full" />
                            ) : (
                                <Skeleton className="size-full" />
                            )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-3">
                            <div>
                                <p className="m-0 text-xs font-medium text-text-muted">Or type this key</p>
                                <code className="mt-1 block rounded-md bg-surface-raised px-2 py-1.5 text-xs break-all select-all">
                                    {setup.secret.match(/.{1,4}/g)?.join(' ')}
                                </code>
                            </div>
                            <Field label="Code from the app" required error={message}>
                                <Input
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    placeholder="123 456"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value)}
                                />
                            </Field>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={enable.isPending}>
                            Turn on
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The codes, shown once: copy or download them before closing. */
function RecoveryCodesDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
    const text = codes?.join('\n') ?? '';
    const download = () => {
        const url = URL.createObjectURL(new Blob([`BylineCRM recovery codes\n\n${text}\n`], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bylinecrm-recovery-codes.txt';
        a.click();
        URL.revokeObjectURL(url);
    };
    return (
        <Dialog open={codes !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogTitle>Save your recovery codes</DialogTitle>
                <DialogDescription>
                    Each works once, in place of your app, if you lose your phone. They are shown now and never again.
                </DialogDescription>
                <DialogBody>
                    <ul className="m-0 grid list-none grid-cols-2 gap-2 rounded-lg border border-border bg-surface-raised p-4 font-mono text-sm">
                        {codes?.map((c) => (
                            <li key={c} className="select-all">
                                {c}
                            </li>
                        ))}
                    </ul>
                </DialogBody>
                <DialogFooter>
                    <Button
                        variant="secondary"
                        onClick={() =>
                            void navigator.clipboard
                                .writeText(text)
                                .then(() => toast({ title: 'Copied', tone: 'success' }))
                        }
                    >
                        <Copy aria-hidden /> Copy
                    </Button>
                    <Button variant="secondary" onClick={download}>
                        <Download aria-hidden /> Download
                    </Button>
                    <Button variant="primary" onClick={onClose}>
                        I have saved them
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** A password-confirmed action: turning off, or new recovery codes. */
function PasswordDialog<T>({
    open,
    onClose,
    title,
    description,
    action,
    destructive = false,
    run,
    onDone,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    description: string;
    action: string;
    destructive?: boolean;
    run: {
        mutate: (password: string, opts: { onSuccess: (r: T) => void }) => void;
        isPending: boolean;
        error: unknown;
        reset: () => void;
    };
    onDone: (result: T) => void;
}) {
    const [password, setPassword] = useState('');
    const failure = run.error instanceof ApiError ? run.error : null;
    const message = failure?.status === 401 ? 'That is not your password.' : failure ? failure.message : null;
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        run.mutate(password, { onSuccess: onDone });
                    }}
                    noValidate
                >
                    <DialogBody>
                        <Field label="Your password" required error={message}>
                            <PasswordInput
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant={destructive ? 'danger' : 'primary'} loading={run.isPending}>
                            {action}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
