-- W-01：群消息原始存档。独立于 Pi 对话记录，未 @ Bot 的消息也保存。
create table group_member (
  id text primary key,
  group_id text not null references qq_group(id),
  platform_user_id text not null,
  -- 昵称只用于展示和检索，不判定身份，也不授予权限。
  nickname_history text[] not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  unique (group_id, platform_user_id)
);

create table group_message (
  id text primary key,
  group_id text not null references qq_group(id),
  member_id text not null references group_member(id),
  external_event_id text not null,
  platform_message_id text not null,
  content text not null,
  reply_to text,
  has_attachment boolean not null default false,
  -- 发给 Bot 的提问：不计入“谁说过几次”，否则问题本身会被算进去。
  addressed_bot boolean not null default false,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  -- 普通忘记：停止召回和统计，原文保留；物理清除是另一项操作。
  hidden_at timestamptz,
  unique (group_id, external_event_id)
);
create index group_message_recent_idx on group_message (group_id, occurred_at desc);
create index group_message_platform_idx on group_message (group_id, platform_message_id);
create index group_message_member_idx on group_message (member_id);

alter table context_manifest add column message_refs jsonb not null default '[]';
