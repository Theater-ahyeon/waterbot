# 当前状态与续接

## R11：P1-03 精简版完成（2026-11-01，当前权威状态）

本节优先于下方所有记录。范围只含来源、作用域、即时纠正、ContextManifest；单条共享、撤回 epoch、记忆卡片按路线图 2A 延后，工作台没有记忆界面。

交付：

- `migrations/0006_memory.sql`：`memory_source`、`memory`、`memory_version`、`context_manifest`；`conversation_binding` 增加 `scope_kind` / `scope_ref` / `readable_groups`。
- `src/memory.ts`：记忆服务、中文二元组选择、上下文编译（先 SQL 限定作用域再排序）。约束恒带，其次被纠正的相关记忆；预算 12 条 / 1500 字。
- `src/memory-context.ts`：Pi `beforeRequest` 钩子，每次请求尝试都重新编译。结果只用于当次请求，不写入 transcript。没用系统段落，因为它会写进 Pi 历史。
- API：`GET/POST /api/profiles/:id/memories`、`GET /api/profiles/:id/context-manifests`、`GET /api/memories/:id`、`POST /api/memories/:id/revisions`、`POST /api/memories/:id/forget`。

验证：

- `npm run check` 退出 0：99 个测试（server unit 34、web unit 22、集成 43）。基线开工时也退出 0。
- 真实 PG / Pi / HTTP 覆盖：请求进上下文但不进 transcript、无关记忆不带入、纠正下一轮生效且旧版本可查、忘记后不召回、人格隔离、A 群读不到 B 群和私聊、owner 私聊只读绑定列出的群、消息文字不能写记忆或改作用域、重启后仍生效。
- 变异检查：去掉作用域过滤、去掉 `state='active'` 过滤后，对应用例分别失败，还原后通过。
- 构建产物 + 开发库实机一轮：迁移 0001—0006 应用，经 `index.ts` 的消息产生 Manifest 并引用刚写入的记忆。开发库已停止。
- 钩子编译失败时注入“记忆暂不可用”，这只有单元测试。

未验证 / 已知限制：

- 全部使用 faux 模型，未验证真实模型是否遵守记忆块，也未验证中文检索的真实效果。检索是二元组基线，单次扫描最新 500 条，语义检索和 SQL 统计属 W-01 / P1-04。
- 群路径是用 SQL 设定绑定来测读取隔离。真实群绑定、群消息来源、`qq_group` 记忆写入路径都没有，留给 P2-01 / W-01；`source_kind` 目前只有 `owner_statement`。
- `conversation_binding` 主键仍是 `profile_id`，一个人格只能有一个会话。QQ 群和私聊并存前，P2-01 必须改键。
- 纠正和忘记不会改动 Pi 历史：主人在普通聊天里说过的原话仍在 transcript，模型可能看到。记忆块标明纠正优先，这是缓解，不是清除；物理清除未做。
- Manifest 只关联会话和 Pi task，未关联 job。
- 只记录版本，没有事实有效期（`valid_from/to`）和按时间点的历史查询。
- 忘记不递增 epoch，不会拦截已提案的动作，属延后的撤回部分。
- R10 记录的 `awaiting_approval` 过期状态小缺口未处理。

用户决定（2026-11-01）：真实模型接入先不做，继续用 faux 模型，待用户另行通知；届时需要选定服务商、提供密钥、确认月预算。

## R12：P2-01 QQ 离线部分完成（2026-11-01，当前权威状态）

本节优先于 R11 及更早记录。代码已完成，**P2-01 未验收**：没有连接过真实 QQ 或 NapCat。

交付：

- `migrations/0007_qq.sql`：`conversation_binding` 主键改为 `conversation_key`，一个人格可有工作台、QQ 私聊和多个群会话；新增 `qq_group`、`qq_control`、`qq_connection_gap`。
- `src/qq/onebot.ts`：解析数组 / 字符串两种消息格式、@ 与回复、owner 命令；身份只看 `user_id`，发送只用文本段，回复里的 CQ 码不会被解析。
- `src/qq/client.ts`：OneBot v11 正向 WebSocket，指数退避重连，调用超时只报失败不重试。
- `src/qq/bridge.ts`：路由、停止、额度、缺口记录，从 Pi 回执生成 `qq.send` Action。
- `Actions.submit` / `ensurePolicy`：账号和动作类型由受信代码决定，工作台入口仍只产生模拟动作。
- owner 私聊命令：`全部停止`、`全部恢复`、`接入群 N`、`暂停群 N`、`恢复群 N`。`GET /api/qq/status` 查看连接、群和缺口。
- 配置见 `.env.example`。不填不启用；`QQ_ALLOW_SEND=1` 才外发，默认只接收。

验证：

- `npm run check` 退出 0：116 个测试（server unit 41、web unit 22、集成 53）。
- 模拟 OneBot + 真实 PG / Pi 覆盖：@ 回本群且重复事件不重复、未 @ / 未接入 / 陌生人私聊不调用模型、回复 Bot 才触发、群友发命令或自称主人无效、停止与恢复、命令重投不重复生效、额度、三路会话与作用域、超时记 unknown 不补发、掉线缺口与重连、外发关闭时不发送。
- 变异检查：去掉 owner 校验、去掉外发开关后，对应用例分别失败，还原后通过。

未验证 / 已知限制：

- 真实 NapCat、真实账号、真实群收发全部未验证。协议字段按 OneBot v11 和模拟端写成，可能与 NapCat 实际行为有差异。
- `index.ts` 的 QQ 分支只过了类型检查和构建，没有带 QQ 配置实际启动过。
- faux 模型下打开外发，会把“【本地演示】”回复发进真实群。接真实模型前不要在真实群打开 `QQ_ALLOW_SEND`；真实群外发和告知群友仍需用户授权。
- 未 @ 的群消息目前直接丢弃，不符合“全量存档”，W-01 必须补上。
- 附件只标记，不下载、不存储；纯图片消息进模型时只有占位文字。
- 停止或暂停期间 owner 的普通消息直接丢弃，没有提示。
- 只记录运行期间的掉线；server 自身离线的时段没有缺口记录。
- 协议端未连接时发送也记 unknown，不区分“确定没发出”。
- 开发库已应用到 0006，下次开发前运行 `npm run db:migrate`。

## R13：W-01 离线部分完成（2026-11-01，当前权威状态）

本节优先于 R12 及更早记录。R12 中“未 @ 的群消息直接丢弃”已解决，其余限制仍成立。**W-01 未验收**：只跑过模拟 OneBot 和 faux 模型。

交付：

- `migrations/0008_group_archive.sql`：`group_member`、`group_message`（含 `addressed_bot`、`hidden_at`）；`context_manifest.message_refs`。
- `src/archive.ts`：全量存档、引用链 / 最近消息 / 相关消息、SQL 统计、隐藏。
- `search_group_history` 工具：只读，参数里没有群，范围取自会话绑定；总数由数据库统计，原话带时间和发言人。这是所有会话唯一开放的工具。
- 上下文顺序：引用链 → 最近消息 → 相关旧消息 → 长期记忆。群会话只读本群，owner 私聊只查绑定列出的群。
- owner 私聊新增命令：`记住：X`、`忘掉：X`、`你记得什么`、`忘掉人 N`、`忘掉群 N`。不经过模型，即时生效。
- 演示模型回显时去掉上下文块，避免把记忆和群记录带进回复。

验证：

- `npm run check` 退出 0：124 个测试（server unit 41、web unit 22、集成 61）。
- 模拟 OneBot + 真实 PG / Pi，脚本模型真实调用工具：说 7 次数对并给出原话和时间；A 群查不到 B 群和私聊；owner 私聊能查群；群友说“记住”不写入；停止 / 暂停 / 超额时只存档；重投不重复存；忘掉人 / 群后不再统计和召回，原文保留。
- 开发中测出并修复两个真实缺陷：提问本身被算进次数；触发消息经 `related` 重复进入上下文。
- 变异检查：放开工具范围、去掉 `addressed_bot` 排除、去掉 `hidden_at` 过滤后，对应用例分别失败，还原后通过。

未验证 / 已知限制：

- 首个可用版还缺：**联网查证完全没做**（需要选搜索服务，可能产生费用）；群记忆提取没做（需要真实模型），所以 `qq_group` 记忆目前没有写入路径，翻旧账只靠原始存档。
- 脚本模型只证明工具和范围正确，不证明真实模型会调用工具或如实复述次数。
- 统计是关键词子串匹配，换种说法数不到；语义检索和 Hindsight / Mem0 比较未做。
- 发给 Bot 的消息一律不计入次数；有人 @ Bot 时说的话也不算，这是有意取舍。
- 存档只从接入群开始；已接入后 Bot 离线期间的消息缺失，`忘掉人` 只隐藏群消息。
- 引用链只能找到存档内的消息；Bot 自己的发言不进存档，引用 Bot 时链条会断。
- 数据库和备份加密（提案第 3 节）未做。
- 开发库已应用到 0006，下次开发前运行 `npm run db:migrate`。

## R15：联网查证改用免密钥 Bing（2026-11-01，当前权威状态）

本节优先于 R14 及更早记录。用户要求免费、不用注册，R14 里“需要 Tavily 密钥”不再成立。

- 默认搜索改为 Bing 的 RSS 输出（`createBingSearcher`），免注册、免密钥、开箱开启。`SEARCH_DISABLED=1` 关闭；`SEARCH_DAILY_LIMIT` 默认 100 次 / 24 小时；配了 `TAVILY_API_KEY` 才改用 Tavily。
- 本机实测（2026-11-01）：Bing RSS 中文结果可用，能查到 2026 年内容，约 200ms，连发 8 次未限流。DuckDuckGo HTML 连发后返回 202 挑战页，已淘汰；Baidu、Sogou、360 需解析 HTML，未采用；`s.jina.ai` 要密钥（401）。
- `npm run check` 退出 0：130 个测试（server unit 44、web unit 22、集成 64）。真实 Bing 经 `apps/server/test/live-search.ts` 手动查询，返回 5 条，这是真实网络证据。
- 风险：`format=rss` 不是 Bing 公开承诺的接口，可能随时变化或限流。非 RSS 响应按失败处理，模型会说明查不了；此时可改用 Tavily。摘要来自搜索页，模型没有读全文。
- 群友 @ Bot 也能触发公开搜索，查询词会发给 Bing。
- 未验证：工具在真实模型下的调用和引用来源行为。

下一步：等用户准备专用 QQ 小号并运行 NapCat；想接真实模型时再通知。代码已推送到公开仓库 https://github.com/Theater-ahyeon/waterbot（分支 `main`）。本仓库的 Git 邮箱设为 GitHub noreply，避免触发账号的邮箱隐私保护。

## R14：联网查证代码完成（2026-11-01）

本节优先于 R13 及更早记录。R13 里的“联网查证没做”“开发库到 0006”已解决，其余限制仍成立。

用户授权代为决定后的选择：搜索服务选 Tavily。真实模型维持搁置，理由是用户明确说过先不做，“代为决定”不足以视为授权密钥和费用。

交付：

- `src/search.ts`、`migrations/0009_search.sql`：`web_search` 工具，固定 basic 深度、5 条结果，保留来源 URL，每次调用留痕。
- 未设 `TAVILY_API_KEY` 时工具不开放，不产生调用。`SEARCH_DAILY_LIMIT` 默认 30 次 / 24 小时，约低于每月 1000 次。
- 接口按 Tavily 官方文档核对（2026-11-01）。文档写的免费额度是每月 1000 credits，有第三方来源称已变更，注册时以官网为准。

验证：

- `npm run check` 退出 0：127 个测试（server unit 41、web unit 22、集成 64）。模拟搜索服务 + 真实 PG / Pi，脚本模型真实调用工具：请求形状、来源保留、失败报错不外露密钥、上限后不再请求。
- 真实构建产物 + 本地假 OneBot + 开发库：带 QQ 配置启动，`接入群` 回执和群 @ 回复都走通，R12 的“QQ 分支没实际启动过”已解决。开发库已迁移到 0009 并停止。

未验证：真实 Tavily 调用（没有密钥）、真实模型是否按要求引用来源、真实 QQ。

下一步：等用户提供：① Tavily 密钥；② 专用 QQ 小号并运行 NapCat；③ 想接真实模型时再通知。未做 Git 提交。

## R10：Waterbot 迁移（2026-10-30）

本节优先于下方 R9 及更早记录；下方内容保留为历史证据。定位与顺序见 WATERBOT_PROPOSAL.md。

- 项目已由 `E:\agentcoding\personal agent` 迁入 `E:\agentcoding\waterbot`。原目录未修改，保留为只读归档。
- 未迁移：`apps/server/data`、`.env`、owner-key、`.workbuddy`、`node_modules`、`dist`、日志和 SQLite 文件。开发数据库、访问码和本地运行数据需在新目录重新生成。
- 旧 `.git` 已带入。分支 `master` 没有任何提交；本次未做 Git 提交。
- 标识已改名：`@waterbot/*`、`waterbot-server`、`waterbot_session`、开发库 `waterbot`。
- 改名前后 `npm run check` 均退出 0：84 个测试通过（server unit 27、web unit 22、集成 35），R9 记录的 73 个已过期。

P1-02 复核结果：

- 自动化已覆盖：规则内自动、规则外待审、批准绑定内容、修改后重新批准、额度并发、过期和撤权阻止、unknown 不补发、杀进程后标 unknown。
- API 和 Activity 界面已接通。连接器仍是本地模拟，未启用真实外发。
- 未验证：真实浏览器外观和用户试用。
- 已知小缺口：`awaiting_approval` 过期后状态不会自动变为 expired，列表仍显示待审；执行时会被拦下，不会误发。

真实模型仍需用户授权密钥、费用并选择服务商；月预算未定，默认只对被 @、疑似承诺和事实性内容做提取。QQ 需要专用小号。进入真实群前要确认 owner 权限并告知群友。

版本：R9，2026-10-28。Codex 已直接接手。P0-04 独立验收通过，P1-01 登录 / 人格 / 最小聊天的自动化闭环通过；最新 `npm run check` 退出 0，73 个测试通过（server unit 27、web unit 19、真实 PG / Pi / HTTP 集成 27）。真实浏览器外观及用户试用仍待验收。未做 Git 提交 / 推送、未部署、未连接产品真实模型或平台账号。

## 当前工作包

- P0-01：已完成只读环境盘点，有环境缺项，不代表 P0 整体通过。
- P0-02：已完成最小工程（server + web + 五个真实检查入口），证据见下文。
- P0-03：已完成 Pi 无凭据 runtime（真实 pi-durable 1.4.0 + SQLite + faux provider + requestId 去重 + 独立子进程中断恢复）；Codex 审查返修后独立 typecheck、lint、40 个测试、build 均退出 0；补齐 Node >=22.19.0 元数据及 signalCode 清理判断后 server 25 个测试再次退出 0。覆盖真实 server 启动恢复、失败启动释放 SQLite 和重开后原 requestId 去重。
- P0-04：独立验收通过。真实 PostgreSQL 18.4 + `pg`、事务迁移与校验和、入站事务 / outbox、真实 Pi 受理与两库崩溃恢复、attempts fencing、按会话路由；单会话的运行库绑定另外写入 Pi 的公开应用文档状态，重开同一文件不得改名读取旧历史。Docker Desktop 仍不可用，未重置或改全局配置。
- P1-01：已由 Codex 实现本机访问码登录、HttpOnly / SameSite cookie、PG 会话与过期校验、Origin / Host 检查、两个人格及创建 / 版本化修改、PG 到 Pi 会话绑定、持久入队和后台派发、实际 SSE 快照、独立聊天记录、切换草稿与迟到更新隔离；共用一个 Harness。当前明确标注本地演示模型。真实 PG / Pi / HTTP / SSE 验证 6 个场景通过；前端新增 4 个隔离 / 重试场景通过。没有把模拟回答称为真实模型效果。
- 当前继续 P1-02：动作、长期范围规则、审批与模拟连接器；不启用真实外发。
- 用户已要求“继续一直开发”：Codex 持续按路线逐包派发、审查、检查并推进，不因普通包内实现选择或一个包完成就再次请求授权；账号、真实外发、Git 推送与部署仍按对应范围处理。
- 桌面协作限制：用户当前正在使用电脑，要求“等我通知再操作”。Codex 已暂停鼠标、键盘、切换窗口和截图预览；可以继续后台源码审查和测试。WorkBuddy 当前任务及已排队的 P0-04 审查指令保留运行；未收到用户新通知前不再通过桌面发指令。
- 执行方变更：用户随后明确要求“你自己接手继续开发吧”。从当前源码接手，由 Codex 直接实现后续工作，不再向 WorkBuddy 派发任务；保留 R8 的交接成果及既有未提交变动，继续后台开发，不占用鼠标键盘。
- P1 后续的动作 / 记忆 / 多 Bot 及 P2—P4 连接器与部署尚未完成；GROK_PARITY 的 P52 / U9 / D5 不因地基和模拟聊天通过而整体改变。

## P0-01 环境盘点（沿用）

在首选 PowerShell 内只读执行版本 / 可用性检查，未安装、启动或修复服务：

| 检查 | 实际结果 | 对下一步的影响 |
| --- | --- | --- |
| PowerShell | 7.6.9，C:\Program Files\PowerShell\7\pwsh.exe | 按用户偏好使用该路径 |
| Node.js | v24.13.0，版本检查退出 0 | 已用于 P0-02 工程与检查 |
| npm | 11.6.2，版本检查退出 0 | 已安装项目本地依赖 |
| Git | 2.52.0.windows.1，版本检查退出 0 | P0-02 已本地 `git init`，未提交 |
| Docker | 客户端 29.7.2，server 版本检查退出 1，无法连接 dockerDesktopLinuxEngine 管道 | 已实测连接失败，可记为**已确认不可用**（仅 Engine，客户端在） |
| PostgreSQL | 只确认 `psql` 不在 PATH（命令不可用） | **未连接验证**：没有尝试连接任何实例，不能判定已确认不可用，状态未知 |
| Python | 3.12.9，版本检查退出 0 | 可用于后续模块兼容性验证 |
| Git 工作区 | P0-01 时 rev-parse 退出 128，非仓库 | P0-02 已按授权初始化，仍不能把 /review 当作可用 |
| 应用工程 | P0-01 时无 package.json / 锁文件 | P0-02 已建立并有真实检查入口 |

状态区分（不要混用）：Docker Engine 是**已确认不可用**（实际连接失败）；PostgreSQL 只是**未验证**——P0-01 仅证明 `psql` 不在 PATH，既没有安装证据也没有连接证据，因此既不能说“可用”，也不能说“已确认不可用”。

Docker / PG 不就绪不阻止最小工程与 Pi 无凭据恢复；P0-04 需要可用的开发 PostgreSQL。不要把缺项扩展成先安装所有可选工具。

## P0-02 实际交付

| 路径 | 内容 |
| --- | --- |
| `package.json` / `package-lock.json` | npm workspaces（`apps/*`）与锁文件；`dev` / `typecheck` / `lint` / `test:unit` / `build` / `start` 六个入口 |
| `tsconfig.base.json` | 共享严格 TS 基线（strict、noUncheckedIndexedAccess、verbatimModuleSyntax 等） |
| `eslint.config.js` | ESLint 10 flat config：`@eslint/js` + `typescript-eslint` + `react-hooks`（仅 web） |
| `.gitignore` | 忽略 node_modules、构建输出、`.env`、秘密、SQLite / PG 本地数据、日志、浏览器资料 |
| `.env.example` | `HOST` / `PORT` / `VITE_SERVER_ORIGIN`，项目根唯一一份：server 用 `process.loadEnvFile` 读，web 配置只取代理目标那一个键 |
| `apps/web/vite.config.ts` | 显式从项目根读 `VITE_SERVER_ORIGIN` 作 `/api` 代理目标（前缀过滤只取该键；未设 `envDir`，根 `.env` 不注入客户端） |
| `apps/server/src/health.ts` | 健康检查协议（字段、`SERVICE_VERSION`、运行时长计算） |
| `apps/server/src/config.ts` | 配置加载；非回环 `HOST` 直接报错，server 只监听本机 |
| `apps/server/src/paths.ts` | 项目根与 `.env` 的唯一定义：从模块位置上溯三层推算，开发 / 构建同值，不扫描目录 |
| `apps/server/src/env.ts` | 只加载项目根那一个 `.env`，不存在即跳过，不向父目录或磁盘其他位置查找 |
| `apps/server/src/app.ts` | Node 原生 http；`GET /api/health` 200、非 GET 405 + `Allow: GET`、未知路径 404 JSON、畸形请求行 400 |
| `apps/server/src/index.ts` | 启动、端口占用提示、SIGINT / SIGTERM 关闭 |
| `apps/server/src/app.test.ts` | 协议、配置、路由、版本同步、畸形 absolute-form 共 11 个测试 |
| `apps/server/src/env.test.ts` | 项目根 / `.env` 定位与“只加载传入文件”共 4 个测试 |
| `apps/web/src/api/health.ts` | `/api/health` 客户端；类型守卫 + 超时 / 中止 / 非 2xx / 非 JSON / 协议不符分别报错 |
| `apps/web/src/hooks/useHealth.ts` | loading / success / error 状态机，5 秒超时，切换轮次用派生加载态 |
| `apps/web/src/App.tsx` | 项目名 + 真实连接状态：连接中 / 已连接（服务名、版本、运行时长、延迟、检查时间）/ 连接失败（原因 + 重新检查） |
| `apps/web/src/components/ui/*` | shadcn 风格的 Button / Card / Badge（cva + `cn`），未安装 Radix——当前没有需要原语的交互 |
| `apps/web/src/index.css` | Tailwind v4 + shadcn 语义 token（`@theme inline`） |
| `apps/web/src/api/health.test.ts`、`src/App.test.tsx` | 协议与界面状态共 11 个测试 |
| `apps/web/test/vite-proxy.test.ts` | 根 `.env` 读取、键过滤、自定义端口的真实代理转发、客户端 env 不外泄共 4 个测试 |

Vite 开发服务器把 `/api` 代理到根 `.env` 里的 `VITE_SERVER_ORIGIN`（缺省 `http://127.0.0.1:8787`），页面与 server 同源，不放开 CORS。未创建 runtime / memory / connector / 插件目录（P0-03 起按包新增）。

## P0-02 检查证据

全部通过 `C:\Program Files\PowerShell\7\pwsh.exe -NoLogo -NoProfile` 执行，Node v24.13.0、npm 11.6.2、Git 2.52.0（与 P0-01 记录一致）。

| 命令 | 退出码 | 关键结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | server 与 web（含 `vite.config.ts`）无类型错误 |
| `npm run lint` | 0 | ESLint 无 error / warning |
| `npm run test:unit` | 0 | 30 个测试通过：server 15（含 400 回归与环境定位）、web 15（协议 8、代理与环境 4、界面 3） |
| `npm run build` | 0 | server `dist/index.js` 3.59 KB；web `index.html` 0.46 KB、CSS 13.87 KB、JS 254.57 KB（gzip 79.94 KB） |
| `npm run dev`（手动） | 运行中 | server `http://127.0.0.1:8787`、Vite `http://127.0.0.1:5173` 同时就绪 |
| `GET http://127.0.0.1:8787/api/health` | 200 | `{"status":"ok","service":"personal-agent-server","version":"0.1.0","uptimeSeconds":29.2,"checkedAt":"..."}` |
| `GET http://127.0.0.1:5173/` | 200 | 返回含 `id="root"` 的 HTML；`/src/main.tsx` 200 text/javascript，`/src/index.css` 200 |
| `GET http://127.0.0.1:5173/api/health` | 200 | 通过 Vite 代理拿到同一份真实 payload |
| `npm start`（构建产物） | 200 / 404 | `dist/index.js` 正常监听；`/api/health` 200，未知路径 404 |

本轮修复的真实失败：

1. `npm run typecheck` 退出 2：`health.test.ts` 里 `mock.mock.calls[0] as [string, RequestInit]` 在 `noUncheckedIndexedAccess` 下类型不合法。改为断言 `toHaveBeenCalledWith('/api/health', expect.objectContaining(...))`。
2. `npm run lint` 退出 1：`react-hooks/set-state-in-effect` 命中 `useHealth` 里同步 `setState({status:'loading'})`。改为按 `attempt` 派生加载态，effect 只在异步回调里 `setSettled`。

Codex 中途审查后的修复（同一包内，未扩展功能）：

3. `.env` 定位越界：原 `loadNearestEnvFile` 从 cwd 向上逐层扫描直到磁盘根，可能读到其他仓库的 `.env`。改为 `paths.ts` 固定推算项目根（`src` 与 `dist` 同深度，开发 / 构建一致），`env.ts` 只加载 `PROJECT_ROOT/.env` 这一个路径。实测两种运行方式都打印 `loaded env file: E:\agentcoding\personal agent\.env`。
4. 畸形请求行崩溃：`new URL(req.url, ...)` 对 `GET http://[` 抛 `TypeError [ERR_INVALID_URL]`，在请求处理器内属未捕获异常（真实进程会退出）。修复前测试已复现该异常；现改为 `resolvePathname` 捕获后返回 400 `{"error":"bad_request"}`。回归测试用原始 TCP 发送 `GET http://[ HTTP/1.1`，断言 400 且随后 `/api/health` 仍 200；在 `npm run dev` 的真实进程上也用 TcpClient 复验通过。
5. web 代理未按 `.env.example` 承诺生效：`vite.config.ts` 原来只读 `process.env`，而 Vite 默认 `envDir` 是 `apps/web`，根 `.env` 里的 `VITE_SERVER_ORIGIN` 根本不参与。现改为 `createConfig()` 显式从项目根 `loadEnv(mode, PROJECT_ROOT, 'VITE_SERVER_ORIGIN')` 取该键（前缀过滤，只返回一个键），进程环境变量优先；**未修改 `envDir`**，所以根 `.env` 的其他内容不会进入客户端 `import.meta.env`。新增 `apps/web/test/vite-proxy.test.ts` 用临时目录 `.env` + 真实 Vite 代理 + 目标服务复现并锁死该行为。

追加证据（修复后）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` / `lint` / `build` | 均退出 0 |
| `npm run test:unit` | 退出 0，30 个测试通过（server 15 + web 15） |
| 临时 `.env`（`PORT=8790`）+ `npm start` | 监听 8790，日志 `loaded env file: E:\agentcoding\personal agent\.env`，健康接口 200 |
| 同一 `.env` + `npm run dev:server` | 同样监听 8790、同一路径，证明 dev 与 build/start 定位一致 |
| 删除 `.env` 后 `npm run dev` | 回到默认 8787，无 “loaded env file” 输出；页面 200、代理 200 |
| 真实进程发 `GET http://[` | `HTTP/1.1 400 Bad Request`，随后 `/api/health` 200，进程未退出 |
| 根 `.env` 写 `PORT=8791` + `VITE_SERVER_ORIGIN=http://127.0.0.1:8791`，再 `npm run dev` | server 监听 8791、8787 无监听；`http://127.0.0.1:5173/api/health` 仍 200 且返回同一 server，证明代理确实跟随根 `.env` 的自定义端口；验证后删除 `.env` |
| `vite-proxy.test.ts` 临时 `.env` 混入 `API_SECRET`、`DATABASE_URL`、`VITE_OTHER` | `readProjectEnv` 只返回 `['VITE_SERVER_ORIGIN']`；`vite.config.env.VITE_OTHER` 为 `undefined`，客户端 env 不含 `top-secret` |

## P0-03 实际交付

| 路径 | 内容 |
| --- | --- |
| `apps/server/src/runtime/model.ts` | 只含 faux provider 的模型集合与确定性应答脚本；`FAUX_MODEL = faux/faux-1`，不读凭据、不联网、不计费 |
| `apps/server/src/runtime/tools.ts` | `createEchoTool()`（纯函数，`replay: "safe"`）、`createFileNoteTool()`（本地追加副作用，`replay: "unsafe"`） |
| `apps/server/src/runtime/runtime.ts` | `openRuntime()`：一个 SQLite 路径 + 一个 Harness + 一个根会话；显式注册扩展 `app.minimal`；`resume()` / `submit()` / `close()` |
| `apps/server/src/runtime/index.ts` | runtime 公共出口 |
| `apps/server/src/runtime/runtime.test.ts` | 真实 SQLite：提交结算、requestId 去重、关闭重开、重开后用原 requestId 重投、unsafe 单次副作用、clean shutdown（6 个测试） |
| `apps/server/src/runtime/recovery.test.ts` | 独立子进程 + 受控同步点的中断恢复（safe / unsafe 各 1 个测试） |
| `apps/server/src/runtime/startup.test.ts` | 真实 server 进程：启动恢复遗留工作、端口占用时退出非零并释放库（2 个测试） |
| `apps/server/test/helpers/proc.ts` | 测试子进程统一登记与回收：超时先 SIGKILL 再报错，`afterEach` 统一清理，不留数据库句柄 |
| `apps/server/test/fixtures/crash-child.ts` | 恢复测试子进程：写真实副作用 → 写 marker → 挂起；第二阶段重开同一库并落盘 transcript 摘要 |
| `apps/server/src/index.ts` | 启动即打开 runtime 并 `resume()`；启动失败（如 EADDRINUSE）先关 Harness / SQLite 再退出 1；SIGINT / SIGTERM 优雅关闭 |
| `apps/server/src/config.ts` | 新增可选 `RUNTIME_SQLITE_PATH` / `RUNTIME_NOTES_DIR`；非回环 `HOST` 仍直接报错 |
| `package.json`（根 / server） | 新增 `test:runtime`：只跑 `src/runtime` 子集；`test:unit` 仍覆盖同一批测试，不会静默漏掉 |

runtime 数据库默认落在 `apps/server/data/runtime.sqlite`（`data/`、`*.sqlite*` 已被忽略）。未引入 PG、人格、连接器或第二套任务循环。

## P0-03 检查证据（WorkBuddy 自查，待 Codex 独立复查）

| 命令 | 退出码 | 关键结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | server（含 `test/` 下的恢复子进程与 helpers）与 web 均无类型错误 |
| `npm run lint` | 0 | 0 error / 0 warning |
| `npm run test:unit` | 0 | 40 个测试：server 25（路由 11、环境 4、runtime 6、恢复 2、启动 2）+ web 15 |
| `npm run test:runtime` | 0 | 10 个测试（runtime 6 + 恢复 2 + 启动 2），约 17 s |
| `npm run build` | 0 | server / web 均成功 |
| `npm run dev`（手动） | 运行中 | 日志 `runtime resumed` + `runtime recovery settled` + `runtime ready: provider=faux/faux-1 ...`；健康接口 200、页面 200 |
| `node dist/index.js`（构建产物，临时库 + `PORT=0`） | 已退出 | 同样打印 `runtime resumed` / `runtime recovery settled` / `runtime ready`，说明 resume 已进产物 |

行为证据（全部为测试断言，不是文档推断）：

| 行为 | 证据 |
| --- | --- |
| 真实 SQLite 持久化 | 关闭后重开同一文件，根会话 `id` 不变、已有条目数不变；新提交继续追加 |
| 相同 requestId 去重 | 第二次 submit 返回同一 `submission.id`，工具执行次数仍为 1，transcript 条目数不增加 |
| 关闭重开后原 requestId 重投 | 重开（且不给任何脚本应答）后用同一 `requestId` 重投：仍是同一 `submission.id`、`status=done`、条目数不变、`notes.log` 仍 1 行；若被当作新请求会去请求模型并新增条目，测试会失败 |
| 真实 server 启动恢复 | 用真实 `src/index.ts` 进程打开“遗留中断工具”的库：启动即 `resume()`，日志出现 `runtime resumed` 与 `runtime recovery settled`；随后重开库可见一条 `interrupted` 工具回执，输入仍只有 1 条，生产 `RUNTIME_NOTES_DIR` 下没有任何写入（unsafe 工具未被重放） |
| 启动失败清理 | 占用端口后启动真实 server：进程退出码 1，输出含“已被占用”和 `runtime closed after failed start`；库上无 `-wal` / `-shm` 残留，且能立刻被重新打开，证明 Harness / SQLite 已关闭 |
| 检查点复用 + 安全重放 | 子进程在工具执行中 `SIGKILL`；重启后工具重跑（探针 `runs.log` 2 行），幂等副作用 `effects.log` 1 行、`safe-note.txt` 1 份；transcript 仍 5 条（`pi.user` 1、`pi.assistant` 2、`pi.tool-result` 1） |
| unsafe 不自动重放 | 重启后 `runs.log` 1 行、`effects.log` 1 行；`pi.tool-result` 的 `isError = true` 且 `diagnostics` 含 `interrupted`，回执文本不是成功文案 |
| 恢复后收敛 | 两个场景最终 `submission.status = "done"`，恢复后的应答来自脚本，未伪称副作用已撤回或 exactly-once |
| 断言有效性 | 变异检查：把子进程工具临时改成 `replay: "safe"` 后 unsafe 用例立即失败（`expected 2 to be 1`），证明断言能发现自动重放 |
| 同步方式 | 只用 `started.marker` / `submission.json` 等文件出现作为同步点，无 sleep 猜时序 |
| clean shutdown | `harness.closed` 以 `reason: "closed"` 结束，关闭后目录内无 `-wal` / `-shm` 残留 |
| 清理 | 测试用 `mkdtemp` 临时目录并在结束后删除；`test/helpers/proc.ts` 统一登记子进程，`afterEach` 回收，`waitForExit` 超时会先 SIGKILL 再报错，不会残留数据库句柄 |

Codex 审查后的 P0-03 返修（同一包内，未扩大功能）：

1. `@earendil-works/pi-durable` / `pi-ai` / `chord` 由 `^1.4.0` 改为精确 `1.4.0`，锁文件已同步重解析（`package-lock.json` 中三者均为 `1.4.0`）。
2. 启动恢复：`src/index.ts` 在打开 runtime 后调用 `resume()`，并用 `waitForIdle` 打出 `runtime recovery settled`；不再只在测试 fixture 里手动 resume。
3. 启动失败清理：`EADDRINUSE` 等 listen 错误改为 `failStart()`——先 `runtime.close()` 再 `process.exit(1)`，并补测试验证退出码、无 `-wal` / `-shm` 残留、库可立即重开。
4. 重投去重：新增“关闭重开 + 原 requestId 重投”测试，锁死同一 submission、历史不增长、副作用不重复（P0-04 的补投依赖）。
5. 子进程治理：新增 `test/helpers/proc.ts`，所有测试子进程统一登记；`waitForExit` 超时先 SIGKILL 再 reject；`afterEach` 调 `killAllProcs()`，`recovery.test.ts` 的第二个子进程也纳入管理。

## P0-04 实际交付

| 路径 | 内容 |
| --- | --- |
| `apps/server/src/pg/binaries.ts` | 二进制定位：`PG_BIN` 优先，其次平台可选依赖（Windows 的 `@embedded-postgres/windows-x64`）；缺失时给出可执行报错，不静默跳过 |
| `apps/server/src/pg/cluster.ts` | 直接用平台二进制 `initdb` / `pg_ctl` 管理集群（不经 embedded-postgres 包装器，避免它的 exit hook 改写退出码）；只允许回环监听；`pg_ctl -w`；fast shutdown |
| `apps/server/src/pg/dev-cluster.ts` | 开发集群：`apps/server/data/pg`（忽略）+ 随机密码存文件 + `cluster.json`（不含密码），并确保 `personal_agent` 库存在 |
| `apps/server/src/pg/config.ts` | 连接配置：`DATABASE_URL` 优先，其次本项目开发集群；对外只给出去掉密码的地址 |
| `apps/server/src/pg/connection.ts` | `pg.Pool` 封装与 `withTransaction` |
| `apps/server/src/pg/migrate.ts` | 迁移执行器：`schema_migrations`、逐条事务、advisory lock 串行化、已应用迁移校验和不一致即报错 |
| `apps/server/migrations/*.sql` | `0001_init`（`inbound_event` / `dispatch_outbox` / `job`）、`0002_claim_index`（按会话 claim 的索引）、`0003_drop_job_submission_unique`（submission id 只在所属 Pi 库内有意义） |
| `apps/server/src/inbound/ingest.ts` | 同一事务写入站事件 + outbox；`(source, external_id)` 唯一；requestId = hash(source, externalId, **conversationKey**)；重投读原记录；同身份不同 payload 抛 `PayloadConflictError` |
| `apps/server/src/dispatch/dispatcher.ts` | claim（按 `conversation_key` + `FOR UPDATE SKIP LOCKED` + 租约）、真实 `conversation.submit` 只受理、立刻写映射；写回与释放都校验 `owner + attempts + lease_until > now()`；目标必须与 runtime 绑定一致 |
| `apps/server/src/runtime/runtime.ts` | 新增 `accept()`（只持久受理、不等结算）与 `conversationKey` 绑定；`submit()` 仍保留给需要结算的调用方 |
| `apps/server/src/cli/db.ts` | `pg:start` / `pg:stop` / `pg:status` / `db:migrate` 四个可执行入口 |
| `apps/server/src/index.ts` | 启动连接 PG 并打印 `postgres ready ... migrations=N`；启动失败与关闭都会关闭 Harness / SQLite / PG 连接池 |
| 集成测试 | `migrate`(3)、`ingest`(6)、`dispatcher`(9)、`crash`(1)、`runtime/startup`(2) = 21 |
| 测试基础设施 | `vitest.integration.config.ts` + `global-setup.ts`（`TEST_DATABASE_URL` > `PG_BIN` 自建集群 > Windows 可选依赖；失败也清理进程与目录）+ `database.ts`（每文件独立库，建库/迁移失败也回收连接与库） |
| 脚本 | `test:integration`、`check`（typecheck → lint → unit → integration → build）、`pg:start/stop/status`、`db:migrate` |

## P0-04 检查证据（WorkBuddy 自查，待 Codex 独立复查）

| 命令 | 退出码 | 关键结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | server / web 均无类型错误（跨平台动态导入，不在编译期解析 Windows 专属包） |
| `npm run lint` | 0 | 0 error / 0 warning |
| `npm run test:unit` | 0 | 42 个：server 27（路由 11、环境 4、runtime 6、恢复 2、二进制 3、…）+ web 15 |
| `npm run test:integration` | 0 | 21 个：迁移 3、入站 6、派发 9、崩溃 1、真实 server 2 |
| `npm run build` | 0 | server / web 均成功 |
| `npm run check` | 0 | 串起 typecheck + lint + unit + integration + build，全绿 |
| `npm run pg:start` | 0 | `postgres running at postgres://127.0.0.1:55434/personal_agent`（首次 initdb + start），密码只写忽略文件 |
| `npm run db:migrate`（三次） | 0 | 首次 `applied=["0001_init"]`；以后 `applied=["0002_claim_index","0003_drop_job_submission_unique"]`、再次全 skipped，幂等 |
| `npm run dev`（手动） | 运行中 | `postgres ready: ... migrations=3` + `runtime ready` + `listening on 8787`；页面 5173 返回 200，`/api/health` 与代理均 200 |

行为证据（全部为断言，不是文档推断）：

| 行为 | 证据 |
| --- | --- |
| 迁移事务性 | 坏迁移（先建表再查不存在的表）整条回滚：`gamma` 未创建、`schema_migrations` 只记 0001/0002 |
| 迁移不可篡改 | 已应用文件被改写后 `runMigrations` 抛“校验和不一致”，不静默跳过 |
| 入站同事务 | 首次投递后事件与 outbox 各 1 条；outbox 复用已存在 ID 时整体回滚，事件不残留 |
| 事件重投 | 相同 `(source, external_id)` + 相同 payload 返回原记录（`created=false`），表内仍各 1 条；并发重投只有 1 次 `created=true` |
| 身份冲突 | 同身份不同 payload 抛 `PayloadConflictError`，库内 payload 未被覆盖 |
| 真实派发 | `job.pi_submission_id` 等于 Pi 返回的真实 submission id；`job.status` 停在 `dispatched`（受理≠完成） |
| 受理与执行分离 | 工具永久阻塞时 `dispatchOnce` 已经返回 `accepted` 并写好 job（`pi_status=accepted`），`inspect()` 仍有活动任务——证明没有等结算 |
| 多目标隔离 | 给 `owner:target-b` 的事件不会被绑 `owner:target-a` 的 dispatcher 领取，保持 `pending` 且无 job；目标与 runtime 绑定不一致时直接抛错 |
| requestId 含目标 | 同一事件投两个会话得到两个不同 requestId、两条 outbox；重投同一会话仍返回原记录 |
| 租约 fencing | 旧 claim（attempts=1）在过期、被 attempts=2 重新领取后：`saveMapping` 返回 false、不产生 job；`releaseClaim` 返回 false，新租约与 `last_error` 未被改动 |
| 忙碌策略 | 工具真的在跑时派发：`whenBusy: 'reject'` → `failed / conversation_busy / willRetry=true`，outbox 回 pending；放行后重试成功受理 |
| 失败可恢复 | 受理抛错时释放租约、写 `last_error`、状态回 `pending`；达到 `maxAttempts` 才转 `failed`，且不写 `job` |
| 两库崩溃窗口 | 子进程在“Pi 已受理、PG 未写映射”时被 SIGKILL：重启后 PG 无 job、outbox 仍 pending（attempts=1）；租约过期后补投拿到**同一个 submission**，最终 1 个 job、attempts=2、Pi transcript 只有 1 条用户输入和 1 条工具结果 |
| 断言有效性 | 变异检查：把派发 requestId 改成带随机后缀后，崩溃用例立即失败（submission `17` ≠ `8`），还原后集成测试重新全绿 |
| 平台无关依赖 | `@embedded-postgres/windows-x64` 放在 `optionalDependencies`（锁文件已同步），Linux 上 `npm ci` 不会 EBADPLATFORM；缺二进制时集成测试报错而非跳过 |

Codex 审查后的 P0-04 返修（同一包内，未扩大功能）：

1. **受理与执行分离**：`dispatchOnce` 改用 `runtime.accept()`（内部是真实 `conversation.submit` 取 Submission），拿到受理就写映射；不再 `wait` 结算。`whenBusy` 显式默认 `reject`，忙碌记为 `conversation_busy` 并可重试。
2. **租约 fencing**：`attempts` 作为本次 claim 的 token，写回与释放条件统一为 `status='pending' and lease_owner=$me and attempts=$token and lease_until > now()`；`existingJob` 分支同样检查更新行数，返回 false 即 `lease_lost`。
3. **多会话合同**：`stableRequestId(source, externalId, conversationKey)`；claim 按 `conversation_key` 过滤；`openRuntime` 增加 `conversationKey`，dispatcher 目标与 runtime 绑定不一致直接拒绝；未新增人格表。
4. **测试基础设施清理**：global setup 在 initdb / start 失败时先停集群再删目录；`createTestDatabase` 在建库或迁移失败时关闭池、删库；集成套件失败不再残留 `pg-it-*` 目录（本次已清理 13 个历史残留）。
5. **平台依赖可选**：Windows 二进制改为 `optionalDependencies` + `PG_BIN` 覆盖 + `TEST_DATABASE_URL` 外部库接入；`binaries.ts` 动态导入并给出可执行报错。
6. 顺带修正：`job_submission_unique (pi_conversation_id, pi_submission_id)` 在“同一 PG 多个 Pi 库”场景下不成立（不同库的 submission id 会重复），以 `0003` 迁移移除；同一 outbox 一条 job 仍由 `dispatch_outbox_id` 唯一约束保证。

## 实际版本与启动方式

Node v24.13.0、npm 11.6.2；`@earendil-works/pi-durable` / `pi-ai` / `chord` 三者**精确锁定 1.4.0**（SQLite 走 Node 内置 `node:sqlite`）；**PostgreSQL 18.4**（`@embedded-postgres/windows-x64@18.4.0-beta.17` 只作二进制分发，实际用 `initdb` / `pg_ctl`）+ `pg` 8.23.1 驱动；TypeScript 6.0.3、React 19.3.1、Vite 8.3.5、Tailwind 4.3.3、Radix 未装、ESLint 10.13.0、Vitest 5.0.5、tsup 9.0.0、tsx 4.23.15、concurrently 10.0.6。全部为项目本地依赖。

```powershell
cd "E:\agentcoding\personal agent"
npm install          # 首次或锁文件变更后
npm run pg:start     # 初始化并启动本项目开发库（127.0.0.1:55434，密码在忽略文件）
npm run db:migrate   # 应用 migrations，重复运行只跳过
npm run dev          # server 8787（PG + runtime）+ web 5173
# 打开 http://127.0.0.1:5173 ；server 日志应含 postgres ready / runtime ready
npm run check        # typecheck → lint → unit → integration → build
npm run test:integration  # 只跑真实 PG 集成测试（自建临时集群；也可 TEST_DATABASE_URL / PG_BIN）
npm run pg:stop      # fast shutdown
```

非 Windows 平台：

```bash
export PG_BIN=/usr/lib/postgresql/18/bin      # 或用 TEST_DATABASE_URL 指向外部真实库
npm run test:integration                      # 缺配置会直接报错，不会静默跳过
```

## 未验证 / 已知限制

- 真实浏览器渲染未验收：本会话没有可用的浏览器控制技能，只验证到 HTTP 200、Vite 模块转换、构建产物与 jsdom 组件测试；像素级外观、字体与 360px 窄屏需人工或 Codex 打开页面确认。
- 深色主题、200% 缩放、减少动效未实现 / 未测（按 BP-04 在 P1 起验收）。
- 生产构建没有静态托管：web `dist` 需由后续 server 或反向代理提供，本包不做。
- 未引入 Prettier / 格式化检查；`npm run test:integration` 已建立并覆盖所需数据库检查，`npm run check` 串起全部入口。
- 环境缺项分两类：Docker Engine **已确认不可用**（实测连接失败，未重置全局配置）；PostgreSQL 现在**已在本项目内真实可用**（PG 18.4，127.0.0.1:55434），系统级 PG 仍为**未验证**（`psql` 不在 PATH，未安装、未连接系统实例）。
- P0-04 的数据库限制：只建了 `inbound_event` / `dispatch_outbox` / `job` 三张表，人格 / 记忆 / 审批 / 连接器留待对应包；会话合同是“一个 runtime 绑定一个 `conversation_key`、一个 dispatcher 只领取该键”，尚无 PG 里的 `conversation_binding` 表（P1 落）；没有入站 HTTP API 或后台 dispatcher 循环，派发由 CLI / 测试驱动（P1-01 接入）；`job.status` 停在 `dispatched`，`pi_status` 目前只记 `accepted`，完成态对账留到后续包。
- P0-04 的平台接入：Windows 二进制是**可选依赖**；其他平台需设 `PG_BIN`（指向 initdb/pg_ctl），或给集成测试设 `TEST_DATABASE_URL` 用外部真实库；两种情况都不会静默跳过数据库测试（缺配置直接报错）。
- P0-04 的本机约束：55432 被 Windows 端口策略拒绝（`bind: Permission denied`），默认端口改为 55434（`PG_PORT` 可覆盖）；`initdb` 在系统临时目录无法改权限，测试集群建在 `apps/server/data/pg-it-*` 并在结束时删除；开发 PG 与 dev 服务需在同一进程树里（本机由后台任务一并启动），宿主回收后需重新 `npm run pg:start`。
- P0-03 的 runtime 限制：**不是真实模型**（faux 只回放脚本，未验证真实模型路由、成本、流式与上下文窗口）；没有 HTTP 对话 / SSE 接口，页面不经过 runtime（P1-01 才做）；单进程 + 单 SQLite，两个进程同时打开同一路径未验证（上游无跨进程锁）；恢复只覆盖“工具执行中被打断”窗口，出站前 / 回执后 / 业务提交失败等窗口属 P1-02 / P0-04；`node:sqlite` 仍打印 ExperimentalWarning。
- **Windows 无法向控制台子进程投递 SIGTERM**：`child.kill('SIGTERM')` 在 Windows 上等同于强制终止，实测退出码为 `null` 且不触发 `shutdown()`。因此“启动恢复”测试改用强杀后重开库验证（同时证明 WAL 可恢复）；优雅关闭由 runtime 单测的 `harness.close()` 与“启动失败清理”用例覆盖，真实终端 Ctrl+C 路径未自动化。
- 未做 Git 提交 / 推送、未部署、未接账号或付费模型；未创建或提交任何真实 `.env`（`.env.example` 可提交）。

## 上游与研究证据

- Pi：72363383ff79d3f12cfa91b03cddb3eb333c6ebc，已核对包及 npm 1.4.0；P0-03 已实际安装并运行 `@earendil-works/pi-durable@1.4.0` 及同组 `pi-ai` / `chord`。
- P0-03 按上游 README 与 `dist/*.d.ts` 核对后使用：`Harness.open` / `root` / `submit` + `requestId` / `submission.wait` / `harness.submission` / `resume` / `close` / `defineTool.replay` / `openNodeSqliteStorage`；没有凭记忆编造 API，也没有另写主循环。
- QzoneUltra：4221713b508bf2a88e43e75d1719458d2f69764f，找到独立 daemon，未运行。
- durable-pi：37165c619573dbaf425463038bbffecfe576beec，使用 1.0.3，只作参考。
- Hindsight：0df5398efe63211bd21638f3c5378b9c241b0001；Mem0：26cdefb46600c0fa5953c4b5ee5003c125539fc4；Graphiti：2b5db9e139b2627c3ba18ff55f9181569b0d8224。已做部分关键源码静态阅读，未复现效果。
- agent-browser、noVNC、LiveKit、OpenComputer / OpenMuse 等仍是文档级候选。

## 权威文件

- [总设计案](PERSONAL_AGENT_PLAN.md)：目标、架构与来源。
- [完整个人功能清单](GROK_PARITY.md)：发布分母。
- [蓝图索引](BLUEPRINT.md)：阶段与退出条件。
- [开发工作包](DEVELOPMENT_ROADMAP.md)：24 个包的顺序、范围和验收。
- [Codex 使用手册](CODEX_DEVELOPMENT_GUIDE.md)：实际提示词、试用、审查和续接。
- [BP-01](design/BP-01-runtime-persona-memory.md)、[BP-02](design/BP-02-computer-artifacts.md)、[BP-03](design/BP-03-connectors-plugins.md)、[BP-04](design/BP-04-workbench-voice.md)、[BP-05](design/BP-05-skills-automation-learning.md)：各领域实现合同。
- [长期记忆研究](research/LONG_TERM_MEMORY_RESEARCH.md)：记忆服务及评估依据。
- [技术选型历史](TECH_SELECTION.md)：保留依据，不重新发起主框架选择。

## Codex 监督与独立复查（2026-10-28 20:51，Asia/Shanghai）

- 开发执行方：WorkBuddy 桌面 5.9.3，任务“实现 P0-02 最小工程并更新任务文档”；界面模型与最终答复标记均为 `DeepSeek-V4.1-Flash`。任务范围见 `WORKBUDDY_TASK.md`。开发推理使用 WorkBuddy 模型，不等于产品已接入真实模型 API。
- Codex 读代码后交回 WorkBuddy 修复了项目外 `.env` 扫描、畸形 URL 未捕获异常，以及根 `.env` 未驱动 web 代理三个问题；对应验证已加入。本地另补齐 `.sqlite3` / `.db` 的 WAL、SHM、journal 忽略规则，并通过 `git check-ignore` 实测；`.env.example` 未被忽略。
- Codex 独立运行 `npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run build`，四项退出码均为 0；30 个测试通过（server 15 + web 15）。没有把 WorkBuddy 的自报结果替代独立检查。
- 独立 HTTP 检查：`http://127.0.0.1:5173/` 返回 200 且含页面挂载点；`http://127.0.0.1:8787/api/health` 与 `http://127.0.0.1:5173/api/health` 均返回 200 及 `personal-agent-server` 的有效载荷。监听表确认两个端口均绑定 `127.0.0.1`。临时根 `.env` 已清理，无 Git 提交。
- 浏览器验收阻塞：Codex 浏览器插件启动与一次重试均报缺少 `openai-bundled/browser/26.1021.31345/scripts/browser-service.mjs`，连接在选择 Edge / in-app 浏览器之前失败。已检查现有插件目录及启动排障说明；未拼接不同版本文件或修改插件内部实现。HTTP、jsdom 与构建证据不能代替真实浏览器外观、布局和交互验收，该项继续开放。
- WorkBuddy 保留 dev 后台任务 `oa7vx4`；以上端口存活仅代表检查时刻。若任务宿主回收进程，在项目根执行 `npm run dev` 重新启动。

## 未完成事项与下一步

- P0-04 待 Codex 独立复查：`npm run check`（typecheck / lint / unit 42 / integration 21 / build）、`npm run pg:start` + `npm run db:migrate`（应只 applied 0002/0003 或全 skipped）、`npm run dev` 的 `postgres ready ... migrations=3` 日志，以及 `apps/server/data` 是否全部处于忽略状态。
- 下一包 P1-01（人格与最小聊天）的前置已经具备：真实 PG、迁移、outbox 与真实 Pi 派发链路；P1-01 需要在此之上加入 profile / conversation_binding、入站 HTTP API 与 SSE。
- dev 服务与开发 PG 已一起保留在 8787 / 5173 / 55434；若宿主回收进程，在项目根依次执行 `npm run pg:start`、`npm run db:migrate`、`npm run dev`。
- 已有包内授权继续完成，不逐文件重复确认；全局环境和外部动作按具体授权处理。

可复制续接指令：

> 按 DEVELOPMENT_ROADMAP.md 完成 P1-01。先读 AGENTS.md 与 NEXT.md；在现有 PG / migrations / outbox / Pi runtime 上加入 profile、conversation_binding 与最小聊天 API，不接真实平台账号或付费模型；完成后更新 NEXT 并给实际试用步骤。

采用 blueprint-set，五个领域不变，实施期持久子蓝图预算为 0，无活动临时问题支线。
