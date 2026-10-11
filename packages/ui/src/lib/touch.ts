/**
 * A small control (a 16px checkbox box, a 36×20 switch track) is too small to hit with a finger.
 * On a phone (below `md`, BREAKPOINT_PX.mobile) its button grows to the touch target
 * (`--bc-touch-target`, 44px) around what it shows, and negative margins of the same amount keep
 * the layout around it exactly as on a larger screen (FR-CRMS-UI-12). One definition per visual
 * size, so the two controls cannot drift apart. The control carries `group` and draws its visible
 * part — and its focus ring (`groupFocusRing`) — on a child.
 *
 * The button keeps the visible size as its own width and height (the phone minimum overrides
 * them): with no size of its own, a grid or flex parent stretches it and the centred box moves.
 */
export const phoneTouchArea = {
    /** Around a 1rem × 1rem box (Checkbox). */
    box: 'size-4 max-md:min-h-touch max-md:min-w-touch max-md:-m-[calc((var(--bc-touch-target)-1rem)/2)]',
    /** A row in a menu or a picker's list: at least the touch target tall on a phone. */
    row: 'max-md:min-h-touch',
    /** Around a 2.25rem × 1.25rem track (Switch). */
    track: 'h-5 w-9 max-md:min-h-touch max-md:min-w-touch max-md:-my-[calc((var(--bc-touch-target)-1.25rem)/2)] max-md:-mx-[calc((var(--bc-touch-target)-2.25rem)/2)]',
} as const;
