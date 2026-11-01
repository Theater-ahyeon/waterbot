create table owner_context (
  id integer primary key check (id = 1),
  epoch integer not null default 1
);
insert into owner_context(id) values (1);

create table action_policy (
  id text primary key,
  profile_id text not null references profile(id),
  target_ref text not null,
  hourly_limit integer not null check (hourly_limit between 1 and 100),
  revision integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table action (
  id text primary key,
  profile_id text not null references profile(id),
  account_id text not null,
  kind text not null,
  target_ref text not null,
  payload jsonb not null,
  payload_hash text not null,
  semantic_key text not null unique,
  profile_revision integer not null,
  context_epoch integer not null,
  policy_id text references action_policy(id),
  policy_revision integer,
  revision integer not null default 1,
  status text not null check (status in ('awaiting_approval', 'ready', 'sending', 'confirmed', 'unknown', 'rejected', 'expired', 'failed')),
  reason text not null,
  expires_at timestamptz not null,
  started_at timestamptz,
  receipt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index action_ready_idx on action(status, created_at);

create table approval (
  action_id text not null references action(id),
  revision integer not null,
  payload_hash text not null,
  decision text check (decision in ('approved', 'rejected')),
  decided_at timestamptz,
  primary key (action_id, revision)
);
