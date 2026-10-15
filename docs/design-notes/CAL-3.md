# CAL-3 — Only customers count: suggested leads and the KPI rule

**Owner, 2026-10-15:** "Need a better way to handle this issue: unwanted leads — a dinner with a friend or a
vendor pitch someone accepts still creates leads" and "For a meeting to be included in the KPIs, the customer
must first be saved in the CRM and assigned to that employee."

Builds on CAL-1 (calendar sync) and CAL-2 (Slotline). Replaces CAL-1's "every outside attendee becomes a lead".

## The KPI rule

A meeting counts towards a member's KPIs — booked, booked via Slotline, held, upcoming, cancelled, people met —
only while **one of its outside attendees is a live person that member owns**. It is read at query time, not
stored: assigning a person to another member moves the credit with them, deleting the person takes it away, and
adding a suggested lead makes the meetings with them count at once. Two figures say what is not counted:

- `awaitingCustomer` — meetings in the period the member attended that do not count yet;
- `suggestedLeads` — attendees waiting for the member to add or dismiss.

`newLeads` is unchanged (people sync, or a member accepting a suggestion, created for them). The meetings list
gives each meeting `countsFor` (the members it counts towards) and the Team page marks the others **Not counted**.

## Clear leads and suggested leads

Sync makes a person only on a clear sign (`leadIsClear`):

- someone who **booked the member on Slotline**; or
- someone at a **work domain** whom **the member invited** (they organised the meeting).

Everyone else outside — the member was invited by someone outside (a vendor's pitch, a partner's call), or the
attendee is at a **free-mail domain** (as likely a friend as a client) — is **suggested** to the member instead:
the attendee row gets `lead_suggested_for_member_id`, and nothing else is made. An existing person nobody owns is
given to the member only on a clear sign, too.

**Team → Suggested leads** (`GET /meetings/lead-suggestions`, one per address with its meetings; an admin sees
every member's):

- **Add as lead** (`POST …/accept`, `record:write`) makes the person (owned by the member, source by where the
  meeting came from, company by domain) or gives them an unowned existing person; a person owned by someone else
  is `409` (an admin reassigns), a deleted one is `409` (restore it). Their meetings count from then on.
- **Not a lead** (`POST …/dismiss`) sets `lead_dismissed_at`; that address is never suggested to that member again
  and nothing else changes. Deliberately **not** the blocklist: a blocklist entry purges the address's stored mail.

A suggestion row is never pruned when a later copy no longer lists the attendee (it holds the member's decision).

## Why this replaces an exclusion switch

A "not a work meeting" flag was considered and dropped: under the rule a dinner counts only if the friend was
added as a lead (they would not be: free mail is only suggested), and a clear lead that should not be one is
handled where the CRM already handles it — deleting the person (a deleted person is never brought back by a
meeting), which also stops the meeting counting.

## Data (migration `20261015150000_meeting_lead_suggestions`)

`calendar_event_participants.lead_suggested_for_member_id` (FK, `SET NULL`), `lead_dismissed_at`, index
`(workspace_id, lead_suggested_for_member_id, address)`.

## Known limits

- A person added from a suggestion does not get the meeting's `linked-meeting.booked` entry on their timeline
  (it was announced before they existed); later changes (a cancellation) are on it.
- A meeting with a customer of each of two members counts for both; one with another member's customer only
  counts for that member, even when this member organised it.
- Clear-lead heuristics are domain-based: a client on Gmail whom the member invited is only suggested, and a
  friend at a company domain whom the member invited is a lead (delete the person).
