import type { ReactNode } from 'react';
import { LogoMark } from '../../shell/LogoMark';

/** The centred card every signed-out screen sits in: logo mark, title, body. */
export function AuthLayout({
    title,
    subtitle,
    children,
}: {
    title: string;
    subtitle?: ReactNode;
    children: ReactNode;
}) {
    return (
        <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-text">
            <div className="w-full max-w-100">
                <div className="mb-6 flex flex-col items-center gap-3 text-center">
                    <LogoMark size="lg" />
                    <div>
                        <h1 className="m-0 text-2xl font-semibold tracking-tight">{title}</h1>
                        {subtitle && <p className="m-0 mt-1 text-text-muted">{subtitle}</p>}
                    </div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">{children}</div>
            </div>
        </main>
    );
}
