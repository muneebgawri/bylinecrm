import { Button } from '@bylinecrm/ui';
import type { ReactNode } from 'react';
import { auth } from '../../api/endpoints';
import { useProviders } from '../../api/queries';

/** Google's four-colour mark, as its sign-in branding asks for it beside "Continue with Google". */
function GoogleMark() {
    return (
        <svg aria-hidden viewBox="0 0 24 24" className="size-4 shrink-0">
            <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.55-5.17 3.55-8.87z"
            />
            <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z"
            />
            <path
                fill="#FBBC05"
                d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09z"
            />
            <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
            />
        </svg>
    );
}

const PROVIDERS: Record<string, { label: string; mark: ReactNode }> = {
    google: { label: 'Continue with Google', mark: <GoogleMark /> },
};

/**
 * One button per identity provider the deployment offers, and the "or" rule under them; none means
 * the section is absent. Google appears once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
 */
export function ProviderButtons() {
    const providers = useProviders();
    const list = providers.data?.providers ?? [];
    if (list.length === 0) return null;
    return (
        <div className="flex flex-col gap-3">
            {list.map((issuer) => {
                const p = PROVIDERS[issuer];
                return (
                    <Button key={issuer} asChild variant="secondary" shape="square" className="w-full">
                        <a href={auth.providerStartUrl(issuer)}>
                            {p?.mark}
                            {p?.label ?? `Continue with ${issuer}`}
                        </a>
                    </Button>
                );
            })}
            <div className="my-3 flex items-center gap-3 text-xs text-text-muted">
                <span className="h-px flex-1 bg-border" />
                OR
                <span className="h-px flex-1 bg-border" />
            </div>
        </div>
    );
}
