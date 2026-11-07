-- P3-03：MCP 服务、工具开关、按人格启用和调用留痕。
create table mcp_server (
  id text primary key,
  name text not null unique,
  command text not null,
  args jsonb not null default '[]',
  cwd text,
  state text not null default 'idle' check (state in ('idle', 'ready', 'paused')),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table mcp_tool (
  server_id text not null references mcp_server(id) on delete cascade,
  name text not null,
  description text not null default '',
  enabled boolean not null default true,
  schema jsonb not null default '{}',
  updated_at timestamptz not null default clock_timestamp(),
  primary key (server_id, name)
);

create table mcp_binding (
  profile_id text not null references profile(id) on delete cascade,
  server_id text not null references mcp_server(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (profile_id, server_id)
);

create table mcp_call (
  id text primary key,
  profile_id text not null references profile(id),
  server_id text not null references mcp_server(id),
  tool_name text not null,
  arguments jsonb not null,
  status text not null default 'started' check (status in ('started', 'ok', 'failed')),
  output text,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz
);
create index mcp_call_recent_idx on mcp_call (created_at desc);
