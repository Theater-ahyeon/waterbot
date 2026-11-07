-- P3-06：技能库。技能是带版本的步骤和知识，不直接授予工具或账号权限。
create table skill (
  id text primary key,
  profile_id text not null references profile(id) on delete cascade,
  name text not null,
  description text not null default '',
  body text not null,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'active')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (profile_id, name)
);

create table skill_revision (
  skill_id text not null references skill(id) on delete cascade,
  version integer not null,
  body text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (skill_id, version)
);
