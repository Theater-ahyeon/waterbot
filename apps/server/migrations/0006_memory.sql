-- P1-03 精简版：来源、作用域、即时纠正、ContextManifest。
-- 单条共享、撤回 epoch 与记忆卡片延后；群消息来源由 W-01 扩展 source_kind。

-- 作用域属于受信的会话绑定，模型和消息内容都不能选择。
alter table conversation_binding
  add column scope_kind text not null default 'owner_private',
  add column scope_ref text not null default '',
  add column readable_groups text[] not null default '{}',
  add constraint conversation_binding_scope_check check (
    (scope_kind = 'owner_private' and scope_ref = '')
    or (scope_kind = 'qq_group' and scope_ref <> '' and cardinality(readable_groups) = 0)
  );

create table memory_source (
  id text primary key,
  profile_id text not null references profile(id),
  source_kind text not null check (source_kind in ('owner_statement')),
  source_actor text not null,
  external_ref text not null,
  excerpt text not null,
  -- 事情发生时间与系统得知时间分开，迟到信息不算刚发生。
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (source_kind, external_ref)
);

create table memory (
  id text primary key,
  profile_id text not null references profile(id),
  scope_kind text not null,
  scope_ref text not null,
  kind text not null check (kind in ('fact', 'preference', 'constraint', 'experience', 'todo')),
  subject text not null,
  state text not null default 'active' check (state in ('active', 'archived')),
  version integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint memory_scope_check check (
    (scope_kind = 'owner_private' and scope_ref = '')
    or (scope_kind = 'qq_group' and scope_ref <> '')
  )
);
create index memory_recall_idx on memory (profile_id, state, scope_kind, scope_ref, updated_at desc);

create table memory_version (
  memory_id text not null references memory(id),
  version integer not null,
  content text not null check (char_length(content) between 1 and 4000),
  epistemic_status text not null check (epistemic_status in ('owner_stated', 'observed', 'reported', 'speculative')),
  source_id text not null references memory_source(id),
  recorded_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  primary key (memory_id, version)
);

-- 每次模型请求尝试一行：记录当次实际可见的记忆，用于纠错和影响分析。
create table context_manifest (
  id text primary key,
  profile_id text not null references profile(id),
  pi_conversation_id text not null,
  pi_task_id text not null,
  profile_revision integer not null,
  context_epoch integer not null,
  scope_kind text not null,
  scope_ref text not null,
  readable_groups text[] not null,
  memory_refs jsonb not null,
  model_route text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index context_manifest_profile_idx on context_manifest (profile_id, created_at desc);
