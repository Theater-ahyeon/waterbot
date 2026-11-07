-- P2-02：QQ 空间只读缓存。只保存公开可见的说说正文和来源字段。
create table qzone_post (
  id text primary key,
  account_id text not null,
  target_uin text not null,
  tid text not null,
  content text not null,
  images jsonb not null default '[]',
  comments integer not null default 0,
  is_private boolean not null default false,
  posted_at timestamptz not null,
  fetched_at timestamptz not null default clock_timestamp(),
  unique (account_id, target_uin, tid)
);
create index qzone_post_recent_idx on qzone_post (account_id, target_uin, posted_at desc);

create table qzone_status (
  account_id text primary key,
  state text not null default 'idle' check (state in ('idle', 'ready', 'paused')),
  last_error text,
  last_fetch_at timestamptz
);
