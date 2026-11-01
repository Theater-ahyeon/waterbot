-- submission id 只在它所属的 Pi 数据库里有意义，不能跨 runtime 做全局唯一约束。
-- 同一 outbox 只允许一条 job 已由 dispatch_outbox_id 的唯一约束保证。
alter table job drop constraint if exists job_submission_unique;
