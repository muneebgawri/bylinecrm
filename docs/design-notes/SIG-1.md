# SIG-1 — Email signatures (#193)

Owner request 2026-10-18, with the logo and Slotline pre-fills added the same day. Depends on P2-3 (the one
MIME builder and the send path), P2-4 (the template serializer and its subset), P3-1 (the locked outreach
footer) and CAL-2 (the Slotline site's address).

**Scope:** a signature per mailbox, a workspace default, an admin's locks, the company logo served publicly,
each member's booking link, a Gmail import, and the signature in every 1:1 send, reply and sequence step. Not
here: per-template overrides, rotating signatures, signature analytics, image uploads other than the logo.

## One mechanism: a signature belongs to a mailbox, and the renderer adds it

| Concern                            | Where                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What a signature may hold          | `SIGNATURE_NODES` in `@bylinecrm/shared`: the template subset plus `image` (https only, width ≤ 600). Checked on save by `signatureProblems` (`subsetProblems`, the templates' own walk, with a node check of its own)   |
| How it becomes email               | `renderSignature`: the serializer's one walk (`renderRichText`) with two opt-ins — images, and dropping a line left with nothing on it. Attributes are never copied but an image's src, alt and capped width             |
| Which one a mailbox's mail carries | `effectiveSignature`: the mailbox's own; else the workspace default unless the mailbox switched it off; else none                                                                                                        |
| Where it goes                      | `composeEmail(…, signature)`: after the body; in the text part after the `-- ` line; before an outreach email's footer, which stays last and unchanged (FR-CRMS-7/12)                                                    |
| Which renders choose it            | `RenderTarget.signature` (`SignatureChoice`): `mailbox` (a sequence step from its pool mailbox; a 1:1 send left as is), `message` (the composer's edited or removed one), `default` (a template preview with no mailbox) |
| Who may read or change it          | `signableMailbox`: a member their own personal mailbox, an admin any; a pool mailbox's is an admin's. Another workspace's mailbox is `404`                                                                               |

The composer shows the mailbox's signature under the message and sends nothing about it while it is left
alone, so the server applies the mailbox's — a template sent as filled stays that template (`sendsAsTemplate`
is unchanged), and a scheduled send stores `signature` in its request only when the member changed it. The
composer has no quoted text; a reply's signature therefore sits at the end, which is above where quoted text
would be.

`{{sender.signature}}`, the template variable P2-4 reserved, still renders empty: the signature is added by the
renderer after the body, never through a variable, so a template that names it does not get a second one.

## Variables

`SIGNATURE_VARIABLES`: `sender.fullName`, `sender.firstName`, `sender.title`, `sender.phone`,
`sender.bookingLink`, `workspace.name`, `workspace.logo`. The issue's `{{sender.name}}` is the registry's
existing `sender.fullName` (one name per thing). None blocks a send: an empty one renders empty, and the line
it leaves with nothing on it is left out — a member with no booking link gets no "Book a quick meeting" line.
`sender.*` reads the sending mailbox's member (a pool mailbox's owner, as P3-3 already speaks as).

Title and phone are new `workspace_members` columns, set in Settings → Signatures by the member or an admin.

## The two pre-fills (owner 2026-10-18)

`SIGNATURE_STARTER` — name and title, phone, `{{sender.bookingLink}}`, `{{workspace.logo}}` — is where every
signature starts: the workspace default when an admin first sets it, and a mailbox's own when its member first
writes one (from the default, when there is one). A workspace has no default until an admin saves one, so
deploying this changes no mail anyone sends.

- **Logo.** `workspace_logos`: an admin uploads PNG, JPEG or SVG of at most 200 KB; `sharp` reads it (SVG is
  rasterised) and stores a PNG at most 300 px wide. It is served by `GET /api/public/logos/<token>.png` — public,
  `Cache-Control: public`, the 32-byte token the only key, found through the owner client as the unsubscribe
  page finds its token. A new upload retires the current one; a retired token answers for `LOGO_GRACE_DAYS` (30)
  for mail already sent, and its bytes are removed with the next upload after that. The bytes go to storage
  before the transaction that records them and are removed after the one that forgets them. `alt` is the
  workspace's name.
- **Booking link.** `workspace_members.slotline_username`; the link is `{baseUrl}/{username}` while Slotline is
  set up — never guessed from an address. A pool mailbox links to the page an admin picks
  (`mailboxes.booking_link`), which must sit on the Slotline site's origin.
- **Locks.** `lock_logo`, `lock_booking_link`: while on, every saved signature — the default, a mailbox's, and
  one a message carries — must name the variable, and "no signature" is refused (`422`). The composer hides
  "Remove signature" while anything is locked.

## Import from Gmail

`POST /mailboxes/:id/signature/import` reads `users.settings.sendAs.list` — Google's reference lists
`gmail.readonly`, which every mailbox already holds, so no scope is added — for the mailbox's own address,
through `MailSyncService.gmailRequest` (the mailbox's token, its quota, retries), with no transaction open.
`signatureFromHtml` converts the HTML with the same allowlist: lines, bold, italic, `https:`/`mailto:` links,
https images with a capped width; a table read row by row; scripts, styles and handlers never survive. It saves
nothing: the member edits and saves the draft, and from then on the CRM's copy is the one used.

## Where it is enforced, and tested

| Rule                                                                                                      | Test                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Rendering, empty lines, image caps; the subset on save                                                    | `render-signature.spec.ts`                          |
| Gmail HTML → the subset                                                                                   | `gmail-signature.spec.ts`                           |
| Settings, logo, profile, mailbox signatures, locks, sends, preview, import, across workspaces and members | `test/cross-tenant/signatures.spec.ts`              |
| A sequence step: the pool mailbox's signature above the footer                                            | `test/cross-tenant/sequences.spec.ts` (`#193`)      |
| Settings → Signatures; the composer's signature                                                           | `Signatures.spec.tsx`, `Composer.spec.tsx` (`#193`) |
