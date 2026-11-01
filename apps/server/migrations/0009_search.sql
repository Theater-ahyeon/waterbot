-- 联网查证：每次调用留痕，并按此统计每日上限。
create table search_call (
  id text primary key,
  pi_conversation_id text not null,
  query text not null,
  status text not null default 'started' check (status in ('started', 'ok', 'failed')),
  created_at timestamptz not null default clock_timestamp()
);
create index search_call_recent_idx on search_call (created_at desc);
