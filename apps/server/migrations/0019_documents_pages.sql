-- P3-08：可编辑文档、Pages 与发布副本。
alter table artifact alter column execution_id drop not null;
alter table artifact add column storage_path text;
create index artifact_profile_idx on artifact (profile_id, created_at desc);

create table document (
  id text primary key,
  profile_id text not null references profile(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('docx', 'xlsx', 'pptx')),
  version integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index document_profile_idx on document (profile_id, updated_at desc);

create table document_revision (
  document_id text not null references document(id) on delete cascade,
  version integer not null,
  artifact_id text not null references artifact(id) on delete cascade,
  source jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (document_id, version)
);

create table page (
  id text primary key,
  profile_id text not null references profile(id) on delete cascade,
  title text not null,
  version integer not null default 0,
  content jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index page_profile_idx on page (profile_id, updated_at desc);

create table page_revision (
  page_id text not null references page(id) on delete cascade,
  version integer not null,
  content jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (page_id, version)
);

create table page_publication (
  token text primary key,
  page_id text not null references page(id) on delete cascade,
  version integer not null,
  title text not null,
  content jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz
);
create index page_publication_active_idx on page_publication (page_id) where revoked_at is null;
