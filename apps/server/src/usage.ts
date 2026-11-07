import { randomUUID } from 'node:crypto'

import type { Message } from '@earendil-works/pi-ai'

import type { Pool } from './pg/connection'
import { withTransaction } from './pg/connection'

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  costUsd: number
}

export interface RecordUsageInput {
  profileId: string
  conversationKey: string
  jobId?: string
  entryId: string
  model: readonly Message[] | undefined
  provider: string
  modelId: string
}

const zero = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 })

/** 一条 assistant 消息对应一次上游调用；工具轮次会有多条，按出现顺序编号。 */
export async function recordUsage(pool: Pool, input: RecordUsageInput): Promise<number> {
  const messages = (input.model ?? []).filter((message) => message.role === 'assistant')
  if (messages.length === 0) return 0
  return withTransaction(pool, async (client) => {
    let inserted = 0
    for (const [sequence, message] of messages.entries()) {
      if (message.role !== 'assistant') continue
      const usage = message.usage
      const cost = Number.isFinite(usage.cost.total) ? usage.cost.total : 0
      const result = await client.query(
        `insert into model_usage(id, profile_id, conversation_key, job_id, entry_id, sequence,
           provider, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, cost_usd)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (conversation_key, entry_id, sequence) do nothing`,
        [
          randomUUID(), input.profileId, input.conversationKey, input.jobId ?? null, input.entryId, sequence,
          message.provider || input.provider, message.model || input.modelId,
          usage.input, usage.output, usage.cacheRead, usage.cacheWrite,
          usage.reasoning ?? 0, cost,
        ],
      )
      inserted += result.rowCount ?? 0
    }
    return inserted
  })
}

export async function usageForConversation(
  pool: Pool,
  conversationKey: string,
  since: Date,
): Promise<UsageTotals> {
  const row = (await pool.query<{
    input: string; output: string; cache_read: string; cache_write: string; reasoning: string; cost: string
  }>(
    `select coalesce(sum(input_tokens),0)::text as input,
            coalesce(sum(output_tokens),0)::text as output,
            coalesce(sum(cache_read_tokens),0)::text as cache_read,
            coalesce(sum(cache_write_tokens),0)::text as cache_write,
            coalesce(sum(reasoning_tokens),0)::text as reasoning,
            coalesce(sum(cost_usd),0)::text as cost
       from model_usage where conversation_key = $1 and created_at >= $2`,
    [conversationKey, since],
  )).rows[0]!
  return {
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    reasoning: Number(row.reasoning),
    costUsd: Number(row.cost),
  }
}

export interface UsageDay extends UsageTotals {
  day: string
}

export async function usageForProfile(pool: Pool, profileId: string, since: Date): Promise<UsageDay[]> {
  const rows = (await pool.query<{
    day: string; input: string; output: string; cache_read: string; cache_write: string; reasoning: string; cost: string
  }>(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
            coalesce(sum(input_tokens),0)::text as input,
            coalesce(sum(output_tokens),0)::text as output,
            coalesce(sum(cache_read_tokens),0)::text as cache_read,
            coalesce(sum(cache_write_tokens),0)::text as cache_write,
            coalesce(sum(reasoning_tokens),0)::text as reasoning,
            coalesce(sum(cost_usd),0)::text as cost
       from model_usage where profile_id = $1 and created_at >= $2
      group by 1 order by 1`,
    [profileId, since],
  )).rows
  return rows.map((row) => ({
    day: row.day,
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    reasoning: Number(row.reasoning),
    costUsd: Number(row.cost),
  }))
}

export function totalTokens(usage: UsageTotals): number {
  return usage.input + usage.output
}

export function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: left.reasoning + right.reasoning,
    costUsd: left.costUsd + right.costUsd,
  }
}

export { zero as zeroUsage }

export class Usage {
  constructor(private readonly pool: Pool) {}

  async today(): Promise<UsageTotals> {
    const row = (await this.pool.query<{
      input: string; output: string; cache_read: string; cache_write: string; reasoning: string; cost: string
    }>(
      `select coalesce(sum(input_tokens),0)::text as input,
              coalesce(sum(output_tokens),0)::text as output,
              coalesce(sum(cache_read_tokens),0)::text as cache_read,
              coalesce(sum(cache_write_tokens),0)::text as cache_write,
              coalesce(sum(reasoning_tokens),0)::text as reasoning,
              coalesce(sum(cost_usd),0)::text as cost
         from model_usage where created_at >= clock_timestamp() - interval '24 hours'`,
    )).rows[0]!
    return {
      input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write), reasoning: Number(row.reasoning), costUsd: Number(row.cost),
    }
  }

  profile(profileId: string, since: Date): Promise<UsageDay[]> {
    return usageForProfile(this.pool, profileId, since)
  }

  conversation(conversationKey: string, since: Date): Promise<UsageTotals> {
    return usageForConversation(this.pool, conversationKey, since)
  }
}
