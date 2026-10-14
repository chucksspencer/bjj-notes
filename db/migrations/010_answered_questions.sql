-- Questions for the coach can be marked answered without changing what kind of note they are.
alter table notes add column if not exists answered_at timestamptz;
create index if not exists notes_open_questions on notes (observed_on desc) where kind = 'question' and answered_at is null;
