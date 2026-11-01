import { createHash, randomUUID } from 'node:crypto'

import { HttpError, textField } from './http'
import { withTransaction, type Pool, type PoolClient } from './pg/connection'

const ACCOUNT = 'local-simulation'
const KIND = 'mock.send'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface Action {
  id: string
  profile_id: string
  account_id: string
  kind: string
  target_ref: string
  payload: { message: string }
  payload_hash: string
  semantic_key: string
  profile_revision: number
  context_epoch: number
  policy_id: string | null
  policy_revision: number | null
  revision: number
  status: 'awaiting_approval' | 'ready' | 'sending' | 'confirmed' | 'unknown' | 'rejected' | 'expired' | 'failed'
  reason: string
  expires_at: Date
  receipt: string | null
}

export interface ActionPolicy {
  id: string
  profile_id: string
  target_ref: string
  hourly_limit: number
  revision: number
  active: boolean
}

export type ActionSender = (action: Action) => Promise<string>

export const simulatedSend: ActionSender = async (action) => `mock:${action.id}`

/** 工作台入口只产生本地模拟动作；真实平台动作由受控连接器经 submit 提交。 */
export class Actions {
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private closed = false

  constructor(private readonly pool: Pool, private readonly sender: ActionSender = simulatedSend) {}

  async start(): Promise<void> {
    // sending 没有确认回执时，重启不能把它当成尚未发送。
    await this.pool.query(`update action set status = 'unknown', reason = '进程中断，结果待核对', updated_at = now() where status = 'sending'`)
    this.timer = setInterval(() => { void this.pump() }, 500)
    void this.pump()
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await this.running
  }

  async list(profileId: string): Promise<Action[]> {
    return (await this.pool.query<Action>('select * from action where profile_id = $1 order by created_at desc limit 100', [profileId])).rows
  }

  async policies(profileId: string): Promise<ActionPolicy[]> {
    return (await this.pool.query<ActionPolicy>('select * from action_policy where profile_id = $1 order by created_at', [profileId])).rows
  }

  async addPolicy(profileId: string, body: Record<string, unknown>): Promise<ActionPolicy> {
    const target = textField(body.target, '模拟对象', 160).trim()
    const limit = Number(body.hourlyLimit)
    if (typeof body.hourlyLimit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '每小时额度必须为 1—100')
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    return (await this.pool.query<ActionPolicy>(
      'insert into action_policy(id, profile_id, target_ref, hourly_limit) values ($1,$2,$3,$4) returning *', [randomUUID(), profileId, target, limit],
    )).rows[0]!
  }

  /** 平台回复额度：同一目标保持一条有效规则，额度随配置更新。 */
  async ensurePolicy(profileId: string, target: string, hourlyLimit: number): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query('select id from profile where id = $1 for update', [profileId])
      const updated = await client.query('update action_policy set hourly_limit = $3 where profile_id = $1 and target_ref = $2 and active', [profileId, target, hourlyLimit])
      if (!updated.rowCount) await client.query('insert into action_policy(id, profile_id, target_ref, hourly_limit) values ($1,$2,$3,$4)', [randomUUID(), profileId, target, hourlyLimit])
    })
  }

  async revokePolicy(id: string): Promise<void> {
    const result = await this.pool.query('update action_policy set active = false, revision = revision + 1 where id = $1 returning id', [id])
    if (!result.rowCount) throw new HttpError(404, '规则不存在')
  }

  private async context(client: PoolClient, profileId: string): Promise<{ revision: number; epoch: number }> {
    const profile = (await client.query<{ revision: number }>('select revision from profile where id = $1 for share', [profileId])).rows[0]
    if (!profile) throw new HttpError(404, '人格不存在')
    const owner = (await client.query<{ epoch: number }>('select epoch from owner_context where id = 1 for share')).rows[0]!
    return { revision: profile.revision, epoch: owner.epoch }
  }

  private async used(client: PoolClient, policyId: string): Promise<number> {
    return Number((await client.query<{ count: string }>(
      `select count(*) from action where policy_id = $1 and status in ('sending','confirmed','unknown')
       and started_at > clock_timestamp() - interval '1 hour'`, [policyId],
    )).rows[0]!.count)
  }

  async propose(profileId: string, body: Record<string, unknown>): Promise<Action> {
    const target = textField(body.target, '模拟对象', 160).trim()
    const message = textField(body.message, '内容', 8000)
    const trigger = textField(body.triggerId, '触发 ID', 128)
    return this.submit(profileId, { account: ACCOUNT, kind: KIND, target, message, trigger })
  }

  /** 内部入口：账号与动作类型由调用方的受信代码决定，不来自请求体。 */
  async submit(profileId: string, input: { account: string; kind: string; target: string; message: string; trigger: string }): Promise<Action> {
    const { account, kind, target, message, trigger } = input
    const payload = { message }
    const fingerprint = hash({ account, kind, target, payload })
    const semantic = hash({ account, kind, target, trigger })
    return withTransaction(this.pool, async (client) => {
      const context = await this.context(client, profileId)
      const policies = (await client.query<ActionPolicy>(
        'select * from action_policy where profile_id = $1 and target_ref = $2 and active order by created_at', [profileId, target],
      )).rows
      let policy: ActionPolicy | undefined
      for (const candidate of policies) if (await this.used(client, candidate.id) < candidate.hourly_limit) { policy = candidate; break }
      const inserted = await client.query<Action>(
        `insert into action(id,profile_id,account_id,kind,target_ref,payload,payload_hash,semantic_key,profile_revision,context_epoch,policy_id,policy_revision,status,reason,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '15 minutes')
         on conflict(semantic_key) do nothing returning *`,
        [randomUUID(), profileId, account, kind, target, JSON.stringify(payload), fingerprint, semantic, context.revision, context.epoch,
          policy?.id ?? null, policy?.revision ?? null, policy ? 'ready' : 'awaiting_approval', policy ? '在已授权的模拟范围内' : '需要主人确认'],
      )
      const action = inserted.rows[0]
      if (!action) {
        const existing = (await client.query<Action>('select * from action where semantic_key = $1', [semantic])).rows[0]!
        if (existing.profile_id !== profileId || existing.payload_hash !== fingerprint) throw new HttpError(409, '同一触发事件已处理，不能改写或重复派发')
        return existing
      }
      if (!policy) await client.query('insert into approval(action_id,revision,payload_hash) values ($1,$2,$3)', [action.id, action.revision, fingerprint])
      return action
    })
  }

  private async locked(client: PoolClient, id: string): Promise<Action> {
    const action = (await client.query<Action>('select * from action where id = $1 for update', [id])).rows[0]
    if (!action) throw new HttpError(404, '动作不存在')
    return action
  }

  async decide(id: string, body: Record<string, unknown>): Promise<Action> {
    if (body.decision !== 'approved' && body.decision !== 'rejected') throw new HttpError(400, '决定无效')
    return withTransaction(this.pool, async (client) => {
      const action = await this.locked(client, id)
      if (action.status !== 'awaiting_approval' || body.revision !== action.revision || body.payloadHash !== action.payload_hash) throw new HttpError(409, '动作或内容已变化，请刷新后审查')
      await client.query('update approval set decision = $3, decided_at = clock_timestamp() where action_id = $1 and revision = $2 and payload_hash = $4', [id, action.revision, body.decision, action.payload_hash])
      return (await client.query<Action>(
        `update action set status = $2, reason = $3, policy_id = null, policy_revision = null, updated_at = now() where id = $1 returning *`,
        [id, body.decision === 'approved' ? 'ready' : 'rejected', body.decision === 'approved' ? '主人允许一次' : '主人已拒绝'],
      )).rows[0]!
    })
  }

  async edit(id: string, body: Record<string, unknown>): Promise<Action> {
    const message = textField(body.message, '内容', 8000)
    return withTransaction(this.pool, async (client) => {
      const action = await this.locked(client, id)
      if (!['awaiting_approval', 'ready'].includes(action.status) || body.revision !== action.revision) throw new HttpError(409, '动作已变化，不能修改')
      const payload = { message }
      const fingerprint = hash({ account: action.account_id, kind: action.kind, target: action.target_ref, payload })
      const context = await this.context(client, action.profile_id)
      const updated = (await client.query<Action>(
        `update action set payload=$2,payload_hash=$3,revision=revision+1,status='awaiting_approval',reason='内容已修改，需要重新确认',
         profile_revision=$4,context_epoch=$5,policy_id=null,policy_revision=null,expires_at=clock_timestamp()+interval '15 minutes',updated_at=now()
         where id=$1 returning *`, [id, JSON.stringify(payload), fingerprint, context.revision, context.epoch],
      )).rows[0]!
      await client.query('insert into approval(action_id,revision,payload_hash) values ($1,$2,$3)', [id, updated.revision, fingerprint])
      return updated
    })
  }

  async execute(id: string): Promise<void> {
    const action = await withTransaction(this.pool, async (client) => {
      const action = await this.locked(client, id)
      if (action.status !== 'ready') return undefined
      const current = await this.context(client, action.profile_id)
      const live = (await client.query<{ valid: boolean }>('select expires_at > clock_timestamp() as valid from action where id=$1', [id])).rows[0]!.valid
      if (!live || current.epoch !== action.context_epoch || current.revision !== action.profile_revision) {
        await client.query(`update action set status='expired', reason='授权已过期或人格上下文已变化', updated_at=now() where id=$1`, [id])
        return undefined
      }
      if (action.policy_id) {
        const policy = (await client.query<ActionPolicy>('select * from action_policy where id=$1 for update', [action.policy_id])).rows[0]
        if (!policy?.active || policy.revision !== action.policy_revision || policy.profile_id !== action.profile_id || policy.target_ref !== action.target_ref) {
          await client.query(`update action set status='expired', reason='长期规则已变化', updated_at=now() where id=$1`, [id])
          return undefined
        }
        if (await this.used(client, policy.id) >= policy.hourly_limit) {
          await client.query(`update action set status='awaiting_approval', reason='自动执行额度已满，需要确认', updated_at=now() where id=$1`, [id])
          await client.query('insert into approval(action_id,revision,payload_hash) values ($1,$2,$3) on conflict do nothing', [id, action.revision, action.payload_hash])
          return undefined
        }
      } else {
        const approved = await client.query(`select 1 from approval where action_id=$1 and revision=$2 and payload_hash=$3 and decision='approved'`, [id, action.revision, action.payload_hash])
        if (!approved.rowCount) throw new Error('缺少匹配当前内容的批准')
      }
      await client.query(`update action set status='sending', started_at=clock_timestamp(), updated_at=now() where id=$1`, [id])
      return action
    })
    if (!action) return
    try {
      const receipt = await this.sender(action)
      await this.pool.query(`update action set status='confirmed',receipt=$2,reason=$3,updated_at=now() where id=$1 and status='sending'`, [id, receipt, action.kind === KIND ? '本地模拟执行已确认' : '平台已回执'])
    } catch {
      await this.pool.query(`update action set status='unknown',reason='执行结果不明，停止自动补发',updated_at=now() where id=$1 and status='sending'`, [id])
    }
  }

  private pump(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.running) this.running = (async () => {
      const ready = (await this.pool.query<{ id: string }>(`select id from action where status='ready' order by created_at limit 20`)).rows
      for (const action of ready) { if (this.closed) break; await this.execute(action.id) }
    })().catch(() => { console.error('[action] 动作处理暂时失败') }).finally(() => { this.running = undefined })
    return this.running
  }
}
