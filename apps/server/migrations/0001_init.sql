-- P0-04 最小业务库：入站事件、派发 outbox、Pi 作业映射。
-- 人格 / 记忆 / 审批 / 连接器等表留给对应工作包，不提前铺空壳。

create table inbound_event (
  id text primary key,
  source text not null,
  external_id text not null,
  payload jsonb not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  -- 平台事件身份唯一：同一 source + external_id 只能有一条
  constraint inbound_event_identity_unique unique (source, external_id)
);

create table dispatch_outbox (
  id text primary key,
  inbound_event_id text not null references inbound_event(id) on delete cascade,
  -- 业务会话键（P1 才落 profile / audience 表），P0-04 只保证同事件同键唯一
  conversation_key text not null,
  -- 稳定派发 ID：Pi 的 requestId 去重键，由 source + external_id 决定
  request_id text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dispatch_outbox_status_check check (status in ('pending', 'dispatched', 'failed')),
  constraint dispatch_outbox_request_unique unique (request_id),
  constraint dispatch_outbox_event_conversation_unique unique (inbound_event_id, conversation_key)
);

create index dispatch_outbox_claim_idx on dispatch_outbox (status, lease_until, created_at);

create table job (
  id text primary key,
  dispatch_outbox_id text not null unique references dispatch_outbox(id) on delete cascade,
  pi_conversation_id text not null,
  pi_submission_id text not null,
  -- Pi 结算回执（done / unanswered），不是应用侧“已完成”的投影
  pi_status text,
  status text not null default 'dispatched',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_status_check check (status in ('dispatched', 'completed', 'failed')),
  constraint job_submission_unique unique (pi_conversation_id, pi_submission_id)
);
