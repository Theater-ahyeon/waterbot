-- P3-02：浏览器工作面与控制租约。每个 profile 独立持久目录，不导入用户日常浏览器资料。
create table browser_surface (
  id text primary key,
  profile_id text not null unique references profile(id) on delete cascade,
  state text not null default 'closed' check (state in ('closed', 'ready', 'disconnected')),
  lease_holder text not null default 'agent' check (lease_holder in ('agent', 'human', 'none')),
  lease_version integer not null default 1,
  lease_until timestamptz,
  current_url text,
  title text,
  last_error text,
  updated_at timestamptz not null default clock_timestamp()
);
