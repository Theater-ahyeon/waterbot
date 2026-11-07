import { describe, expect, it } from 'vitest'

import { normalizeQzone } from './qzone'

describe('QQ 空间返回归一化', () => {
  it('保留有效说说并跳过坏条目', () => {
    const posts = normalizeQzone({
      total: 3,
      msglist: [
        { tid: 'a', content: '第一条', time: 100, comment_num: 2, is_private: false, images: ['x'] },
        { tid: 'b', content: '', time: 101 },
        { tid: 1, content: '坏', time: 102 },
        'not-an-object',
      ],
    })
    expect(posts).toHaveLength(2)
    expect(posts[0]).toMatchObject({ tid: 'a', content: '第一条', comment_num: 2, images: ['x'] })
    expect(posts[1]).toMatchObject({ tid: 'b', content: '', comment_num: 0 })
  })

  it('缺少 msglist 直接报错', () => {
    expect(() => normalizeQzone({ total: 0 })).toThrow('msglist')
    expect(() => normalizeQzone(null)).toThrow('格式无效')
  })
})
