import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@bylinecrm/ui';
import type { ReactNode } from 'react';

/** One section of a settings form: a card with a title, a line under it, and the fields. */
export function SettingsSection({
    title,
    description,
    children,
    className,
    ...props
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
    disabled?: boolean;
}) {
    return (
        <Card className={cn('gap-5', className)}>
            <CardHeader>
                <CardTitle className="text-base">{title}</CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent>
                <fieldset className="m-0 flex flex-col gap-4 border-0 p-0" disabled={props.disabled}>
                    <legend className="sr-only">{title}</legend>
                    {children}
                </fieldset>
            </CardContent>
        </Card>
    );
}

/**
 * The bar that follows a settings form down the page: says whether there is anything to save,
 * offers to reset, and carries the one Save button.
 */
export function SettingsSaveBar({
    dirty,
    saving,
    onReset,
    saveLabel = 'Save changes',
}: {
    dirty: boolean;
    saving: boolean;
    onReset?: () => void;
    saveLabel?: string;
}) {
    return (
        <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface/95 px-5 py-3.5 shadow-lg backdrop-blur-sm">
            <p className="m-0 text-sm text-text-muted" aria-live="polite">
                {dirty ? 'You have unsaved changes.' : 'Everything is saved.'}
            </p>
            <div className="flex items-center gap-2">
                {onReset && (
                    <Button type="button" variant="secondary" size="sm" disabled={!dirty || saving} onClick={onReset}>
                        Reset
                    </Button>
                )}
                <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    data-primary-action
                    loading={saving}
                    disabled={!dirty}
                >
                    {saveLabel}
                </Button>
            </div>
        </div>
    );
}
