import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The one class-merging helper. Conditional classes via clsx, conflicting utilities resolved by tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
