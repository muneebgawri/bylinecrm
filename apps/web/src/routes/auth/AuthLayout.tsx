import { cn } from '@bylinecrm/ui';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import { LogoMark } from '../../shell/LogoMark';
import { paths } from '../paths';

/** The left column on a wide screen: an eyebrow chip, a big heading, a line of copy. */
export interface AuthHero {
    eyebrow: string;
    heading: ReactNode;
    body: string;
}

/** What every signed-out page says beside the form unless it has something more specific. */
export const DEFAULT_HERO: AuthHero = {
    eyebrow: 'Pipeline, outreach and mail in one place',
    heading: (
        <>
            Run your pipeline <span className="text-accent">smarter.</span>
        </>
    ),
    body: 'BylineCRM keeps people, companies, deals, sequences and mail together, so your team works from one record of every relationship.',
};

/** Staggers the entrance of the layout's pieces; `n` is the step, 70ms apart. */
export const step = (n: number) => ({ '--i': n }) as CSSProperties;

/**
 * The layout every signed-out screen uses: a dotted backdrop, the mark and a counterpart link in
 * the header, the product's pitch on the left and the form card on the right (the card alone on a
 * phone). The card's title is the page's one `h1`; the hero heading is decoration.
 */
export function AuthLayout({
    title,
    subtitle,
    aside,
    hero = DEFAULT_HERO,
    icon,
    children,
}: {
    title: string;
    subtitle?: ReactNode;
    /** The header's way elsewhere: "New here? Create a workspace". */
    aside?: ReactNode;
    hero?: AuthHero;
    /** A tile above the card's title, for the mailed-link pages. */
    icon?: ReactNode;
    children: ReactNode;
}) {
    return (
        <AuthFrame aside={aside} hero={hero}>
            <div
                className="hero-in w-full rounded-xl border border-border bg-surface/90 p-7 shadow-lg backdrop-blur-md sm:p-8"
                style={step(2)}
            >
                {icon && (
                    <div className="mb-6 flex size-12 items-center justify-center rounded-lg border border-border bg-surface-raised text-text [&>svg]:size-5">
                        {icon}
                    </div>
                )}
                <h1 className="m-0 text-xl font-semibold tracking-tight">{title}</h1>
                {subtitle ? (
                    <p className="m-0 mt-1.5 mb-7 text-sm text-text-muted">{subtitle}</p>
                ) : (
                    <div className="mb-7" />
                )}
                {children}
            </div>
        </AuthFrame>
    );
}

/** The frame without the card: the skeleton draws its own card into it while a page's code loads. */
export function AuthFrame({
    aside,
    hero = DEFAULT_HERO,
    children,
}: {
    aside?: ReactNode;
    hero?: AuthHero;
    children: ReactNode;
}) {
    return (
        <div className="relative flex min-h-dvh flex-col overflow-hidden bg-background text-text">
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 text-border-strong [background-image:radial-gradient(currentColor_1px,transparent_1px)] [background-size:16px_16px] [mask-image:radial-gradient(700px_circle_at_center,white,transparent)]"
            />
            <header className="relative z-20 flex h-20 items-center justify-between px-6 lg:px-12">
                <Link
                    to={paths.signIn}
                    className="hero-in flex items-center gap-2 text-sm font-semibold"
                    style={step(0)}
                >
                    <LogoMark />
                    BylineCRM
                </Link>
                {aside && (
                    <p className="hero-in m-0 text-sm text-text-muted" style={step(1)}>
                        {aside}
                    </p>
                )}
            </header>
            <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
                <div className="grid w-full max-w-5xl items-center gap-12 lg:grid-cols-[1fr_380px] lg:gap-16">
                    <section aria-hidden className="hidden lg:block">
                        <div
                            className="hero-in mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1.5 text-xs text-text-muted backdrop-blur-sm"
                            style={step(1)}
                        >
                            <span className="size-1.5 rounded-full bg-accent" />
                            {hero.eyebrow}
                        </div>
                        <p
                            className="hero-in m-0 max-w-xl text-4xl font-semibold tracking-tight xl:text-5xl"
                            style={step(2)}
                        >
                            {hero.heading}
                        </p>
                        <p className="hero-in m-0 mt-6 max-w-lg text-base leading-7 text-text-muted" style={step(3)}>
                            {hero.body}
                        </p>
                    </section>
                    {children}
                </div>
            </main>
            <footer className="hero-in relative z-20 px-6 pt-4 pb-6 text-xs text-text-muted lg:px-12" style={step(4)}>
                © {new Date().getFullYear()} BylineCRM
            </footer>
        </div>
    );
}

/** The text link in the header and under a card: "Sign in", "Create a workspace". */
export const authLinkClass = cn('font-medium text-text underline underline-offset-4 hover:text-accent');
