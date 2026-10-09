import { cloneElement, isValidElement, useId, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
    label: string;
    /** Under the control, muted. */
    hint?: ReactNode;
    /** The validation message; when set the control is marked invalid and described by it. */
    error?: ReactNode;
    required?: boolean;
    /** The one control: an Input, Textarea, Select trigger — it receives the id and aria wiring. */
    children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string; required?: boolean }>;
}

/**
 * Label + control + hint/error, wired for assistive tech: the label names the control, the error
 * describes it and marks it invalid. A form is a stack of these; the API's field errors land in
 * `error` by path.
 */
export function Field({ label, hint, error, required, children, className, ...props }: FieldProps) {
    const id = useId();
    const describedBy =
        [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
    const wiring: { id: string; required?: boolean; 'aria-invalid'?: boolean; 'aria-describedby'?: string } = { id };
    if (required) wiring.required = true;
    if (error) wiring['aria-invalid'] = true;
    if (describedBy) wiring['aria-describedby'] = describedBy;
    const control = isValidElement(children) ? cloneElement(children, wiring) : children;
    return (
        <div className={cn('flex flex-col gap-1.5', className)} {...props}>
            <label htmlFor={id} className="text-[13px] font-medium text-text">
                {label}
                {required && (
                    <span aria-hidden className="text-danger">
                        {' '}
                        *
                    </span>
                )}
            </label>
            {control}
            {hint && !error && (
                <p id={`${id}-hint`} className="m-0 text-xs text-text-muted">
                    {hint}
                </p>
            )}
            {error && (
                <p id={`${id}-error`} role="alert" className="m-0 text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
