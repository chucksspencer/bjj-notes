# Game plans: focus and systems as one thing

A game plan is a part of your game: a title, a description, techniques and notes. Two optional things
sit on top of it:

- **Steps.** A start position, a premise, and a tree of steps ("if they do this, I do that"). A
  game plan with steps is what jiu-jitsu calls a system.
- **A place on the focus list.** A game plan is on focus (ranked) or it isn't. Taking it off means
  "I've moved on to other things"; the game plan, its steps and its notes stay.

The tree is always called its *steps*, never its "plan", so nothing reads "the game plan's plan". "Plan A",
"plan B" are the alternatives at one step.

## Names over time

| Until | Called | Tables |
|---|---|---|
| 016 | focus items | `focus_items` (`label`, `status`, `rank`), `focus_item_techniques`, `focus_item_notes` |
| 018 | areas | `areas`, `area_steps`, `area_techniques`, `area_notes`, `focus_events.area_id` |
| now | game plans | `game_plans`, `game_plan_steps`, `game_plan_techniques`, `game_plan_notes`, `focus_events.game_plan_id` |

016 (`db/migrations/016_areas.sql`) turned focus items into areas: on focus became "has a rank", and paused,
backlog, done and removed all became off focus; it added aliases, a start, a premise and the step tree. 017 added
alternatives (`alt`). 018 (`db/migrations/018_game_plans.sql`) renamed everything to game plans: tables, columns,
and every index, constraint and sequence still named after areas or focus items. 018 changes names only, no rows.
019 (`db/migrations/019_cleanup.sql`) cleared out the rest: the unused `goal` column (folded into the description
in 015), the old statuses in the focus history (`resumed` is now `added`; `paused`, `completed`, `backlogged` and
`dropped` are `removed`) with `focus_events.from_status` and `to_status`, the older `update_focus` actions, and
the focus list's `label` field (the name again, for iPhone app builds before 1.3).
020 (`db/migrations/020_step_options.sql`) made alternatives explicit: `alt` became `option` (see the rule below).
022 (`db/migrations/022_derived.sql`) stopped storing the cards steps use in `game_plan_techniques`: a row whose
card a step of the same game plan used was taken to be the step's and deleted; the rest stayed as links someone
made. Undo entries from before 022 still undo: a deleted game plan or card comes back without re-linking cards its
steps account for, and the link removal batched with old step edits is a no-op.

Nothing answers to the area or focus item names any more, apart from old web links (`/focus/:id` and `/areas/:id`
redirect to `/game-plans/:id`; `/positions` to `/game`). Undo entries saved before 018 can't be undone; ones saved
before 019 still can (a goal they carry is ignored, and old focus events are put back as what they mean now),
except those that put steps back: step snapshots from before 020 say `alt`, not `option`, and are refused ("saved by
an older version of the app") rather than put back in the wrong place.

## Steps: slots and options

This is the rule; everything that reads or writes steps follows it, through one module (`src/shared/steps.ts`).

- Under one parent (a step, or the game plan itself for the main line), the steps are a list of **slots**, in
  order. `game_plan_steps.ordinal` is the slot: 1, 2, 3…
- A slot is a **choice** between its **options**. `game_plan_steps.option` is the alternative within the slot: 0 is
  plan A, 1 is plan B, and so on, in the order you'd rather. Most slots have one option.
- Each option is a branch: its children (the rows whose `parent_id` it is) are what follows *that option*.
- The next slot under the same parent is what follows *once the choice is resolved, whichever option was used*
  (on the main line, step 2 after step 1a or 1b).
- A slot whose option 0 has a `trigger` is an "if they…" branch; without one it is a "then". The trigger is the
  slot's: an alternative answers the same reaction as its plan A, so only option 0 carries it.

The database holds it to that: `unique nulls not distinct (game_plan_id, parent_id, ordinal, option)`
(`game_plan_steps_slot_option`, checked at commit, because moving and deleting renumber a row at a time inside a
transaction), `ordinal >= 1`, `option >= 0`, and `option = 0 or trigger is null`. The writers keep slots and
options numbered with no gaps.

The JSON API shows the same thing (`GamePlanDetail.steps` in `src/shared/api.ts`):

```ts
steps: GamePlanSlot[]
GamePlanSlot = { ordinal, trigger, options: GamePlanStep[] }
GamePlanStep = { id, option, action, technique, to, toRole, note, continuesIn, slots: GamePlanSlot[] }
```

## Rules that keep it small

- A step always keeps its `action` text as said. `technique_id` and `to_position_id` are optional
  links on top. "Octopus sweeps" is a valid step with no card.
- Triggers and the premise are free text. Opponent reactions are not normalised.
- A game plan's techniques are the cards someone linked (`game_plan_techniques`) plus the cards its steps use,
  read through the `game_plan_cards` view (022), which says which (`linked`, `in_steps`; `linked` and
  `usedInSteps` on each of `GamePlanView.techniques`). Steps don't link anything: a card used by a step is on the
  game plan while a step uses it and goes with the last such step, unless someone also linked it. Unlinking a card
  only a step accounts for is refused, naming the step; linking one makes it a link of its own, which stays
  without the step. Everything that reads a game plan's cards or a card's game plans (its page, the card's "In",
  notes from its techniques, the last note date, matching a game plan by a card's name) reads the view.
- Readiness is read off the technique statuses of the steps. A game plan has no status of its own.
- Hand-offs are derived: a step whose `to_position_id` and role match another game plan's start shows
  "continues in: <that game plan>".
- A step has a stable id. Adding, changing, deleting or moving one step touches only the rows it must (the
  step, and the numbering of the slots or options beside it), so every other step keeps its id. Only saving a
  whole outline (Claude's `save_game_plan` with `steps`, and "Describe it") replaces them all.
- A slot moves among the slots under the same parent, never to another parent: the step and its alternatives
  together, with everything under them. Within a slot, options move to change which is plan A, B, C; the trigger
  stays with the slot (`moveStep` in `src/services/steps.ts`).
- Deleting a step deletes everything under it. If it was plan A and the slot has other options, plan B becomes
  plan A and takes over the slot's trigger.
- Every step write marks the game plan as changed (`game_plans.updated_at`, `updatedAt` on its page). A write can
  say what it last saw (`expectedUpdatedAt`): if the game plan has changed since, nothing is saved and the answer
  is 409, "This game plan changed somewhere else. Reload to see it." The web app sends it with every step write
  and with "Describe it", shows the message and reads the game plan again. Claude's tools don't send it.
- Each step write is one undo, which puts every step back as it was, ids included.
- `technique_links` of kind `chain` / `setup` stay, but new chains belong in steps.

## Code

`src/services/gamePlans.ts`: game plans (`saveGamePlan` for Claude, `createGamePlan` / `editGamePlan` /
`linkGamePlan` / `deleteGamePlan` for the web app) and reading them for Claude (`getGamePlan`, `listGamePlans`).
The focus list is `src/services/focus.ts` (`getFocus`, `updateFocus`, `focusHistory`, `placeOnFocus`); the new row
and the card and note links both use are in `src/services/gamePlanLinks.ts` (`insertGamePlan`, `linkIn`).

`src/shared/steps.ts` (used by the server and the web app) is the structure: the `Slot` and `Option` types,
rows to a tree (`toTree`, `groupSlots`), the flat outline to a tree and back (`fromOutline`, `toOutline`), checking
an outline (`outlineProblem`), walking (`walk`, `stepsIn`, `findStep`, `countSteps`), and the limits (`MAX_DEPTH`,
`MAX_STEPS`). Nothing else works out which steps are alternatives to which.

`src/services/steps.ts` is everything that writes or says steps: a whole outline (`writeSteps`, with
`resolveStepNames` for Claude and `resolveStepIds` for the web app), one step at a time (`addStep`, `updateStep`,
`deleteStep`, `moveStep`, and `moveStepByName` for Claude), the check against changes made elsewhere
(`lockGamePlan`), text for Claude (`stepLines`) and speech for Siri (`gamePlanSpeech`). The read side for the web
app is `gamePlanView`, `gamePlansView` and `stepsOf` in `src/services/views/gamePlans.ts`. "Describe it" is
`src/services/gamePlanDrafts.ts`. Names match fuzzily (`resolveGamePlan` and `resolveStep` in `src/resolve.ts`).

A whole outline arrives flat, in reading order, with a depth and an `or` flag: `NamedStepInput` from Claude (cards
and positions by name, misses reported but not fatal) and `GamePlanStepInput` from "Describe it" (by id). Saving
one replaces every step; undo (`restore_game_plan`) puts the old ones back with their ids.

One step at a time, over HTTP (each scoped to the signed-in person, one transaction, one undo; each answers with
the game plan as it is now):

| Request | What it does |
|---|---|
| `POST /api/v1/game-plans/:id/steps` | Adds a step: `{ relation: 'then' \| 'if' \| 'or', of?, trigger?, action, techniqueId?, toPositionId?, toRole?, note? }`. `then` and `if` make a new slot under the step `of`, after what's there (without `of`: at the end of the main line); `if` needs a trigger and `then` takes none. `or` makes one more option at the end of `of`'s slot, and takes no trigger. Answers 201 with `stepId`. The step's card is linked to the game plan. |
| `PATCH /api/v1/game-plans/:id/steps/:stepId` | Changes the step's own fields. A trigger on an alternative is refused: it's the slot's, so change it on plan A. |
| `DELETE /api/v1/game-plans/:id/steps/:stepId` | Deletes the step and everything under it; plan B takes over if it was plan A. |
| `POST /api/v1/game-plans/:id/steps/:stepId/move` | `{ to: 'up' \| 'down' \| 'first' \| 'last' }` or `{ before \| after: stepId }` moves its slot; with `within: 'choice'` (and `to`) it moves among its slot's options. |

All four, and `PATCH /api/v1/game-plans/:id`, take an optional `expectedUpdatedAt` (for DELETE, in the body or the
query).

How `get_game_plan` reads one:

```
Bottom half: winning the underhook. #1 on your focus list; last note 3 days ago.
Starts in Half guard, bottom, when top has the underhook and crossface.
Steps:
1a. John Wayne sweep (drilling): Force them to post the underhook hand.
1b. Or: knee lever.
   Come up on the single.
2. Shuck (learning).
   If they post the far leg: go to deep half → Deep half guard (bottom). Continues in: Deep half sweeps.
   If they base back: octopus sweeps.
Weakest step: Shuck (learning).
```

## MCP tools

| Tool | What it does |
|---|---|
| `get_focus` | The ranked list. `history` for what went on and off it. |
| `get_game_plan` | With `name`: one game plan with its steps. Without: every game plan, on focus or not, by where it starts. |
| `save_game_plan` | Creates or edits a game plan, including its `steps`, and can put it on or take it off focus. `delete: true` removes it for good. `move` reorders one step, found by what it says ("move the kimura before the guillotine", `to: 'first'`, `prefer: true` for plan A); two steps that say the same thing are asked about, not guessed. |
| `update_focus` | `add`, `move`, `remove`. `add` on an existing game plan puts it back on the list. |
| `add_note` | `game_plan` files the note under one. |
| `get_technique` | "In game plans: …". |
| `search` | Also matches game plan names, aliases, premises, step triggers and actions, so "what do I do when they post the far leg" finds the branch. |

The step list Claude sends is flat with a `depth` (and `or` for an alternative) on purpose: clients with a stale
or simplified copy of a tool's schema handle that better than a nested one. It becomes slots and options on the
way in (`fromOutline`).

## Web app

- **Game tab:** your game plans grouped by start position (on-focus ones numbered), then the position list
  with empty positions folded away. A position page leads with "Game plans from here".
- **Game plan page:** one switch, "On focus", with Up / Down / Top when it's on; the steps above the
  description and techniques; Delete is separate and asks first.
- **Steps, reading:** an outline with a status bar per step; deeper branches open on tap.
- **Steps, editing:** a step at a time, each change saved on its own through the step endpoints
  (`web/src/components/steps/`: `StepsSection.tsx` holds the state and what each sheet saves, `Outline.tsx` draws
  the outline, `StepSheet.tsx`, `StartSheet.tsx` and `DescribeSheet.tsx` are the sheets, and `model.ts` the shapes
  and where a step can move; `useAddStep`, `useUpdateStep`, `useDeleteStep`, `useMoveStep` in `web/src/api.ts`).
  If the game plan changed somewhere else since the page read it, the change isn't saved: the page says so and
  reads it again. Tap a step for its sheet. *Then* (what comes after this step) and *If
  they…* (a branch) add a step under the one you tap, after what's there; *Or* adds an alternative beside it;
  *Add a step at the end* adds to the main line. The arrows at the end of a step's row move
  it (and its alternatives) past the step above or below, as the outline draws them: inside a branch, the "if
  they…" branches and the "then" steps move within their own run. In the sheet, *Make this plan
  A*, *Try earlier* and *Try later* reorder alternatives. "Describe it" takes a paragraph and has Claude build the
  outline to check before saving.
- **Note sheet:** one "File under" search across techniques and game plans. Technique matches come first, and
  game plan matches wait for them, so a game plan that shares a card's name doesn't catch the tap. A note filed
  only under a game plan leaves the inbox.
- **Techniques sheet:** lists the cards someone linked, to add and remove; cards there only because a step uses
  them are named underneath ("Used in a step, so here while the step is: …") and can't be removed there.
- **Technique card:** "In" with the card's game plans under its belt; "Related" keeps variations and counters.

## Siri

`GET /api/v1/game-plans/speech?q=` reads a game plan aloud, found by the position it starts from ("bottom
half") or by name; the iPhone app's "What's my game plan" intent uses it ("What's my plan" still works).

## Left out for now

- Notes pinned to a single step.
- Normalised opponent reactions or sub-positions.
- A graph view across game plans. The derived hand-offs give most of it as text.
- Moving a step to another parent (out of a branch, into another): delete it and add it there, each with Undo.
- Changing one step from Claude: `save_game_plan` still takes the whole outline (or `move` for one step).
