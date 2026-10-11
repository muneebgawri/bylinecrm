# P2-UI-3 — Google setup, mailbox connection, sync status and the blocklist

Issue #61. Doc 50 §E (the four-step "Connect Google Workspace" and the mailbox rows), doc 48 FR-CRMS-1
(mailbox connection), D-237 (the customer's own OAuth client), FR-CRMS-2 (sync, the blocklist),
FR-CRMS-UI-6/7/12. Built on P2-1's and P2-2's API; no API change.

## Routes

| Path                     | Who                    | What                                                     |
| ------------------------ | ---------------------- | -------------------------------------------------------- |
| `/w/:id/settings/google` | admin (others: status) | The four setup steps; verify; remove the client          |
| `/w/:id/mailboxes`       | `mailbox:read`         | Mailboxes, their status and sync; connect; the blocklist |

`paths.settingsGoogle` is new (the routes gate visits it); `/mailboxes` replaces its placeholder and is
its own lazy chunk. Settings gains a "Google" section (`workspace:admin`). Palette: "Connect a mailbox"
(→ `/mailboxes?create=1`), "Google setup"; "Mailboxes" already comes from the nav.

## Google setup (doc 50 §E)

1. **Create the client in Google Cloud** — a checklist (Gmail API on; consent screen **Internal**;
   exactly the scopes the API reports in `scopes`; never `https://mail.google.com/`) and the redirect
   URI from the API with a Copy button.
2. **Enter the client** — client ID and secret. The secret is write-only: after a save the page drops
   it from memory and shows only `•••• last4` (the API never returns more). Replace reopens the form.
3. **Verify** — `POST …/verify`; each step (client ID format, client ID and secret, redirect URI) with
   its outcome and the API's message. The page says plainly that Google confirms the redirect URI only
   at a sign-in, so it reads "Not yet confirmed" until the first mailbox connects (`verifiedAt`).
4. **Connect mailboxes** — a link to Mailboxes and how many mailboxes use the client.

Removing the client is confirmed in the page; the API refuses while mailboxes use it and the dialog
shows its words. A client write stores the view the API answers with (no refetch) and refreshes the
status; a member who is not an admin reads only `/status` — "Your admin has set up Google" or "Google
isn't set up yet — ask an admin" — and never requests the client's details.

## Mailboxes

Rows: address (label on a desktop), status (Connected / Reconnect needed / Disconnected), sync
(`GET …/sync` per mailbox — "Synced 3 minutes ago", "Syncing now", "Sync failed: …"; for a mailbox
waiting to be reconnected, the reason it stopped), purpose, owner ("You" for your own). Actions for the
owner or an admin (`mailbox:manage`, as the API checks): Sync now, Check connection, Reconnect,
Disconnect (confirmed in the page; the toast says whether Google confirmed the revoke). No sending-health
numbers — limits, bounces and warm-up are outreach's (Phase 3); one line says so.

**Connect** opens a sheet: Personal or Shared outreach (fixed once chosen — said in the sheet), then
`POST …/connect` and `leaveFor(authorizeUrl)` (`lib/leaveFor.ts`, the one place the app leaves itself).
The API's callback returns to `/mailboxes?connect=<result>`; every result in `MAILBOX_CONNECT_RESULTS`
has a title and what to do (`connectResults.ts`, a `Record` over the shared list, so a new result is a
type error until it has words). The result is announced once (a ref: effects run twice in development)
and taken off the URL; after `connected` the newest connected mailbox is marked "Just connected" (the
callback names no mailbox).

**Blocklist**: a member's own entries and, for an admin, the workspace's. Adding validates with the
shared `normaliseBlocklistValue` (the API's own rule) and sends the normalised value; the toast says how
much stored mail the entry removed ("Removed 12 messages from 4 threads.", or "No stored mail was
covered."), and timelines are refreshed. Unblocking says removed mail does not come back.

## One of each

`components/CopyValue.tsx` replaces the API-keys page's `SecretOnce` (now used by API keys, invites and
the redirect URI): clipboard written inside the click, the value selected when that is refused, the
result announced. `components/GoogleStatus.tsx` is the one status notice (settings, Mailboxes).

## Phone (FR-CRMS-UI-12)

Mailboxes and the blocklist are cards through `DataTableChrome`'s data mode; the connect and block
sheets are the design system's bottom sheets; copy buttons are 44px. The runner's first screenshot showed
a mailbox card clipping its address and cutting its reason short — the card keeps each line to one row —
so the address line holds only the address, the reason sits in the sync line ("Paused — …" on a desktop,
the reason alone on a phone beside the "Reconnect needed" badge), and purpose and owner join the card's
wrapping second line. Measured at 375px in both themes: nothing clipped, no sideways scroll, no target
under 44px, no field text under 16px.

## Not here

Setting a mailbox label (the API allows it; no screen asks for it yet); per-mailbox detail and sending
health (Phase 3); a real Google sign-in in tests (the API's fake port covers the flow; the owner's real
test is listed in the corpus memory).
