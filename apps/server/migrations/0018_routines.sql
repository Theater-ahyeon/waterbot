-- P3-07：时间 / 事件自动化。例行任务只计算到期并投递，不另建队列。
create table routine (
  id text primary key,
  profile_id text not null references profile(id) on delete cascade,
  name text not null,
  instruction text not null check (char_length(instruction) between 1 and 8000),
  revision integer not null default 1,
  trigger jsonb not null,
  timezone text not null default 'Asia/Shanghai',
  next_due_at timestamptz,
  missed_policy text not null default 'skip' check (missed_policy in ('skip', 'coalesce', 'catch_up')),
  max_catch_up integer not null default 0 check (max_catch_up between 0 and 20),
  budget_tokens integer not null default 0 check (budget_tokens >= 0),
  delivery jsonb not null default '{"kind":"web_owner"}'::jsonb,
  webhook_token text unique,
  status text not null default 'active' check (status in ('active', 'paused', 'completed')),
  pause_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index routine_due_idx on routine (next_due_at) where status = 'active' and next_due_at is not null;
create index routine_profile_idx on routine (profile_id, created_at desc);

create table routine_occurrence (
  id text primary key,
  routine_id text not null references routine(id) on delete cascade,
  revision integer not null,
  logical_occurrence text not null,
  trigger_event_id text,
  trigger_payload_hash text,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'done', 'failed', 'skipped')),
  dispatch_outbox_id text references dispatch_outbox(id) on delete set null,
  job_id text references job(id) on delete set null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  result text,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (routine_id, revision, logical_occurrence)
);

create index routine_occurrence_recent_idx on routine_occurrence (routine_id, created_at desc);
create index routine_occurrence_active_idx on routine_occurrence (status) where status in ('pending', 'dispatched');
