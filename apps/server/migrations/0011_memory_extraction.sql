-- 群消息来源与后台提取队列。
alter table memory_source drop constraint if exists memory_source_source_kind_check;
alter table memory_source
  add constraint memory_source_source_kind_check check (source_kind in ('owner_statement', 'group_message'));
alter table memory_source add column message_id text references group_message(id);
create index memory_source_message_idx on memory_source (message_id);

create table memory_extraction (
  id text primary key,
  profile_id text not null references profile(id),
  conversation_key text not null,
  job_id text not null unique references job(id),
  group_ref text not null,
  trigger_message_id text not null references group_message(id),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index memory_extraction_pending_idx on memory_extraction (status, created_at);
