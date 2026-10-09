import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface WelcomeFact {
    label: string;
    value: ReactNode;
}

export interface WelcomePanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
    /** A chip above the heading: "Rules worked overnight · 2 deals moved". */
    chip?: ReactNode;
    title: ReactNode;
    body?: ReactNode;
    facts?: readonly WelcomeFact[];
    actions?: ReactNode;
}

/** The soft-gradient hero at the top of the dashboard. */
export const WelcomePanel = forwardRef<HTMLElement, WelcomePanelProps>(function WelcomePanel(
    { className, chip, title, body, facts, actions, ...props },
    ref,
) {
    return (
        <section
            ref={ref}
            className={cn(
                'mb-4 flex flex-wrap items-center gap-6 rounded-lg border border-border bg-gradient-to-br from-accent-soft via-surface to-surface px-6 py-5.5',
                className,
            )}
            {...props}
        >
            <div className="min-w-0">
                {chip}
                <h2 className={cn('m-0 text-[22px] font-semibold tracking-tight', chip && 'mt-2')}>{title}</h2>
                {body && <p className="m-0 mt-1.5 max-w-[52ch] text-text-muted">{body}</p>}
                {facts && facts.length > 0 && (
                    <dl className="mt-3.5 flex flex-wrap gap-7">
                        {facts.map((fact) => (
                            <div key={fact.label}>
                                <dt className="text-[11px] font-medium tracking-[0.06em] text-text-faint uppercase">
                                    {fact.label}
                                </dt>
                                <dd className="mt-0.5 text-xl font-semibold tabular-nums">{fact.value}</dd>
                            </div>
                        ))}
                    </dl>
                )}
            </div>
            {actions && <div className="ml-auto flex gap-2">{actions}</div>}
        </section>
    );
});
