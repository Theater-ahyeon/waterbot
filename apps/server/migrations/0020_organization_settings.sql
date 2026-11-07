-- P3-10：人格组织与工作台设置。归档保留历史，不物理删除。
alter table profile add column archived_at timestamptz;
create index profile_active_idx on profile (created_at) where archived_at is null;

create table owner_setting (
  id text primary key,
  value jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
