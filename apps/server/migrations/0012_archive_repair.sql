-- 群存档补齐：Bot 自己的发言、平台撤回、离线缺口所需的列。
alter table group_member add column is_bot boolean not null default false;
alter table group_message add column recalled_at timestamptz;
create index group_message_recalled_idx on group_message (group_id, recalled_at);
