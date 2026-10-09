import { ApiError } from '../api/client';

/** The message for a failed request: the API's own words when it sent some. */
export function failureText(error: unknown): string {
    if (error instanceof ApiError) return error.fieldErrors[0]?.message ?? error.message;
    return error instanceof Error ? error.message : 'Something went wrong.';
}
