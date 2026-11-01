import { describe, expect, it } from 'vitest'

import { parseBingRss } from './search'

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>https://cn.bing.com/</link>${items}</channel></rss>`

describe('Bing RSS 解析', () => {
  it('取标题、链接和摘要并还原实体，频道自身的链接不算结果', () => {
    expect(parseBingRss(rss('<item><title>A &amp; B</title><link>https://a.example/x?a=1&amp;b=2</link><description>&lt;摘要&gt; &#20013;</description></item>')))
      .toEqual([{ title: 'A & B', url: 'https://a.example/x?a=1&b=2', snippet: '<摘要> 中' }])
  })

  it('支持 CDATA，丢弃非 http 链接，最多 5 条', () => {
    const good = '<item><title><![CDATA[标题]]></title><link>https://a.example</link><description>x</description></item>'
    const bad = '<item><title>坏</title><link>javascript:alert(1)</link><description>x</description></item>'
    const results = parseBingRss(rss(bad + good.repeat(7)))
    expect(results).toHaveLength(5)
    expect(results[0]!.title).toBe('标题')
  })

  it('没有结果时返回空；不是 RSS（如验证页）时报错，不当作查无结果', () => {
    expect(parseBingRss(rss(''))).toEqual([])
    expect(() => parseBingRss('<html>verify</html>')).toThrow('没有返回 RSS')
  })
})
