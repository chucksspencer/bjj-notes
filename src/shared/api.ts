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
export type FocusStatus = 'active' | 'backlog' | 'paused' | 'done' | 'dropped';
export type FocusAction = 'move' | 'resume' | 'pause' | 'backlog' | 'complete' | 'drop';
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
  focus: { id: number; label: string; status: FocusStatus; rank: number | null }[];
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

export interface FocusItemView {
  id: number;
  label: string;
  goal: string | null;
  status: FocusStatus;
  rank: number | null;
  techniques: TechniqueRef[];
  lastNoteOn: string | null;
}

export interface FocusView {
  /** Today's date in the server's configured time zone, YYYY-MM-DD. */
  today: string;
  active: FocusItemView[];
  paused: FocusItemView[];
  backlog: FocusItemView[];
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
