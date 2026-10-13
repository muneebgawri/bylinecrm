# P3-UI-1 — Sequences UI (#140)

Screens for the P3-3 API (#139), per doc 50 §D.

- **Sequences list** (`/sequences`): shared table (cards on a phone), Current/Archived tabs, status, email-step
  count, enrolled/active counts (from the API's counts, which are read from enrolment rows). "New sequence" names
  one (fallback zone = the browser's, window = `SEQUENCE_WINDOW_DEFAULTS`) and opens its builder.
- **Builder** (`/sequences/:id`): steps as an ordered list — email steps choose an _outreach_ template; follow-ups
  may reply in the thread; waits take 1–90 days, business days by default. Reorder/remove; "Save steps" PUTs the
  whole list in order, keeping saved step ids so enrolments keep their place. An untouched builder follows the
  server; the first edit takes a draft that a save clears. Status actions by state (Activate needs an email step;
  Pause/Resume; Archive with confirmation). Send window (times, days, fallback zone) and "Deal leaves pipeline" save
  with PATCH. The mandatory stop conditions are shown checked and disabled — visible, not optional (the server
  refuses turning them off). Without `sequence:write` the builder is read-only; without `sequence:enrol` there is
  no Enrol and no enrolment list.
- **Enrol dialog** — one component for three entry points: the person page (its primary action, per the P2-UI-1
  ruling), a People-list selection (≤ 500, the API batch), and the sequence page (people added with the record
  picker). It previews on every change of sequence or people and lists each refusal with the server's message;
  skipped people are counted, never re-enrolled; the confirm count is the server's. A `warnings` array (D-251's
  `region.unknown`, #142) is shown when the server sends one.
- **Person page**: a "Sequences" rail card with each enrolment's state line and Stop (optional note) / Resume
  (held) / Re-enrol (stopped — the only way back in after a stop).
- Bundle: both pages are one lazy chunk; the first load moved 177.49 → 177.56 kB (the two route entries).
- Not here at first: the task step — added in #158 once #136 landed in the API: **Add task** with a title, the row
  saying when the task falls due ("due when this step runs → person's owner"), and each task the step made on the
  enrolment's state line ("Task “…” · done 2 h ago" / "open, due today", `enrolmentTaskLine`), on the person's
  Sequences card and the sequence's enrolment table alike. Per-step sent/replied counts (the API has none yet) and
  the region-policy page (#141) stay out.
