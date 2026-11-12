# Areas: focus and systems as one thing

An area is a part of your game: a title, a description, techniques and notes. Two optional things
sit on top of it:

- **A plan.** A start position, a premise, and a tree of steps ("if they do this, I do that"). An
  area with a plan is what jiu-jitsu calls a system.
- **A place on the focus list.** An area is on focus (ranked) or it isn't. Taking it off means
  "I've moved on to other things"; the area, its plan and its notes stay.

Schema: `db/migrations/016_areas.sql`. This file is the plan for the code; none of it exists yet.
The migration renames tables, so it has to ship in the same change as the code below.

## What the migration does

| Before | After |
|---|---|
| `focus_items` (`label`, `status`, `rank`) | `areas` (`name`, `rank`; no status) |
| status active / paused / backlog / done / dropped | on focus = `rank` is set; everything else has no rank |
| `focus_item_techniques`, `focus_item_notes` | `area_techniques`, `area_notes` (`area_id`) |
| `focus_events.focus_item_id` | `focus_events.area_id`, plus a `removed` event |
| | `areas` gains `aliases`, `start_position_id`, `start_role`, `premise` |
| | `area_steps`: the plan |

Items that were paused, backlog, done or removed all come back as areas that are off focus,
including ones removed in the past. Nothing is deleted. The old states remain readable in
`focus_events`.

## Rules that keep it small

- A step always keeps its `action` text as said. `technique_id` and `to_position_id` are optional
  links on top. "Octopus sweeps" is a valid step with no card.
- Triggers and the premise are free text. Opponent reactions are not normalised.
- An area's techniques are its `area_techniques` plus the cards its steps link. Saving a plan adds
  the step cards to `area_techniques`, so notes on them show up under the area as they do today.
- Readiness is read off the technique statuses of the steps. An area has no status of its own.
- Hand-offs are derived: a step whose `to_position_id` and role match another area's start shows
  "continues in: <that area>".
- `technique_links` of kind `chain` / `setup` stay, but new chains belong in plans.

## Services

`src/services/focus.ts` becomes `src/services/areas.ts`.

```ts
/** One line of the plan. Steps arrive flat, in reading order; depth says where each one hangs. */
export interface StepInput {
  /** 0 = main line; 1 = a branch off the nearest depth-0 step above it; and so on. */
  depth: number;
  /** The reaction that leads here ("they post the far leg"). Leave out for "next, do this". */
  when?: string;
  /** What to do, as said. Linked to a technique card when one matches well; kept as text either way. */
  do: string;
  /** Exact card to link, when the words in `do` aren't its name. */
  technique?: string;
  /** Where it leaves you, e.g. "deep half". */
  to?: string;
  to_role?: Role;
  /** Intent or cue. */
  note?: string;
}

export interface SaveAreaInput {
  /** Matched fuzzily against names and aliases; created when nothing matches. */
  name: string;
  rename_to?: string;
  aliases?: string[];
  description?: string;
  techniques?: string[];
  start?: string;
  start_role?: Role;
  premise?: string;
  /** When given, replaces the whole plan. Nothing else points at step ids, so replacing is safe. */
  steps?: StepInput[];
  /** true puts it on the focus list (at `position`, default 1); false takes it off. */
  focus?: boolean;
  position?: number;
}

export function getFocus(ctx: Ctx): Promise<string>;                    // the ranked list
export function listAreas(ctx: Ctx): Promise<string>;                   // every area, by start position
export function getArea(ctx: Ctx, name: string): Promise<string>;       // description, plan, techniques, notes
export function saveArea(ctx: Ctx, input: SaveAreaInput): Promise<string>;
export function deleteArea(ctx: Ctx, name: string): Promise<string>;
export function focusHistory(ctx: Ctx, name?: string): Promise<string>;
```

- `saveArea` rejects a step whose depth jumps by more than 1. Unmatched technique names are
  reported ("not linked to a technique card yet") without failing. It never creates cards.
- `resolveFocusItem` becomes `resolveArea` and also matches aliases.
- Undo: `restore_focus`, `restore_focus_label` and `restore_focus_links` keep their names (old log
  entries use them) and read the new tables. An old snapshot's `status` maps to a rank or none.
  One new op, `restore_area_plan { areaId, start, premise, steps }`, puts a plan back.
  `restore_deleted_technique` also relinks the steps that pointed at the card.

How `getArea` reads (also what Siri would speak):

```
Bottom half: winning the underhook. Number 1 on your focus list.
Starts in half guard, bottom, when top has the underhook and crossface.
1. John Wayne sweep (drilling): force them to post the underhook hand, win the underhook.
2. Shuck (learning).
   If they post the far leg: go to deep half. Continues in: Deep half.
   If they base back: octopus sweeps (no card yet).
Weakest step: Shuck. 3 notes in the last 30 days.
```

## MCP tools

| Tool | Change |
|---|---|
| `get_focus` | The ranked list only. `history` stays. |
| `get_area` | New. With `name`: one area with its plan. Without: every area, on focus or not, by start position. Replaces `get_focus` with `item`. |
| `save_area` | New. Creates or edits an area, including its plan (`steps`), and can put it on or take it off focus. `delete: true` removes it for good. Replaces `edit_focus`. |
| `update_focus` | Actions become `add`, `move`, `remove`. `add` on an existing area puts it back on the list. `pause`, `backlog`, `complete`, `drop` and `resume` are still accepted and mean remove / add. |
| `add_note` | `focus` is renamed `area` (old name still accepted). |
| `get_technique` | "In areas: …" in place of the focus line. |
| `search` | Also matches area names, aliases, premises, step triggers and actions, so "what do I do when they post the far leg" finds the branch. |

```ts
const step = z.object({
  depth: z.number().int().min(0).max(6).describe('0 = main line; 1 = a branch off the step above; etc.'),
  when: z.string().optional().describe('The reaction that leads here, e.g. "they post the far leg"'),
  do: z.string().describe('What to do, as said: a technique name, a family ("octopus sweeps") or a move to a position'),
  technique: z.string().optional().describe('The card to link, if "do" is not its name'),
  to: z.string().optional().describe('Position it leaves you in'),
  to_role: z.enum(ROLES).optional(),
  note: z.string().optional().describe('Intent or cue'),
});
```

The step list is flat with a `depth` on purpose: clients with a stale or simplified copy of a
tool's schema handle that better than a nested one.

Server instructions, replacing the two focus bullets:

> - An area is a part of {who}'s game: a title, a description, techniques and notes. It can have a
>   plan: where it starts, then a main line of steps with branches for how the opponent reacts
>   ("if they post the far leg, go to deep half"). "System" and "game plan" mean an area with a
>   plan. When {who} describes one, call save_area with the steps as an outline.
> - The focus list is the areas being worked on now, in order; #1 is worked on most. "Add X to my
>   focus" puts it at the top unless told otherwise. "I'm done with X for now" takes it off the
>   list; the area stays.

## Web app

- **Tabs.** Positions becomes "Game": your areas grouped by start position (on-focus ones marked),
  then the position list with empty positions folded away. A position page leads with "Plans
  from here".
- **Area page** (today's focus item page): adds the plan between the description and techniques.
  One switch, "On focus", with Up / Down / Top when it's on. Pause, Done and Remove go away;
  Delete is separate and asks first.
- **Plan, reading:** an outline two levels deep with a status bar per step; deeper branches open
  on tap.
- **Plan, editing:** tap a step for a sheet (when / do / leads to); "Add next step" and "Add
  branch" buttons. No drag or indent. "Describe it" takes a paragraph and has Claude build the
  outline, like capture does.
- **Note sheet:** one "File under" search across techniques and areas, replacing the technique
  search plus "Put it on a focus item". A note filed only under an area leaves the inbox.
- **Technique card:** "In areas" replaces "Related" chains.

## Order of work

1. Migration with the rename through services, HTTP API, web types and tests. No new behaviour.
2. Focus as a switch: actions, controls, history wording.
3. Plans: `saveArea` steps, `getArea`, undo, MCP tools, search.
4. Web: area page plan (read, then edit), Game tab, "File under".
5. iOS: a read intent ("what's my plan from bottom half?").

## Left out for now

- Notes pinned to a single step.
- Normalised opponent reactions or sub-positions.
- A graph view across areas. The derived hand-offs give most of it as text.
