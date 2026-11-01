-- 派发按目标会话 claim：索引跟着 conversation_key 走，旧索引不再覆盖新查询形状。
drop index if exists dispatch_outbox_claim_idx;

create index if not exists dispatch_outbox_claim_by_conversation_idx
  on dispatch_outbox (conversation_key, status, lease_until, created_at);
