-- P3-01：独立执行任务与产物索引。worker 只拿工作区，不连接控制库。
create table execution_task (
  id text primary key,
  profile_id text not null references profile(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  command text not null,
  workspace text not null,
  output text,
  exit_code integer,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz
);
create index execution_task_profile_idx on execution_task (profile_id, created_at desc);

create table artifact (
  id text primary key,
  profile_id text not null references profile(id),
  execution_id text not null references execution_task(id) on delete cascade,
  name text not null,
  relative_path text not null,
  mime text not null,
  size bigint not null,
  sha256 text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index artifact_execution_idx on artifact (execution_id);
