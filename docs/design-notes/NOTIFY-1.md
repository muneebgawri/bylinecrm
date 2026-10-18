# NOTIFY-1 — Members hear about their tasks (#192)

Issue #192, item 4. Owner feedback (2026-10-18): a sequence's task step ("Call if no reply → person's owner",
#136) made a task due now, assigned to the person's owner (else the enroller), and nobody was told. The task
waited on the person's record until someone happened to open it, and the top bar's bell was decoration (a fixed
red dot, no handler).

## What a member is told

One table, `notifications`: one row per (member, kind, task), unique. An event delivered twice, or a job run
twice, tells nobody twice. Each member reads only their own. The workspace RLS policy isolates workspaces, and
the service filters by the caller's member.

| Kind            | When                                                                                         | Made by                                                                          |
| --------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `task_assigned` | A task is made with an assignee, or handed to someone, by anyone but that member themselves. | The outbox consumer (`task.created`; `task.updated` whose diff has `assigneeId`) |
| `task_due`      | An open, assigned task came due.                                                             | The due job, every 15 minutes                                                    |

- **Not a second reminder for "due now".** A task due within a minute of being made (a sequence's task step) was
  due as it was made. Being assigned it is the reminder.
- **No backlog at deploy.** Only tasks that came due in the last two days are reminded, so existing overdue tasks
  are not announced all at once.
- **One reminder per task.** It goes to whoever holds the task when it comes due. A task handed on after its
  reminder is not reminded again; its new holder was told it was assigned.

## Where they see it

- **The bell** (top bar): the unread count in its label ("Notifications, 1 unread") and the red dot only when
  there is one. It is asked again every minute. The bell and its count are in the first load; the list is its own
  chunk, loaded on the first press. It is a popover on a desktop and a bottom sheet on a phone (`ResponsivePanel`).
  Opening a notification goes to the record the task is about and marks it read; _Mark all read_ marks every one.
- **My tasks** (the dashboard, which was a placeholder): the member's open tasks (not done, not deleted), overdue,
  due today, upcoming and with no date, on the member's own clock. Each links to the person, company or deal it is
  about, by name. With `task:write` a checkbox completes it.
- **The morning digest**: one email to each member with tasks overdue or due today (UTC). It is recorded in the
  transactional mail outbox inside the transaction that read the tasks, and the relay sends it after commit, so
  there is no network call inside a transaction. The idempotency key `task-digest-<member>-<day>` makes it one per
  member per day. Nothing is sent when nothing is due.
    - It is sent at 03:00 UTC (`TASK_DIGEST_CRON`), which is 08:00 in Pakistan, where the account managers work.
      Members have no time zone of their own yet.
    - It is on by default. Each member turns it off in the bell's footer (`workspace_members.task_digest`, per
      workspace).

## One query

My tasks and the digest read the same function: the member's open tasks, soonest due first, no date last, at
most 200, with their targets labelled (`labelTargets`: one query per record kind, a person's name else their
address). The bell labels its tasks the same way.

## API

- `GET /notifications`: `{ items (newest 50), unread }`.
- `POST /notifications/read`: `{ ids? }` marks the caller's own; no `ids` marks all.
- `GET /my-tasks`.
- `GET` and `PUT /notification-settings`: `{ taskDigest }`.

All are `@AnyMember`: they are about the caller themselves, like `/me`. An API key acts as its creator's member.

## Jobs

`NOTIFICATIONS_WORKER` (default `1`; the cross-tenant suite sets `0` and calls the service) runs the due job
every 15 minutes and the digest on its cron, on the `notifications-maintenance` queue. Both are idempotent.

## Not here

Push, mobile or Slack delivery; notifications for things other than tasks (replies, bookings); per-member time
zones; snoozing.
