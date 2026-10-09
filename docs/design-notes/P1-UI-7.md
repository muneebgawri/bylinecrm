# P1-UI-7 — tables become cards on phones, and the gate enforces it

Issue #51. Doc 48 FR-CRMS-UI-12 (mobile-responsive, usable on a phone — owner, 2026-10-09).
Found by P0-10: on a 375px screen the settings tables (members, roles, API keys, invites) scrolled
sideways inside their card. That passed the page-scroll check but is unusable on a phone.

## One card, every list

- **`CardList`** (`packages/ui/src/components/card-list`) is the phone card: leading avatar or icon,
  a name line, one muted secondary line, meta stacked at the end, and the row's actions beside the
  body (never inside its button). It keeps the record lists' behaviour: a whole-card target ≥ 64px,
  long press (`LONG_PRESS_MS`) starts select mode on a touch screen, a tap toggles while choosing,
  and the next page loads when the end scrolls into view. It was lifted from P1-UI-2's
  `lists/ListCards.tsx`; that file now only maps a person or company to the card's slots.
- **`DataTableChrome` draws rows itself** when given `data` (`columns`, `rows`, `getRowId`,
  `rowActions`, `leading`, `label`, `loading`, `empty`): a `<table>` at and above
  `BREAKPOINT_PX.mobile`, `CardList` below it, from the same column definitions. `children` stays
  for a body the chrome cannot draw (the virtualised record list, which renders `CardList` itself on
  a phone).
- **Phone roles.** Each column may declare `phone: 'primary' | 'secondary' | 'meta' | 'hidden'`.
  Unset, the first column is primary, the next two secondary and the rest hidden (`phoneRoles()`),
  so a page gets a sensible card by declaring nothing. API keys hide "Created" and move "Status" to
  meta; invites move "Status" to meta.
- **Row actions are one "•••" menu** in both layouts (`rowActions: { label, items }`): a 44px
  target on a phone through the button's touch tokens, and a menu that can hold more than buttons
  (members' role picker). Roles, API keys and invites moved from inline Edit / Delete / Revoke
  buttons to the menu, matching the members table and the approved mockup.
- **Loading and empty** are the chrome's (`aria-busy` skeleton; the page's `empty` node), so the
  settings pages lost their copy of `TableSkeleton`.
- `layout: 'auto' | 'table' | 'cards'` forces one rendering for a story or test drawn at a fixed
  width (the design system's gates render at 1024px). Pages leave it on `auto`.

## The gate rule

`phoneTables()` in `apps/web/e2e/checks.ts`, run at phone widths: a finding for any visible
`table`, `[role=table]` or `[role=grid]`, and for any visible element that scrolls sideways
(`overflow-x` auto or scroll, content wider than the box) holding rows (`[role=row]` or a table).
A sideways-scrolling row of chips or tabs holds no rows and is allowed — the view and stage chips
are meant to scroll that way.

**Offenders on main** (phone-light): `settings`, `settingsMembers`, `settingsApiKeys`,
`settingsInvites`, `settingsRoles` — each "a table on a phone". **After:** none, in phone-light and
phone-dark.

## Not in this card

The deals list (`routes/w/deals/DealsList.tsx`) draws its own phone card with an inline stage
select. It is a second card pattern, not a table (the gate passes it), and belongs with #48, which
moves deals onto the shared list components.
