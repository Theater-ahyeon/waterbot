// 手动实测真实 Bing，不进默认测试：npx tsx test/live-search.ts "查询词"
import { createBingSearcher } from '../src/search'

const results = await createBingSearcher()(process.argv[2] ?? '2026 诺贝尔物理学奖')
console.log(JSON.stringify(results.map(({ title, url }) => ({ title, url })), null, 2))
console.log(`共 ${results.length} 条`)
