import { Button, EmptyState, PageHeader } from '@bylinecrm/ui';
import { Building2, FileText, Inbox, LayoutDashboard, ListOrdered, BarChart3, Users, UsersRound } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useCan } from '../../auth/capabilities';

/**
 * The content pages this package does not build (dashboard, people and companies are
 * P1-UI-2/3; deals landed with P1-UI-4; outreach is Phase 3). Each is a designed empty state with the right words, so the
 * shell, nav, breadcrumbs and permissions are real end to end before the content lands.
 */
interface PageSpec {
    title: string;
    subtitle: string;
    icon: React.ReactNode;
    empty: string;
    body: string;
    /** The page's primary action, when its capability allows. */
    action?: { label: string; requires: Parameters<typeof useCan>[0] };
    coming: string;
}

const PAGES = {
    home: {
        title: 'Dashboard',
        subtitle: 'Your pipeline, outreach and what needs attention today.',
        icon: <LayoutDashboard />,
        empty: 'Nothing to show yet',
        body: 'KPIs, the queue and the pipeline overview arrive with the records and the mail.',
        coming: 'P1-UI-2',
    },
    reports: {
        title: 'Reports',
        subtitle: 'Conversion, time in stage and sending health.',
        icon: <BarChart3 />,
        empty: 'No reports yet',
        body: 'Reports are built on the pipeline and outreach data as they land.',
        coming: 'Phase 3',
    },
    people: {
        title: 'People',
        subtitle: 'Leads and contacts in your portfolio. Verified before they are ever emailed.',
        icon: <Users />,
        empty: 'No people yet',
        body: 'Add a person, or import a list; every address is verified before any sequence can reach it.',
        action: { label: 'Add person', requires: 'record:write' },
        coming: 'P1-UI-2',
    },
    companies: {
        title: 'Companies',
        subtitle: 'Accounts, with their people, deals and NewswireOS history.',
        icon: <Building2 />,
        empty: 'No companies yet',
        body: 'A company is created from a person’s work domain or added by hand.',
        action: { label: 'Add company', requires: 'record:write' },
        coming: 'P1-UI-2',
    },
    sequences: {
        title: 'Sequences',
        subtitle: 'Drips with waits, stop conditions and a send window.',
        icon: <ListOrdered />,
        empty: 'No sequences yet',
        body: 'A sequence stops itself on a reply, a bounce, an unsubscribe or a stage change.',
        coming: 'Phase 3',
    },
    templates: {
        title: 'Templates',
        subtitle: 'Variable chips, live preview, locked compliance blocks.',
        icon: <FileText />,
        empty: 'No templates yet',
        body: 'A missing variable blocks the send; it is never rendered blank.',
        coming: 'Phase 2',
    },
    mailboxes: {
        title: 'Mailboxes',
        subtitle: 'Outreach is spread across these mailboxes; a mailbox pauses itself past the threshold.',
        icon: <Inbox />,
        empty: 'No mailbox connected',
        body: 'Connect a Google Workspace mailbox through your own OAuth client.',
        coming: 'Phase 2',
    },
    team: {
        title: 'Team',
        subtitle: 'Account managers, their portfolios and results.',
        icon: <UsersRound />,
        empty: 'No portfolio data yet',
        body: 'Results appear once deals are won and mail is sent.',
        coming: 'Phase 3',
    },
} as const satisfies Record<string, PageSpec>;

export type PageId = keyof typeof PAGES;

export function ContentPage({ id }: { id: PageId }) {
    const page: PageSpec = PAGES[id];
    const [params] = useSearchParams();
    const allowed = useCan(page.action?.requires ?? 'record:read');
    const creating = params.get('create');
    return (
        <div className="p-7">
            <PageHeader
                title={page.title}
                subtitle={page.subtitle}
                actions={
                    page.action && allowed ? (
                        <Button
                            data-primary-action
                            variant="primary"
                            shape="square"
                            disabled
                            title={`Arrives with ${page.coming}`}
                        >
                            {page.action.label}
                        </Button>
                    ) : undefined
                }
            />
            <EmptyState
                icon={page.icon}
                title={
                    creating
                        ? `Creating a ${creating === '1' ? page.title.toLowerCase().replace(/s$/, '') : creating} arrives with ${page.coming}`
                        : page.empty
                }
                body={page.body}
            />
        </div>
    );
}
