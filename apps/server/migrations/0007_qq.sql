-- P2-01：一个人格可同时有工作台、QQ 私聊和多个群会话。
alter table conversation_binding drop constraint conversation_binding_pkey;
alter table conversation_binding drop constraint conversation_binding_conversation_key_key;
alter table conversation_binding add primary key (conversation_key);
create index conversation_binding_profile_idx on conversation_binding (profile_id);

create table qq_group (
  id text primary key,
  account_id text not null,
  external_group_id text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  hourly_reply_limit integer not null default 20 check (hourly_reply_limit between 1 and 100),
  created_at timestamptz not null default clock_timestamp(),
  unique (account_id, external_group_id)
);

create table qq_control (
  account_id text primary key,
  stopped boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

-- 掉线缺口：这段时间的消息可能缺失，不能声称记录完整。
create table qq_connection_gap (
  id text primary key,
  account_id text not null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  reason text not null
);
create unique index qq_connection_gap_open_idx on qq_connection_gap (account_id) where ended_at is null;
