import type { MemoryExtractor } from './memory-extraction'
import type { Pool } from './pg/connection'
import type { QqBridge, QqStatus } from './qq/bridge'
import type { AgentRuntime } from './runtime'
import type { Usage, UsageTotals } from './usage'

export interface StatusSnapshot {
  postgres: true
  runtime: { provider: string; modelId: string }
  queue: { pendingOutbox: number; dispatchedJobs: number; failedJobs: number }
  actions: { awaiting: number; ready: number; unknown: number }
  extraction: { pending: number }
  routines: { active: number; paused: number; due: number }
  gaps: { open: number }
  usage: UsageTotals
  qq: QqStatus | { state: 'not_configured' }
  checkedAt: string
}

/** 运维状态只读汇总；不暴露消息内容、密钥或记忆正文。 */
export class Status {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: AgentRuntime,
    private readonly usage: Usage,
    private readonly extractor?: MemoryExtractor,
    private readonly qq?: QqBridge,
  ) {}

  async snapshot(): Promise<StatusSnapshot> {
    const row = (await this.pool.query<{
      pending_outbox: number; dispatched_jobs: number; failed_jobs: number;
      awaiting_actions: number; ready_actions: number; unknown_actions: number; open_gaps: number
    }>(
      `select
         (select count(*)::int from dispatch_outbox where status = 'pending') as pending_outbox,
         (select count(*)::int from job where status = 'dispatched') as dispatched_jobs,
         (select count(*)::int from job where status = 'failed') as failed_jobs,
         (select count(*)::int from action where status = 'awaiting_approval') as awaiting_actions,
         (select count(*)::int from action where status = 'ready') as ready_actions,
         (select count(*)::int from action where status = 'unknown') as unknown_actions,
         (select count(*)::int from qq_connection_gap where ended_at is null) as open_gaps`,
    )).rows[0]!
    const routines = (await this.pool.query<{ active: number; paused: number; due: number }>(
      `select
         count(*) filter (where status = 'active')::int as active,
         count(*) filter (where status = 'paused')::int as paused,
         count(*) filter (where status = 'active' and next_due_at is not null and next_due_at <= clock_timestamp())::int as due
       from routine`,
    )).rows[0]!
    return {
      postgres: true,
      runtime: { provider: this.runtime.model.provider, modelId: this.runtime.model.modelId },
      queue: {
        pendingOutbox: row.pending_outbox,
        dispatchedJobs: row.dispatched_jobs,
        failedJobs: row.failed_jobs,
      },
      actions: { awaiting: row.awaiting_actions, ready: row.ready_actions, unknown: row.unknown_actions },
      extraction: { pending: this.extractor ? await this.extractor.pending() : 0 },
      routines,
      gaps: { open: row.open_gaps },
      usage: await this.usage.today(),
      qq: this.qq ? await this.qq.status() : { state: 'not_configured' },
      checkedAt: new Date().toISOString(),
    }
  }
}
