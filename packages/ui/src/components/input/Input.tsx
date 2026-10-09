import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

/** Shared by Input and Textarea so a field looks the same whatever its height. */
export const fieldClasses = [
    // 16px text below the phone breakpoint so iOS does not zoom the page on focus (FR-CRMS-UI-12).
    'w-full rounded-md border border-border bg-surface-raised px-3 text-base text-text md:text-sm',
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
    return <input ref={ref} type={type} className={cn(fieldClasses, 'h-9 max-md:h-11', className)} {...props} />;
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldClasses, 'min-h-20 py-2', className)} {...props} />;
});
