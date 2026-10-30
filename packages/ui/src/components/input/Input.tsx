import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

/** Shared by Input and Textarea so a field looks the same whatever its height. */
export const fieldClasses = [
    // On phones: 16px text (iOS zooms into anything smaller) — FR-CRMS-UI-12.
    'w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-text max-md:text-touch',
    'placeholder:text-text-faint hover:border-border-strong',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'aria-[invalid=true]:border-danger',
    focusRing,
];

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
    { className, type = 'text', ...props },
    ref,
) {
    return <input ref={ref} type={type} className={cn(fieldClasses, 'h-9 max-md:h-touch', className)} {...props} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldClasses, 'min-h-20 py-2', className)} {...props} />;
});

/** A password field with a show/hide toggle at its end; the toggle never submits the form. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(function PasswordInput(
    { className, ...props },
    ref,
) {
    const [shown, setShown] = useState(false);
    return (
        <div className="relative">
            <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-10', className)} {...props} />
            <button
                type="button"
                onClick={() => setShown((v) => !v)}
                aria-label={shown ? 'Hide password' : 'Show password'}
                aria-pressed={shown}
                className={cn(
                    'absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-sm text-text-faint hover:text-text max-md:size-touch',
                    focusRing,
                )}
            >
                {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            </button>
        </div>
    );
});
