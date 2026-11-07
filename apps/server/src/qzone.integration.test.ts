import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import type { Action } from './actions'
import { QzoneService } from './qzone'

describe('QQ 空间只读缓存（真实 PostgreSQL）', () => {
  let db: TestDatabase
  let calls = 0
  let fail = false
  let service: QzoneService

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    service = new QzoneService(db.pool, 'onebot:1', '10001', async (action) => {
      calls++
      expect(action).toBe('get_qzone_msg_list')
      if (fail) throw new Error('登录失效')
      return {
        total: 2,
        msglist: [
          { tid: 't1', content: '第一条', time: 100, comment_num: 1, is_private: false, images: [] },
          { tid: 't2', content: '第二条', time: 200, comment_num: 0, is_private: true, images: ['a'] },
        ],
      }
    })
  })

  afterAll(async () => {
    await db?.dispose()
  })

  it('拉取后缓存，重复刷新不重复插入', async () => {
    const first = await service.refresh()
    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({ tid: 't2', content: '第二条', is_private: true })
    const again = await service.refresh()
    expect(again).toHaveLength(2)
    expect(calls).toBe(2)
    expect(await service.status()).toMatchObject({ state: 'ready', lastError: null })
  })

  it('读取失败标记 paused 并保留已有缓存', async () => {
    fail = true
    await expect(service.refresh()).rejects.toThrow('QQ 空间读取失败')
    expect(await service.status()).toMatchObject({ state: 'paused' })
    expect((await service.posts()).length).toBe(2)
    fail = false
  })

  it('写入开关关闭时拒绝评论，打开后调用 comment_qzone', async () => {
    const calls: { action: string; params: Record<string, unknown> }[] = []
    const action = {
      id: 'a1', profile_id: 'p', account_id: 'qzone', kind: 'qzone.comment', target_ref: 'qzone:10002:t1',
      payload: { message: '测试评论', tid: 't1', targetUin: '10002' },
    } as unknown as Action
    const blocked = new QzoneService(db.pool, 'onebot:1', '10001', async () => null, false)
    await expect(blocked.comment(action)).rejects.toThrow('QZONE_ALLOW_WRITE')
    const writer = new QzoneService(db.pool, 'onebot:1', '10001', async (name, params) => {
      calls.push({ action: name, params })
      return { id: 123 }
    }, true)
    await expect(writer.comment(action)).resolves.toBe('123')
    expect(calls).toEqual([{ action: 'comment_qzone', params: { tid: 't1', content: '测试评论', target_uin: 10002 } }])
  })
})
