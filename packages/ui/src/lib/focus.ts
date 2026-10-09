/**
 * The focus ring every interactive component shows for keyboard users — one definition, so
 * "what focus looks like" cannot drift between a button and a checkbox.
 */
export const focusRing =
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * The same ring on a row that holds a focused control it hides — a radio row whose native input is
 * visually hidden, so the ring belongs on the row the person sees.
 */
export const focusWithinRing =
    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background';
