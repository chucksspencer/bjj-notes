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
  sessionId: number | null;
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
}

export interface TechniqueListItem extends TechniqueRef {
  aliases: string[];
  noteCount: number;
  lastNoteOn: string | null;
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
}
