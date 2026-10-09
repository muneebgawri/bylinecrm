# P1-UI-8 — Settings for pipelines and stage rules, custom fields, and role record scope

Issue #66. Closes three gaps the Phase 1 exit check found: each feature existed in the API with no
screen. Requirements: doc 48 FR-CRMS-9, FR-CRMS-UI-6, FR-CRMS-UI-8, FR-CRMS-UI-12; custom fields
are doc 48 §5.

## Routes

| Path                                    | Who                                            | What                                                 |
| --------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `/w/:id/settings/pipelines`             | `pipeline:configure` to change, anyone to read | Pipelines; create, make default, delete              |
| `/w/:id/settings/pipelines/:pipelineId` | same                                           | Stages (order, rename, edit, delete) and stage rules |
| `/w/:id/settings/custom-fields`         | `workspace:admin` to change                    | Fields per record kind; create, edit, archive        |
| `/w/:id/settings/roles` (changed)       | `workspace:admin`                              | Adds record scope and readable capability names      |

The settings section row now shows only the sections the member can use. Palette: "Pipeline
settings", "Custom fields". The pipeline segment is named once (`PIPELINE_PARAM`, `usePipelineId`).

## Decisions

- **Reordering stages.** `@dnd-kit/sortable` (MIT) over the existing `@dnd-kit/core`: the drag handle,
  its keyboard twin (Space, arrows, Space, Escape) and the row menu's Move up / Move down all send the
  same `PUT …/stages/order` with every id. The menu is the touch path on a phone, where the handle is
  hidden. The order paints before the server answers and is put back if it refuses.
- **Announcements by name, through the shared helper.** The stage list uses P1-UI-9's
  `makeDndAnnouncements` (packages/ui) with `stageReorderNames`: the stage by name, the place by
  position ("Contacted over position 3 of 6"), spoken in the page's one polite region; dnd-kit's
  assertive region stays silent. The drop's outcome is said once by the reorder itself
  (`stageMovedText`, "Contacted moved to position 3 of 6") whichever path moved it — drag, keyboard
  twin or the row menu.
- **A refused delete says why in the server's words.** The stage-delete 409 is shown as sent, with a
  link to the pipeline's deals. "Move deals to…, then retry" from the card is **not** built: the API
  has no bulk move, and moving N deals one request at a time from the browser is the client-side loop
  P1-UI-6 removed. Open question for the architect.
- **Custom fields are archived, never deleted**, and the archived list is read-only: the API has no
  restore route. Open question for the architect.
- **Key from label.** `fieldKeyFromLabel` ("Last outlet" → `last_outlet`) until the person edits the
  key; key and type are fixed once the field exists (the update DTO accepts neither).
- **Record scope** uses a new `RadioGroup` in `packages/ui`: native radios with an explanation per
  option, the input visually hidden, the row the target, `focusWithinRing` (added to the one focus
  module) on the row.
- **Capability names.** `CAPABILITY_LABEL` and `CAPABILITY_AREA_LABEL` name every capability in words,
  grouped by area; the catalogue string is only a tooltip.
- **One definition each.** The stage colour→tone map is the board's `STAGE_TONES`; `ConfirmDialog`
  (now with an optional server error and follow-up) and `failureText` moved to `components/` and
  `lib/errors.ts`, re-exported where lists and deals already import them. Settings reads and writes
  live in `api/settings.ts`, so they load with the settings chunk.

## Tests

Shown failing on `main` (144238c) first: Roles 4/4 failed on behaviour (no scope control, machine
strings shown, no scope column); Pipelines, CustomFields and settingsText failed because the modules
did not exist. FR ids are in the `describe` titles. The route gate visits the two new paths
(`states.ts` gains the pipeline example id; the fake API answers `?archived=true`).

## Not built here

Restoring an archived field and moving a stage's deals elsewhere both need API routes.
