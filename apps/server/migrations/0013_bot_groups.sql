-- P1-05：多个 Bot 的群聊、消息与任务交接。
alter table conversation_binding drop constraint if exists conversation_binding_scope_check;
alter table conversation_binding
  add constraint conversation_binding_scope_check check (
    (scope_kind = 'owner_private' and scope_ref = '')
    or (scope_kind = 'qq_group' and scope_ref <> '' and cardinality(readable_groups) = 0)
    or (scope_kind = 'bot_group' and scope_ref <> '' and cardinality(readable_groups) = 0)
  );

create table bot_group (
  id text primary key,
  name text not null,
  stopped boolean not null default false,
  created_at timestamptz not null default clock_timestamp()
);

create table bot_group_member (
  group_id text not null references bot_group(id) on delete cascade,
  profile_id text not null references profile(id) on delete cascade,
  role text not null default 'member' check (role in ('lead', 'member')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (group_id, profile_id)
);

create table bot_message (
  id text primary key,
  group_id text not null references bot_group(id) on delete cascade,
  sender_profile_id text references profile(id),
  sender_label text not null default 'owner',
  target_profile_id text references profile(id),
  external_ref text,
  content text not null check (char_length(content) between 1 and 8000),
  reply_to text references bot_message(id),
  created_at timestamptz not null default clock_timestamp(),
  unique (group_id, external_ref)
);
create index bot_message_group_recent_idx on bot_message (group_id, created_at desc);

create table bot_task (
  id text primary key,
  group_id text not null references bot_group(id) on delete cascade,
  message_id text not null references bot_message(id),
  from_profile_id text references profile(id),
  to_profile_id text not null references profile(id),
  pi_conversation_id text not null,
  pi_submission_id text,
  status text not null default 'queued' check (status in ('queued', 'dispatched', 'done', 'failed', 'cancelled')),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (group_id, message_id, to_profile_id)
);
create index bot_task_active_idx on bot_task (status, created_at);
