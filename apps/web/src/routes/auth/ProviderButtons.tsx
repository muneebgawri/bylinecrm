import { Button } from '@bylinecrm/ui';
import { auth } from '../../api/endpoints';
import { useProviders } from '../../api/queries';

const LABELS: Record<string, string> = { google: 'Continue with Google' };

/** One button per identity provider the deployment offers; none means the section is absent. */
export function ProviderButtons() {
    const providers = useProviders();
    const list = providers.data?.providers ?? [];
    if (list.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            {list.map((issuer) => (
                <Button key={issuer} asChild shape="square" className="w-full">
                    <a href={auth.providerStartUrl(issuer)}>{LABELS[issuer] ?? `Continue with ${issuer}`}</a>
                </Button>
            ))}
            <div className="my-2 flex items-center gap-3 text-xs text-text-faint">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
            </div>
        </div>
    );
}
