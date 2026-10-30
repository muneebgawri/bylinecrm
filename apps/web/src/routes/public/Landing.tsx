import { Button, cn } from '@bylinecrm/ui';
import {
    ArrowRight,
    BarChart3,
    Building2,
    CalendarDays,
    Handshake,
    Inbox,
    ListOrdered,
    MailCheck,
    Moon,
    Search,
    ShieldCheck,
    Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { CSRF_COOKIE } from '@bylinecrm/shared';
import { readCookie } from '../../api/client';
import { useMe, useProviders } from '../../api/queries';
import { LogoMark } from '../../shell/LogoMark';
import { step } from '../auth/AuthLayout';
import { paths } from '../paths';

const FEATURES: { icon: ReactNode; tone: string; title: string; body: string }[] = [
    {
        icon: <Users />,
        tone: 'bg-tile-info',
        title: 'People and companies',
        body: 'Every relationship on one record: who they are, who owns them, what was said, what is next.',
    },
    {
        icon: <Handshake />,
        tone: 'bg-tile-accent',
        title: 'Pipeline',
        body: 'Deals on a board or a list, with stage rules, probability and the reasons deals are lost.',
    },
    {
        icon: <ListOrdered />,
        tone: 'bg-tile-success',
        title: 'Sequences',
        body: 'Outreach that sends from a pool of mailboxes and stops itself on a reply, a bounce or a stage change.',
    },
    {
        icon: <MailCheck />,
        tone: 'bg-tile-warning',
        title: 'Verified before it sends',
        body: 'Addresses are verified and suppression lists honoured before a sequence can reach anyone.',
    },
    {
        icon: <Inbox />,
        tone: 'bg-tile-danger',
        title: 'Mail and calendar in',
        body: 'Connect Gmail and Google Calendar: replies, meetings and new leads land on the right records.',
    },
    {
        icon: <BarChart3 />,
        tone: 'bg-tile-neutral',
        title: 'Reports',
        body: 'Pipeline health, win rate, forecast and the team’s results, from the same numbers the pages use.',
    },
    {
        icon: <CalendarDays />,
        tone: 'bg-tile-info',
        title: 'Calendar and tasks',
        body: 'Meetings, follow-ups and close dates on one calendar, with what needs you today on the dashboard.',
    },
    {
        icon: <Search />,
        tone: 'bg-tile-accent',
        title: 'Search everywhere',
        body: 'Press ⌘K: people, companies, deals, pages and commands from anywhere in the app.',
    },
    {
        icon: <ShieldCheck />,
        tone: 'bg-tile-success',
        title: 'Roles and scope',
        body: 'Each member sees what their role allows, down to which records are theirs to open.',
    },
];

/**
 * The front door for a visitor who is not signed in: what the product is, what it does, and the
 * ways in. Someone already signed in goes straight to their workspaces.
 */
export function Landing() {
    // Only ask who is signed in when a session cookie pair exists: asking while signed out is a 401,
    // and a 401 anywhere sends the person to sign-in — away from the page they came to read.
    const maybeSignedIn = readCookie(CSRF_COOKIE) !== undefined;
    const me = useMe(maybeSignedIn);
    const signupOpen = useProviders().data?.signup === 'open';
    if (me.isSuccess) return <Navigate to={paths.workspaces} replace />;
    if (maybeSignedIn && me.isPending) return null;
    return (
        <div className="relative min-h-dvh overflow-hidden bg-background text-text">
            <header className="absolute inset-x-0 top-0 z-20">
                <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
                    <Link
                        to={paths.root}
                        className="hero-in flex items-center gap-2 max-md:min-h-touch"
                        style={step(0)}
                    >
                        <LogoMark />
                        <span className="text-lg font-semibold tracking-tight">BylineCRM</span>
                    </Link>
                    <nav className="hero-in flex items-center gap-2" style={step(1)}>
                        <Button asChild variant="ghost">
                            <Link to={paths.signIn}>Sign in</Link>
                        </Button>
                        {signupOpen && (
                            <Button asChild variant="primary">
                                <Link to={paths.signUp}>
                                    Create a workspace <ArrowRight aria-hidden />
                                </Link>
                            </Button>
                        )}
                    </nav>
                </div>
            </header>

            <main>
                <section className="relative isolate overflow-hidden">
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 text-border-strong [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(900px_circle_at_50%_30%,white,transparent)]"
                    />
                    <div className="mx-auto max-w-7xl px-4 pt-28 sm:px-6 sm:pt-32 lg:px-8 lg:pt-36">
                        <div className="mx-auto max-w-4xl text-center">
                            <div className="hero-in" style={step(0)}>
                                <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 py-1 pr-3.5 pl-1 text-xs font-medium shadow-sm backdrop-blur">
                                    <span className="rounded-full bg-primary px-2.5 py-1 text-primary-foreground">
                                        CRM
                                    </span>
                                    Built for PR and newswire teams
                                </span>
                            </div>
                            <h1
                                className="hero-in m-0 text-4xl font-medium leading-[1.04] tracking-[-0.04em] text-balance sm:text-5xl lg:text-6xl"
                                style={step(1)}
                            >
                                Pipeline, outreach and mail
                                <br />
                                <span className="text-text-muted">in one place.</span>
                            </h1>
                            <p
                                className="hero-in mx-auto mt-6 max-w-2xl text-base leading-7 text-pretty text-text-muted sm:text-lg"
                                style={step(2)}
                            >
                                BylineCRM keeps people, companies, deals, sequences and mail together, so your team
                                works from one record of every relationship and never emails anyone it should not.
                            </p>
                            <div
                                className="hero-in mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row"
                                style={step(3)}
                            >
                                {signupOpen ? (
                                    <Button asChild variant="primary" size="lg" className="h-11 px-6 shadow-lg">
                                        <Link to={paths.signUp}>
                                            Create a workspace <ArrowRight aria-hidden />
                                        </Link>
                                    </Button>
                                ) : (
                                    <Button asChild variant="primary" size="lg" className="h-11 px-6 shadow-lg">
                                        <Link to={paths.signIn}>
                                            Sign in <ArrowRight aria-hidden />
                                        </Link>
                                    </Button>
                                )}
                                <Button asChild variant="secondary" size="lg" className="h-11 px-6">
                                    <Link to={paths.signIn}>I already have an account</Link>
                                </Button>
                            </div>
                        </div>
                        <div className="hero-in mx-auto mt-16 max-w-5xl" style={step(5)}>
                            <Preview />
                        </div>
                    </div>
                </section>

                <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
                    <div className="mx-auto max-w-2xl text-center">
                        <p className="m-0 text-xs font-semibold tracking-wider text-text-muted uppercase">Features</p>
                        <h2 className="m-0 mt-3 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
                            Everything a sales and PR team needs, nothing it does not.
                        </h2>
                        <p className="m-0 mt-4 text-base leading-7 text-text-muted">
                            One system of record from first touch to won deal, with the sending safeguards built in.
                        </p>
                    </div>
                    <div className="mt-14 grid overflow-hidden rounded-xl border border-border bg-surface sm:grid-cols-2 lg:grid-cols-3">
                        {FEATURES.map((f) => (
                            <div
                                key={f.title}
                                className="border-b border-border p-6 transition-colors hover:bg-surface-raised/60 sm:border-r sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(3n)]:border-r-0 lg:[&:nth-last-child(-n+3)]:border-b-0"
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        'grid size-10 place-items-center rounded-lg text-white shadow-sm [&_svg]:size-5',
                                        f.tone,
                                    )}
                                >
                                    {f.icon}
                                </span>
                                <h3 className="m-0 mt-4 text-base font-semibold">{f.title}</h3>
                                <p className="m-0 mt-1.5 text-sm leading-6 text-text-muted">{f.body}</p>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="mx-auto max-w-7xl px-4 pb-24 sm:px-6 lg:px-8">
                    <div className="relative overflow-hidden rounded-xl border border-border bg-primary px-6 py-14 text-center text-primary-foreground sm:px-12">
                        <div
                            aria-hidden
                            className="pointer-events-none absolute inset-0 text-primary-foreground/20 [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px]"
                        />
                        <div className="relative">
                            <h2 className="m-0 text-3xl font-medium tracking-tight sm:text-4xl">
                                Bring your pipeline here.
                            </h2>
                            <p className="m-0 mt-3 text-base text-primary-foreground/80">
                                Import from Bigin or Twenty, connect a mailbox, and your team is working the same day.
                            </p>
                            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                                <Button asChild variant="secondary" size="lg" className="h-11 px-6">
                                    <Link to={signupOpen ? paths.signUp : paths.signIn}>
                                        {signupOpen ? 'Create a workspace' : 'Sign in'} <ArrowRight aria-hidden />
                                    </Link>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            <footer className="border-t border-border">
                <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-text-muted sm:flex-row sm:px-6 lg:px-8">
                    <span className="flex items-center gap-2">
                        <LogoMark /> © {new Date().getFullYear()} BylineCRM
                    </span>
                    <span className="flex items-center gap-4">
                        <Moon aria-hidden className="size-4" />
                        Light and dark, on every screen
                    </span>
                </div>
            </footer>
        </div>
    );
}

/** A drawn impression of the app: the sidebar, a header row and a few cards. Decorative. */
function Preview() {
    return (
        <div aria-hidden className="overflow-hidden rounded-xl border border-border bg-background p-2 shadow-lg">
            <div className="grid min-h-80 grid-cols-[180px_1fr] gap-2">
                <div className="flex flex-col gap-2 p-2">
                    <div className="h-7 w-28 rounded-md bg-surface-raised" />
                    {['Dashboard', 'Reports', 'People', 'Companies', 'Deals', 'Sequences'].map((l, i) => (
                        <div
                            key={l}
                            className={cn(
                                'h-7 rounded-md px-2 text-[11px] leading-7 text-text-muted',
                                i === 4 && 'border border-border bg-surface text-text shadow-sm',
                            )}
                        >
                            {l}
                        </div>
                    ))}
                </div>
                <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm">
                    <div className="flex items-center justify-between">
                        <div className="h-5 w-32 rounded bg-surface-raised" />
                        <div className="h-7 w-20 rounded-full bg-primary" />
                    </div>
                    <div className="grid grid-cols-4 gap-3">
                        {['$191K', '3', '50%', '24d'].map((v, i) => (
                            <div key={i} className="rounded-lg border border-border p-3">
                                <div className="h-2.5 w-14 rounded bg-surface-raised" />
                                <div className="mt-2 text-lg font-semibold">{v}</div>
                            </div>
                        ))}
                    </div>
                    <div className="grid flex-1 grid-cols-4 gap-3">
                        {[Building2, Handshake, Users, CalendarDays].map((Icon, i) => (
                            <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                                <Icon className="size-4 text-text-muted" />
                                <div className="h-2.5 w-20 rounded bg-surface-raised" />
                                <div className="h-2.5 w-12 rounded bg-surface-raised" />
                                <div className="mt-auto h-1 w-full rounded-full bg-surface-raised">
                                    <div className="h-full w-2/3 rounded-full bg-primary" />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
