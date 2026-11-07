-- 模型用量：每次完成的模型请求按 entry 留痕，用于费用汇总和每日预算。
create table model_usage (
  id text primary key,
  profile_id text not null references profile(id),
  conversation_key text not null,
  job_id text references job(id),
  entry_id text not null,
  sequence integer not null default 0,
  provider text not null,
  model_id text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  unique (conversation_key, entry_id, sequence)
);
create index model_usage_conversation_recent_idx on model_usage (conversation_key, created_at desc);
create index model_usage_profile_recent_idx on model_usage (profile_id, created_at desc);
