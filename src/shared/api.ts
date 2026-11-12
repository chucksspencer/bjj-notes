// Types shared by the JSON API (src/http/api.ts) and the web app (web/). No runtime code.

export type TechniqueType =
  | 'submission'
  | 'sweep'
  | 'pass'
  | 'escape'
  | 'transition'
  | 'takedown'
  | 'retention'
  | 'control'
  | 'entry'
  | 'counter'
  | 'concept';
export type Role = 'top' | 'bottom' | 'neutral';
export type Gi = 'gi' | 'nogi' | 'both';
export type Status = 'seen' | 'learning' | 'drilling' | 'hitting' | 'reliable';
export type NoteKind = 'instruction' | 'rolling' | 'drilling' | 'question' | 'idea';
export type SourceKind = 'class' | 'youtube' | 'instagram' | 'instructional' | 'book' | 'article' | 'other';
export type SessionKind = 'class' | 'open_mat' | 'private' | 'seminar' | 'competition' | 'drilling' | 'other';
export type LinkKind = 'chain' | 'counter' | 'variation' | 'setup' | 'related';
/** add puts an area on the focus list (at a position, default the top), move re-ranks it, remove takes it off. */
export type FocusAction = 'add' | 'move' | 'remove';
export type PositionCategory = 'standing' | 'guard' | 'pin' | 'back' | 'leg' | 'transitional';

export interface TechniqueRef {
  id: number;
  name: string;
  type: TechniqueType;
  role: Role | null;
  status: Status;
}

export interface PositionRef {
  id: number;
  slug: string;
  name: string;
}

export interface EdgeView {
  id: number;
  from: PositionRef | null;
  fromRole: Role | null;
  to: PositionRef | null;
  toRole: Role | null;
}

export interface LinkView {
  kind: LinkKind;
  /** out: this technique → other; in: other → this technique */
  direction: 'out' | 'in';
  technique: TechniqueRef;
  note: string | null;
}

export interface SourceView {
  id: number;
  kind: SourceKind;
  url: string | null;
  title: string | null;
  author: string | null;
}

/** A training session: where a note came from ("Zen camp seminar by Josh Jones on 2024-02-03"). */
export interface SessionView {
  id: number;
  /** YYYY-MM-DD */
  date: string;
  kind: SessionKind;
  /** Event name, e.g. "Zen camp". */
  name: string | null;
  instructor: string | null;
  location: string | null;
  gi: Gi | null;
}

/** A session to find or create: same date and kind with no conflicting details reuses the existing one. */
export interface SessionInput {
  kind: SessionKind;
  name?: string;
  instructor?: string;
  location?: string;
  /** Defaults to the note's date. */
  date?: string;
}

/** A photo or video on a note. The original is in Apple Photos; the server keeps a small still image. */
export interface AttachmentView {
  id: number;
  kind: 'photo' | 'video';
  /** Where the original is in Photos (null until the phone has found it). */
  photosLocalId: string | null;
  photosCloudId: string | null;
  /** ISO 8601 */
  takenAt: string | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
}

export interface NoteView {
  id: number;
  body: string;
  rawText: string | null;
  kind: NoteKind;
  /** YYYY-MM-DD */
  observedOn: string;
  source: SourceView | null;
  sourceTimestamp: string | null;
  techniques: TechniqueRef[];
  inbox: boolean;
  /** On the To try list: saved to try out before it's kept (filed) or tossed. */
  toTry: boolean;
  /** Starred: a recent, pertinent note to keep in front of you. */
  starred: boolean;
  /** When it was starred (ISO 8601). */
  starredAt: string | null;
  /** A question that's been answered (it leaves Ask coach). */
  answered: boolean;
  /** Photos and videos, kept in Apple Photos; the still is at /api/v1/attachments/:id/thumb. */
  attachments: AttachmentView[];
  /** Areas the note is filed under. */
  areas: AreaRef[];
  sessionId: number | null;
  /** Where the note came from. */
  session: SessionView | null;
  createdVia: 'mcp' | 'capture' | 'web';
}

export interface TechniqueView extends TechniqueRef {
  aliases: string[];
  gi: Gi;
  summary: string | null;
  keyDetails: string[];
  mistakes: string[];
  updatedAt: string;
  edges: EdgeView[];
  links: LinkView[];
  /** Areas it's part of: linked to the area, or a step in its plan. */
  areas: AreaRef[];
  notes: NoteView[];
  noteCount: number;
  lastNoteOn: string | null;
  /** Starred: a technique to keep in front of you for now (it shows in the Lab). */
  starred: boolean;
  starredAt: string | null;
}

export interface TechniqueListItem extends TechniqueRef {
  aliases: string[];
  starred: boolean;
  /** When it was starred (ISO 8601). */
  starredAt: string | null;
  noteCount: number;
  lastNoteOn: string | null;
  /** When it first showed up in your notes (not counting videos still to try). */
  firstNoteOn: string | null;
  edges: { from: string | null; fromRole: Role | null; to: string | null; toRole: Role | null }[];
}

/** An area, briefly. */
export interface AreaRef {
  id: number;
  name: string;
  /** Its place on the focus list (1 = top), or null when it's off focus. */
  rank: number | null;
}

/**
 * An area: a part of your game, with a description, techniques and notes, and optionally a plan (where it
 * starts, then steps that branch on how the opponent reacts). An area with a plan is what's called a system.
 */
export interface AreaView extends AreaRef {
  aliases: string[];
  /** What this is about: the strategy, cues, what success looks like. */
  description: string | null;
  /** Where the plan starts. */
  start: PositionRef | null;
  startRole: Role | null;
  /** The situation the plan is for, e.g. "top has the underhook and crossface". */
  premise: string | null;
  /** Linked techniques, including every technique a step of the plan is. */
  techniques: TechniqueRef[];
  /** How many steps the plan has (0 = no plan). */
  stepCount: number;
  /** How many notes are linked to it directly. */
  noteCount: number;
  /** The latest note linked to it, or on one of its techniques. */
  lastNoteOn: string | null;
}

/** One step of a plan, with what follows it. */
export interface PlanStep {
  id: number;
  /** The reaction that leads here ("they post the far leg"); null for "then". */
  trigger: string | null;
  /** What to do, as said ("octopus sweeps", "go to deep half"). */
  action: string;
  /** The technique card it is, when it is one. */
  technique: TechniqueRef | null;
  /** Where it leaves you. */
  to: PositionRef | null;
  toRole: Role | null;
  /** Why, or the cue. */
  note: string | null;
  /** Other areas whose plan starts where this step leaves you. */
  continuesIn: AreaRef[];
  children: PlanStep[];
}

/** One area's page. */
export interface AreaDetail extends AreaView {
  /** ISO 8601 */
  createdAt: string;
  /** The main line, in order. */
  plan: PlanStep[];
  /** Linked notes, newest first. */
  notes: NoteView[];
  /** The newest notes on its techniques that aren't linked to it yet. */
  relatedNotes: NoteView[];
  /** How many notes on its techniques aren't linked to it. */
  relatedCount: number;
  /** Every time it went on or off the focus list or moved on it, oldest first. */
  history: { at: string; event: string; toRank: number | null }[];
}

/** One line of a plan to save. Steps are flat, in reading order; depth says where each one hangs. */
export interface PlanStepInput {
  /** 0 = main line; 1 = a branch off the nearest step above it at depth 0; and so on. */
  depth: number;
  trigger?: string | null;
  action: string;
  techniqueId?: number | null;
  toPositionId?: number | null;
  toRole?: Role | null;
  note?: string | null;
}

/** A plan Claude outlined from a description, matched to cards and positions, to check before saving. */
export interface PlanDraft {
  start: { id: number; name: string } | null;
  startRole: Role | null;
  premise: string | null;
  plan: (PlanStepInput & { techniqueName: string | null; toName: string | null })[];
}

export interface AreaCreateInput {
  name: string;
  description?: string;
  techniqueIds?: number[];
  noteIds?: number[];
  /** Put it on the focus list (default true), at this position (default 1, the top). */
  focus?: boolean;
  position?: number;
}

/** Changes to an area; leave out what shouldn't change. */
export interface AreaPatch {
  name?: string;
  description?: string | null;
  aliases?: string[];
  startPositionId?: number | null;
  startRole?: Role | null;
  premise?: string | null;
  /** Replaces the whole plan. */
  plan?: PlanStepInput[];
}

/** Links to add to or remove from an area. */
export interface AreaLinksInput {
  add?: { techniqueIds?: number[]; noteIds?: number[] };
  remove?: { techniqueIds?: number[]; noteIds?: number[] };
}

/** An item on the focus list. */
export interface FocusItem extends AreaView {
  /** The same as name, for app builds from before areas. */
  label: string;
}

export interface FocusView {
  /** Today's date in the server's configured time zone, YYYY-MM-DD. */
  today: string;
  /** The focus list, top first. */
  active: FocusItem[];
}

/** Every area: the ones on focus first (in order), then the rest by name. */
export interface AreasView {
  today: string;
  areas: AreaView[];
}

export interface Starred {
  techniques: TechniqueListItem[];
  notes: NoteView[];
}

/** The Lab: the short-term working set beside the long-term focus list. */
export interface LabView {
  /** Today in the server's time zone, YYYY-MM-DD. */
  today: string;
  /** How far back "new in your notes" looks. */
  days: number;
  /** Stars older than this many days fold away as older stars. */
  starDays: number;
  /** Open questions noted longer ago than this fold away as older questions. */
  questionDays: number;
  /** Starred in the last `starDays` days, most recently starred first. */
  starred: Starred;
  /** Starred longer ago: still starred, folded out of the way. */
  olderStarred: Starred;
  /** The newest few videos to try, and how many there are in all. */
  toTry: { total: number; notes: NoteView[] };
  /** Techniques first noted in the last `days` days, newest first. */
  fresh: TechniqueListItem[];
  /** Open questions for the coach noted in the last `questionDays` days, newest first. */
  questions: NoteView[];
  /** Open questions noted longer ago. */
  olderQuestions: NoteView[];
}

export interface PositionListItem extends PositionRef {
  category: PositionCategory;
  aliases: string[];
  techniqueCount: number;
}

export interface PositionTechnique extends TechniqueRef {
  edge: EdgeView;
}

export interface PositionView {
  position: PositionRef & { category: PositionCategory; aliases: string[]; description: string | null };
  role: Role | null;
  from: PositionTechnique[];
  into: PositionTechnique[];
  gaps: { role: Role; type: TechniqueType }[];
  /** Areas whose plan starts here (in the role shown, if one is). */
  plans: AreaRef[];
}

export interface MessageResult {
  message: string;
}

export interface NoteCreateInput {
  text: string;
  techniqueIds?: number[];
  newTechniques?: { name: string; type: TechniqueType; role?: Role }[];
  kind?: NoteKind;
  date?: string;
  source?: { url?: string; title?: string; author?: string; kind?: SourceKind; timestamp?: string };
  /** An existing session, or null for none. Leave out (with `session`) to attach the day's only session, if there is one. */
  sessionId?: number | null;
  /** A session to find or create. */
  session?: SessionInput;
  /** Put it on the To try list instead of filing it. */
  toTry?: boolean;
  starred?: boolean;
  /** Areas to file the new note under. */
  areaIds?: number[];
}

export interface NotePatch {
  body?: string;
  kind?: NoteKind;
  date?: string;
  techniqueIds?: number[];
  sessionId?: number | null;
  session?: SessionInput;
  toTry?: boolean;
  starred?: boolean;
  /** Mark a question answered (true) or open again (false). */
  answered?: boolean;
  newTechniques?: { name: string; type: TechniqueType; role?: Role }[];
  /** The areas the note is filed under (replaces the set). */
  areaIds?: number[];
}

export interface NoteCreateResult extends MessageResult {
  note: NoteView;
}

export interface TechniquePatch {
  name?: string;
  type?: TechniqueType;
  role?: Role | null;
  gi?: Gi;
  status?: Status;
  summary?: string | null;
  aliases?: string[];
  keyDetails?: string[];
  mistakes?: string[];
  starred?: boolean;
}

// ---------- people and sign-in ----------

/** A person's rank, which colours their app. */
export type BeltRank = 'white' | 'blue' | 'purple' | 'brown' | 'black';

export interface Me {
  id: number;
  name: string | null;
  email: string | null;
  isOwner: boolean;
  belt: BeltRank;
}

export type SessionInfo = { signedIn: false } | { signedIn: true; user: Me };

/** A Siri Shortcut token (the token itself is shown only once, when made). */
export interface ApiTokenView {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PersonView extends Me {
  createdAt: string;
  lastActiveAt: string | null;
}

/** A one-time link to join, or to set a new password. */
export interface InviteView {
  id: number;
  purpose: 'join' | 'reset';
  name: string | null;
  email: string | null;
  userId: number | null;
  /** The belt a join link gives the new account (null for resets). */
  belt: BeltRank | null;
  createdAt: string;
  expiresAt: string;
}

export interface AccountView {
  me: Me;
  tokens: ApiTokenView[];
  /** The owner's API_TOKEN secret also works for their Shortcuts. */
  ownerApiToken: boolean;
  /** iCloud link to the shared "Save to BJJ Notes" shortcut, if one has been set up. */
  shareShortcutUrl: string | null;
  /** Only for the owner: whether search by meaning is on, and its most recent failure if the last try failed. */
  search?: {
    enabled: boolean;
    model: string | null;
    lastError: string | null;
  };
  /** Only for the owner. */
  people?: PersonView[];
  invites?: InviteView[];
}

/** What an invite or reset link is for, before it's used. */
export interface InviteCheck {
  purpose: 'join' | 'reset';
  name: string | null;
  email: string | null;
  /** The new account's belt, or (for a reset) the person's own. */
  belt: BeltRank;
  expiresAt: string;
}
