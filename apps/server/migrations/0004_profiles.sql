create table owner_session (
  token_hash text primary key,
  expires_at timestamptz not null
);

create table profile (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80),
  instructions text not null check (char_length(instructions) <= 8000),
  revision integer not null default 1,
  created_at timestamptz not null default now()
);

create table conversation_binding (
  profile_id text primary key references profile(id),
  conversation_key text not null unique,
  pi_conversation_id text not null unique
);
