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
backlog, done and removed all became off focus (the old states stay readable in `focus_events`); it added
aliases, a start, a premise and the step tree. 017 added alternatives (`alt`). 018
(`db/migrations/018_game_plans.sql`) renamed everything to game plans: tables, columns, and every index,
constraint and sequence still named after areas or focus items. 018 changes names only, no rows.

Nothing answers to the area names any more, apart from old web links (`/focus/:id` and `/areas/:id` redirect to
`/game-plans/:id`; `/positions` to `/game`). Undo entries saved before 018 can't be undone.

## Rules that keep it small

- A step always keeps its `action` text as said. `technique_id` and `to_position_id` are optional
  links on top. "Octopus sweeps" is a valid step with no card.
- Triggers and the premise are free text. Opponent reactions are not normalised.
- A game plan's techniques are its `game_plan_techniques` plus the cards its steps link. Saving steps adds
  their cards to `game_plan_techniques`, so notes on them show up under the game plan.
- Readiness is read off the technique statuses of the steps. A game plan has no status of its own.
- Hand-offs are derived: a step whose `to_position_id` and role match another game plan's start shows
  "continues in: <that game plan>".
- Steps under the same parent are ordered by `ordinal` (1 = first). An alternative (`alt`) is plan B to the
  step before it under the same parent: it answers the same reaction, so it has no trigger of its own, and the
  first step under a parent is never an alternative.
- An alternative starts a branch of its own. What to do after it ("or Y, then Z", "if they… after Y") is its
  children. The next step in the same list, after the alternatives, follows plan A: on the main line, step 2
  comes after step 1's plan A, not "whichever was used". The outline, `get_game_plan` and Siri all show it
  that way: "Or" hangs under the step it's an alternative to, like an "if they…" branch, with its own steps
  inside it.
- A step moves among the steps under the same parent, never to another parent. It moves as a *choice*: the
  step and its alternatives together, with everything under them. Within a choice, steps move to change which is
  plan A, B, C; whichever is first carries the choice's trigger (`moveStep` in `src/services/gamePlans.ts`).
  Moves update the rows in place, so step ids stay; each one is a single undo.
- `technique_links` of kind `chain` / `setup` stay, but new chains belong in steps.

## Code

`src/services/gamePlans.ts`: the focus list (`getFocus`, `updateFocus`, `focusHistory`), game plans
(`saveGamePlan` for Claude, `createGamePlan` / `editGamePlan` / `linkGamePlan` / `deleteGamePlan` for the web
app), reading (`getGamePlan`, `listGamePlans`, `stepLines`), and Siri (`gamePlanSpeech`). The read side for the
web app is `gamePlanView`, `gamePlansView` and `stepsOf` in `src/services/views.ts`. "Describe it" is
`src/services/gamePlanDrafts.ts`. Names match fuzzily (`resolveGamePlan` in `src/resolve.ts`), on the name,
an alias, or a linked technique.

Steps arrive flat, in reading order, with a depth: `NamedStepInput` from Claude (cards and positions by name,
misses reported but not fatal) and `GamePlanStepInput` from the web app (by id). Saving steps replaces them all;
undo (`restore_game_plan`) puts the old ones back with their ids.

How `get_game_plan` reads one:

```
Bottom half: winning the underhook. #1 on your focus list; last note 3 days ago.
Starts in Half guard, bottom, when top has the underhook and crossface.
Steps:
1. John Wayne sweep (drilling): Force them to post the underhook hand.
   Or: knee lever.
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
| `update_focus` | `add`, `move`, `remove`. `add` on an existing game plan puts it back on the list. `pause`, `backlog`, `complete`, `drop` and `resume` are still accepted and mean remove / add. |
| `add_note` | `game_plan` files the note under one. |
| `get_technique` | "In game plans: …". |
| `search` | Also matches game plan names, aliases, premises, step triggers and actions, so "what do I do when they post the far leg" finds the branch. |

The step list is flat with a `depth` on purpose: clients with a stale or simplified copy of a
tool's schema handle that better than a nested one.

## Web app

- **Game tab:** your game plans grouped by start position (on-focus ones numbered), then the position list
  with empty positions folded away. A position page leads with "Game plans from here".
- **Game plan page:** one switch, "On focus", with Up / Down / Top when it's on; the steps above the
  description and techniques; Delete is separate and asks first.
- **Steps, reading:** an outline with a status bar per step; deeper branches open on tap.
- **Steps, editing:** a step at a time. Tap a step for its sheet; *Then* (the next main-line step, or what
  follows inside a branch), *If they…* (a branch) and *Or* (an alternative, drawn as a branch under the step
  it's an alternative to; *Then* on it adds to that branch) add one. The arrows at the end of a step's row move
  it (and its alternatives) past the step above or below, as the outline draws them: inside a branch, the "if
  they…" branches and the "then" steps move within their own run. In the sheet, *Make this plan
  A*, *Try earlier* and *Try later* reorder alternatives. "Describe it" takes a paragraph and has Claude build the
  outline to check before saving.
- **Note sheet:** one "File under" search across techniques and game plans. Technique matches come first, and
  game plan matches wait for them, so a game plan that shares a card's name doesn't catch the tap. A note filed
  only under a game plan leaves the inbox.
- **Technique card:** "In" with the card's game plans under its belt; "Related" keeps variations and counters.

## Siri

`GET /api/v1/game-plans/speech?q=` reads a game plan aloud, found by the position it starts from ("bottom
half") or by name; the iPhone app's "What's my game plan" intent uses it ("What's my plan" still works).

## Left out for now

- Notes pinned to a single step.
- Normalised opponent reactions or sub-positions.
- A graph view across game plans. The derived hand-offs give most of it as text.
- Moving a step to another parent (out of a branch, into another): delete and add, with Undo.
