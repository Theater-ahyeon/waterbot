# Waterbot

一个住在 QQ 群里的长期成员，同时也是只服务主人的私人助理。

它有自己的性格，被 @ 时能读懂上下文，能带着时间和原话翻旧账，也能联网查证并给出来源。私聊时，它是只听主人一个人的外脑。

> **当前状态：真实 QQ 与真实模型已接通，仍在验收期。**
> 已用专用小号 QQ 3559394058 + SnowLuma 验证私聊、群聊和本地 OpenAI 兼容端点；完整验收（7 次计数、跨群隔离、提示注入、重启和长期运行）尚未完成。详见[开发进度](#开发进度)。

## 为什么做这个

普通群聊机器人大多记不住事，或者把所有内容混在一起。Waterbot 想解决的是这几件事：

- **翻旧账要有证据。** “他说过几次”由数据库统计，不让模型估算，并给出原话和时间。
- **查证要有来源。** 联网结果保留链接；查不到就说查不到。
- **记忆有边界。** 私聊内容绝不进群，A 群查不到 B 群。
- **权限不靠提示词。** 模型根本拿不到无权读取的数据，而不是拿到后再叮嘱它别说。

## 功能

功能已通过模拟环境测试；真实账号和真实模型的冒烟结果见[开发进度](#开发进度)，完整验收尚未完成。

### 群聊

- 被 @ 或回复 Bot 时才调用模型，其余消息只存档
- 接入的群全量存档，掉线缺口单独记录；Bot 自己的发言也按平台回执补档
- 平台撤回后停止检索和统计，原文保留
- 上下文按顺序取：引用链 → 最近消息 → 相关旧消息 → 长期记忆
- 被 @ 或回复的对话会在后台提取 `reported` 群记忆，保留原消息 ID
- 每群可设 24 小时 token 上限，超额只存档不回复
- 查询群记录，由数据库统计次数，返回原话、时间和发言人
- 每群设置每小时回复上限，超额后只存档不回复

### 主人私聊

- 查询私聊记忆和已接入群的记录
- 发送下面的命令管理 Bot，这些命令不经过模型，立即生效

| 命令 | 作用 |
| --- | --- |
| `接入群 <群号>` | 开始存档并允许在该群回复 |
| `暂停群 <群号>` / `恢复群 <群号>` | 暂停或恢复该群的回复，存档照常 |
| `全部停止` / `全部恢复` | 停止或恢复所有新回复，已发出的消息不会撤回 |
| `记住：<内容>` | 写入长期记忆 |
| `忘掉：<内容>` | 停止使用包含该文字的记忆 |
| `你记得什么` | 列出当前记忆 |
| `忘掉人 <QQ号>` | 停止使用某人的群记录 |
| `忘掉群 <群号>` | 停止使用某群的记录和记忆 |

“忘掉”只是停止召回和统计，原文仍保留，不是物理删除。

### 多 Bot 协作

- 创建由多个人格组成的 Bot 群，owner 或 Bot 发起任务
- Bot 通过 `send_bot_message` 把任务交给同群另一个成员，消息和任务 lineage 可查
- 同一工具调用 ID 重投不会重复建任务；非成员和停止状态拒绝新任务
- `send_bot_message` 只注入 Bot 群会话，QQ 群和 owner 私聊看不到

### QQ 空间

- 只读拉取 Bot 自己的说说并缓存，保留 tid、正文、时间、图片、评论数和可见性
- 重复刷新更新原记录，不重复插入；登录失效标记 `paused` 并保留旧缓存
- 评论走 Action：有效 policy 自动发，范围外待审，过期 / 超时 / 撤权不补发
- `QZONE_ALLOW_WRITE` 默认关闭；没有点赞、删除或发表入口

### 执行与产物

- owner 提交命令，由独立 worker 在工作区执行，控制库凭据不传给 worker
- 输出、退出码、超时、取消和产物索引可查；产物可下载
- server 重启时遗留 running 任务标记失败，不假装继续

### MCP

- stdio MCP 服务连接、工具发现、逐工具开关和按人格绑定
- `mcp_call` 只在 owner 私聊注入，QQ 群和 Bot 群看不到
- 调用记录保留服务、工具、参数和状态；未绑定或工具关闭时拒绝

### 技能

- 每个 Bot 可保存带版本的步骤文本，启用后注入下一次会话
- 修改 / 启停下一轮生效；最多 5 条，总计 4000 字
- 技能是提示内容，不直接授予工具或账号权限

### 例行任务

- 结构化触发：一次、间隔、每天、每周、具名事件和 webhook
- 时区保存 IANA 名称，夏令时缺失时刻跳过，重复时刻只执行一次
- 同一槽位、同一事件 ID 只产生一次运行；错过运行可跳过、合并或限量补跑
- 24 小时 token 预算耗尽后自动暂停；暂停只停止未来触发
- 运行历史记录发生时间、状态、token 和错误；删除前要求没有未完成运行

### 文档与 Pages

- 生成真实 `.docx`、`.xlsx`、`.pptx` 文件，修订递增版本，旧版本仍可下载
- 文档和产物按人格隔离；下载路径只允许工作区和文档目录
- Page 使用结构化内容（标题、文本、列表、指标、表格、图表），每次修改保留版本
- 发布生成独立只读副本和随机链接；页面内容转义，脚本运行在 sandbox 源
- `update_page` 工具只在主人私聊注入，例行任务也可以更新指定页面；取消发布立即失效

### 浏览器

- 每个 Bot 使用独立的持久 Edge / Chrome profile，不导入用户日常浏览器资料
- 读取标题、可访问树和可操作元素引用；支持点击、输入和整页截图
- `browser_*` 工具只在主人私聊注入；人工接管期间 agent 操作被拒绝
- 没有密码 / 验证码秘密输入面板；不要把秘密交给 `browser_type`，快照不回显输入值不等于秘密不进入上下文
- 默认拒绝本机和私有网段；只有显式配置的测试环境可以访问
- 桌面画面、原生输入、本机设备桥和硬件密钥仍未实现

### GitHub 只读连接器

- 读取公共仓库元数据和 issue / pull request 列表；公共仓库不需要 token
- 私有仓库或更高额度使用 `GITHUB_TOKEN`；token 不进响应、日志或模型上下文
- `github_*` 工具只在主人私聊注入；没有评论、合并、推送或任何写入路径
- GitHub Enterprise 或测试环境通过 `GITHUB_API_BASE` 覆盖 API 根地址

### 具名连接器

- Notion：搜索、读取页面和块、追加段落
- Slack：频道、消息读取和发消息
- X：只读 Bearer token 搜索和用户时间线
- B 站：WBI 签名的公开搜索、视频、评论读取，以及 Cookie + `bili_jct` 的评论动作
- 日历：CalDAV 事件读取和创建
- 邮箱：IMAP 收件箱 / 邮件读取，SMTP 发送
- 所有写入先进入 Action 审批或已授权规则，再调用上游；读取工具只在主人私聊注入
- 凭据只从环境变量读取，不返回、不写入模型上下文；其他供应商按同一注册表扩展

### 语音留言

- OpenAI 兼容的语音转写和语音合成端点，可分别配置
- 录音上传后转写为文本；文本合成后写入产物并可下载
- 未配置时接口明确返回失败，不伪造语音结果
- 实时通话、打断、手机端原生录音和通知仍未实现

### 工作台

本机网页界面包含六个入口：

- 对话：多人格切换、草稿保留、SSE 更新、动作审批记录
- 例行任务：创建、暂停 / 恢复、立即运行、运行历史和预算
- 资料库：生成 / 修订文档，创建 / 修订 / 发布 / 撤销 Pages，下载产物
- 工具与执行：技能启停、MCP 服务发现 / 逐工具开关 / 按人格绑定、远程执行和产物
- 设置与组织：模板新建、复制、归档 / 恢复、统一搜索、主题 / 密度 / 时区、用量和服务状态
- 记忆管理、Bot 群和 QQ 空间仍只有 HTTP API，没有界面

## 安全边界

| 规则 | 实现方式 |
| --- | --- |
| 身份只认平台字段 | 主人身份只比对 OneBot 的 `user_id`，昵称和消息正文不参与 |
| 作用域由服务端决定 | 写在会话绑定里，查询先按作用域过滤；工具没有“群”这个参数 |
| 群消息不是指令 | 群友说“记住”“全部停止”都只是普通聊天 |
| 群友能力受限 | 模型只有查群记录和公开搜索两个工具 |
| 记忆不进对话历史 | 只注入当次模型请求，纠正和忘记下一轮立即生效 |
| 外发默认关闭 | 必须设置 `QQ_ALLOW_SEND=1`，否则只接收不发送 |
| 结果不明不补发 | 发送超时记为 `unknown`，不会自动重发 |
| 可追溯 | 每次模型请求保存 ContextManifest，记录用了哪些记忆、消息和版本 |

已知例外：主人在普通聊天里说过的原话仍留在 Pi 对话历史中，纠正和忘记不会改动它。

## 架构

```text
QQ 群 / 私聊 ── OneBot v11 ──┐
                            ├─> 入站事件 + outbox ─> Pi Durable ─> 回复 ─> Action ─> 发送
本机工作台 ── HTTP / SSE ────┘      (PostgreSQL)      (SQLite)           (审批 / 限额)
                                                          ▲
                                              每次请求按作用域注入
                                                 记忆 + 群记录
```

| 存储 | 保存什么 |
| --- | --- |
| Pi 运行库（SQLite） | 对话记录、任务检查点、工具调用 |
| 业务库（PostgreSQL） | 人格、记忆、群消息存档、动作、会话绑定 |

两个库之间没有跨库事务，靠稳定请求 ID、outbox 和对账衔接，不宣称 exactly-once。

**使用的技术：** Node.js、TypeScript、[Pi Durable](https://github.com/earendil-works/pi)、PostgreSQL 18、React、Vite、Tailwind CSS、Vitest。

## 快速开始

需要 Node.js 22.19 或更高版本。Windows x64 会通过 npm 自动获得 PostgreSQL 二进制，不用单独安装。

```powershell
git clone https://github.com/Theater-ahyeon/waterbot.git
cd waterbot
npm install
npm run pg:start     # 初始化并启动本项目的开发数据库
npm run db:migrate   # 应用数据库迁移，可重复运行
npm run dev          # 启动 server（8787）和网页（5173）
```

打开 <http://127.0.0.1:5173>，访问码在 `apps/server/data/owner-key` 文件里，首次启动时生成。

用完后运行 `npm run pg:stop` 停止数据库。

其他平台需要自备 PostgreSQL，把 `PG_BIN` 指向 `initdb` 和 `pg_ctl` 所在目录，或用 `DATABASE_URL` 指向现有数据库。以上流程目前只在 Windows 上跑过。

## 配置

复制 `.env.example` 为项目根目录的 `.env`。不配置也能运行本机工作台。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 只允许回环地址 |
| `DATABASE_URL` | 开发数据库 | 业务库连接地址 |
| `ONEBOT_WS_URL` | 无 | OneBot 正向 WebSocket 地址 |
| `ONEBOT_ACCESS_TOKEN` | 无 | OneBot 访问令牌 |
| `QQ_BOT_ID` | 无 | Bot 的 QQ 号，必须是专用小号 |
| `QQ_OWNER_ID` | 无 | 主人的 QQ 号 |
| `QQ_PROFILE_ID` | 第一个人格 | Bot 使用的人格 |
| `QQ_ALLOW_SEND` | 关闭 | 设为 `1` 才会向 QQ 发消息 |
| `QQ_DAILY_TOKEN_LIMIT` | `0` | 每个 QQ 会话 24 小时 token 上限；`0` 不限制，超额只存档 |
| `QZONE_ALLOW_WRITE` | 关闭 | 设为 `1` 才允许已批准的 QQ 空间评论真正发出 |
| `OPENAI_BASE_URL` | 无 | OpenAI Completions 兼容端点；三项全填才启用真实模型 |
| `OPENAI_API_KEY` | 无 | 模型端点密钥 |
| `MODEL_ID` | 无 | 模型 ID，例如 `antigravity/gemini-3.8-flash`；`OPENAI_MODEL` 优先 |
| `SEARCH_DISABLED` | 关闭 | 设为 `1` 关闭联网搜索 |
| `SEARCH_DAILY_LIMIT` | `100` | 每 24 小时的搜索上限 |
| `TAVILY_API_KEY` | 无 | 填了就改用 Tavily，否则用 Bing |

`ONEBOT_WS_URL`、`QQ_BOT_ID`、`QQ_OWNER_ID` 要么全填，要么全不填。`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`MODEL_ID` 也一样；三项全空时使用 faux 演示模型。

### 接入 QQ（已用小号 + SnowLuma 冒烟）

1. 准备专用 QQ 小号，不要用主号。
2. 单独运行支持 OneBot v11 的协议端（本机验证使用 SnowLuma；[NapCat](https://github.com/NapNeko/NapCatQQ) 是候选），开启正向 WebSocket。
3. 在 `.env` 填好上面三项，先不要设置 `QQ_ALLOW_SEND`。
4. 私聊 Bot 发送 `接入群 <群号>`。
5. 用 `GET /api/qq/status` 查看连接状态和掉线缺口（需要登录）。

进入真实群前，请告知群友消息会被全量保存；确认模型和人格配置后再打开 `QQ_ALLOW_SEND`。模型调用失败时 Bot 会直接说明，不会编造回答。

### 联网搜索

默认使用 Bing，免注册、免密钥。查询词会发送给 Bing，群友 @ Bot 也可以触发。这个接口不是 Bing 公开承诺的，可能失效；失效时 Bot 会说明查不了，可以改配 Tavily。模型读到的只是搜索摘要，不是网页全文。

## 开发

```powershell
npm run check             # 类型检查 → lint → 单元测试 → 集成测试 → 构建
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration  # 用真实 PostgreSQL，会自建临时集群
npm run test:runtime      # 只跑 Pi 运行时测试
npm run build
```

默认测试不连接真实账号，也不产生费用。手动验证真实搜索：

```powershell
cd apps/server
npx tsx test/live-search.ts "查询词"
```

### 备份与恢复

```powershell
$env:BACKUP_PASSPHRASE="至少十二个字符的口令"
npm run backup -- --out backups/waterbot.wbk
npm run restore -- --from backups/waterbot.wbk
```

备份是逐表 JSON 后 AES-256-GCM 加密；恢复会清空目标库业务表再回填，`schema_migrations` 保留。恢复需要数据库账号允许 `session_replication_role`，开发库的 `postgres` 账号满足。恢复前先停 server，避免并发写入。

### 目录结构

```text
apps/server/
  migrations/         数据库迁移
  src/
    runtime/          Pi Durable 运行时
    dispatch/         outbox 派发
    inbound/          入站事件
    pg/               PostgreSQL 集群与迁移
    qq/               OneBot 解析、连接、路由
    actions.ts        动作、规则、审批、过期扫描
    archive.ts        群消息存档、检索、Bot 补档与撤回
    memory.ts         记忆与上下文编译
    memory-context.ts 模型请求钩子
    memory-extraction.ts 群记忆提取队列
    usage.ts          模型用量与每日预算
    status.ts         运维状态汇总
    backup.ts         加密逻辑备份与恢复
    search.ts         联网搜索
apps/web/             本机工作台
design/               各领域设计合同
research/             调研资料
```

### 主要 HTTP API

全部只监听本机。除健康检查和登录外都需要登录。

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /api/login` / `POST /api/logout` | 登录和退出 |
| `GET` `POST /api/profiles` | 人格列表（可含归档）和创建 |
| `POST /api/profiles/:id/copy` | 复制人格；默认不带技能和任何数据 |
| `DELETE /api/profiles/:id` / `POST /restore` | 归档或恢复人格；归档暂停例行任务 |
| `GET /api/templates` | 内置人格模板目录 |
| `GET` `PUT /api/settings` | 读取或保存时区、主题、密度和通知 |
| `GET /api/search?q=` | 工作台统一搜索；可按人格过滤 |
| `GET` `POST /api/profiles/:id/messages` | 聊天记录和发送 |
| `GET /api/profiles/:id/events` | SSE 实时更新 |
| `GET` `POST /api/profiles/:id/actions` | 动作列表和提案 |
| `POST /api/actions/:id/decision` | 审批动作 |
| `GET` `POST /api/profiles/:id/memories` | 记忆列表和写入 |
| `POST /api/memories/:id/revisions` | 纠正记忆 |
| `POST /api/memories/:id/forget` | 忘记记忆；同时使旧 epoch 的待执行动作失效 |
| `POST /api/memories/:id/purge` | 物理清除记忆与来源；不删除 Pi 对话历史 |
| `GET /api/profiles/:id/context-manifests` | 查看模型请求用了什么 |
| `GET /api/profiles/:id/usage` | 按日查看 token 与费用 |
| `GET /api/status` | PG、队列、动作、提取、用量、QQ 与缺口的只读汇总 |
| `GET` `POST /api/bot-groups` | Bot 群列表和创建 |
| `GET /api/bot-groups/:id` | 群、成员和任务 |
| `GET` `POST /api/bot-groups/:id/messages` | 消息列表和发起任务 |
| `GET /api/bot-groups/:id/tasks` | 任务 lineage |
| `POST /api/bot-groups/:id/stop` / `resume` | 停止或恢复新任务 |
| `GET /api/qzone/posts` | 已缓存的 QQ 空间说说 |
| `POST /api/qzone/refresh` | 只读拉取指定账号的说说 |
| `POST /api/qzone/comments` | 提交评论动作；有 policy 自动，无 policy 待审 |
| `GET /api/qzone/status` | 空间读取状态和上次错误 |
| `GET` `POST /api/profiles/:id/executions` | 执行任务列表和提交 |
| `GET /api/executions/:id` / `cancel` | 任务状态和取消 |
| `GET /api/executions/:id/artifacts` | 产物列表 |
| `GET /api/artifacts/:id/download` | 下载产物 |
| `GET /api/profiles/:id/browser` / `snapshot` | 浏览器状态和可访问树快照 |
| `POST /api/profiles/:id/browser/open` | 在独立 profile 中打开网址 |
| `POST /api/profiles/:id/browser/click` / `type` | 按快照引用点击或输入 |
| `POST /api/profiles/:id/browser/screenshot` | 截图并写入产物 |
| `POST /api/profiles/:id/browser/lease` | 人工接管或交还 agent |
| `POST /api/profiles/:id/browser/close` | 关闭当前浏览器 |
| `GET /api/connectors/github/status` | GitHub 连接器状态，不返回 token |
| `GET /api/connectors/github/repos/:owner/:repo` | 读取仓库元数据 |
| `GET /api/connectors/github/repos/:owner/:repo/issues` | 读取 issue / pull request |
| `GET /api/connectors` | 全部具名连接器状态 |
| `POST /api/connectors/:provider/read` | 读取供应商数据 |
| `POST /api/connectors/:provider/actions` | 提交供应商写动作，进入审批 |
| `GET /api/profiles/:id/voice/status` | 语音转写 / 合成是否配置 |
| `POST /api/profiles/:id/voice/transcribe` | 上传原始音频并转写 |
| `POST /api/profiles/:id/voice/speak` | 合成语音并写入产物 |
| `GET` `POST /api/mcp/servers` | MCP 服务列表和添加 |
| `POST /api/mcp/servers/:id/refresh` | 连接并发现工具 |
| `GET /api/mcp/servers/:id/tools` | 工具列表 |
| `POST /api/mcp/servers/:id/tools/:name` | 逐工具开关 |
| `POST /api/mcp/servers/:id/profiles/:profileId` | 按人格绑定 |
| `GET /api/mcp/calls` / `POST /api/mcp/call` | 调用记录和直接调用 |
| `GET` `POST /api/profiles/:id/skills` | 技能列表和创建 |
| `GET` `PATCH` `DELETE /api/skills/:id` | 技能详情、修改和删除 |
| `POST /api/skills/:id/activate` / `deactivate` | 启用或停用 |
| `GET` `POST /api/profiles/:id/routines` | 例行任务列表和创建 |
| `GET /api/routines` / `GET` `PATCH` `DELETE /api/routines/:id` | 全部任务、详情、修改和删除 |
| `POST /api/routines/:id/pause` / `resume` / `run` | 暂停、恢复或立即运行 |
| `GET /api/routines/:id/occurrences` | 运行历史 |
| `POST /api/events/:name` | 触发具名事件 |
| `POST /api/hooks/:token` | 外部 webhook；token 作为凭据 |
| `GET` `POST /api/profiles/:id/documents` | 文档列表和生成 docx / xlsx / pptx |
| `GET /api/documents/:id` / `POST /revisions` | 文档版本和连续修订 |
| `GET` `POST /api/profiles/:id/pages` | 页面列表和创建 |
| `GET` `PATCH` `DELETE /api/pages/:id` | 页面详情、修改和删除 |
| `GET /api/pages/:id/revisions` | 页面历史版本 |
| `POST /api/pages/:id/publish` / `unpublish` | 发布独立副本或撤销全部公开链接 |
| `GET /api/public/pages/:token` | 只读发布页；随机 token 作为凭据 |
| `GET /api/qq/status` | QQ 连接状态 |

## 部署准备

`deploy/` 提供 systemd、Nginx 和 `.env` 检查单，用于同机反向代理；server 仍只监听回环地址。配置尚未在目标主机执行，也没有公网证书、正式 PostgreSQL 或 systemd 验收。详见 [deploy/README.md](deploy/README.md)。

## 开发进度

已验证的范围：`npm run check` 通过，共 212 个测试（server unit 77、web unit 23、集成 112），集成测试使用真实 PostgreSQL 和 Pi，OneBot 是模拟的；真实 QQ、真实模型、Bot 群、QQ 空间、执行 worker、本地 MCP、技能库、例行任务、文档 / Pages、Edge 浏览器和 GitHub 公共 API 另有冒烟记录；其他连接器和语音端点只用本地夹具验收，真实账号 / 音频服务未验收。

| 模块 | 代码 | 模拟环境 | 真实环境 |
| --- | --- | --- | --- |
| 运行恢复、入站派发 | 完成 | 通过 | 不涉及 |
| 人格与聊天 | 完成 | 通过 | 真实模型私聊 / 群聊冒烟通过；网页外观和用户试用未验收 |
| 动作与审批 | 完成 | 通过 | QQ 私聊 / 群聊发送拿到平台回执 |
| 记忆（来源、作用域、纠正、Manifest） | 精简版 | 通过 | 群 / 私聊隔离通过；纠正的真实模型行为未验收 |
| QQ 接入 | 完成 | 通过 | 真实小号 + SnowLuma 私聊 / 群聊冒烟通过；长期验收未做 |
| 群消息存档与翻旧账 | 完成 | 通过 | 真实模型 7 次计数通过；跨群和私聊隔离通过 |
| 联网查证 | 完成 | 通过 | 真实 Bing 查询可用，真实模型调用未验收 |
| 真实大模型 | **已接入** | | 本地 OpenAI 兼容端点 `antigravity/gemini-3.8-flash`，私聊 / 群聊冒烟通过 |
| 用量与预算 | 完成 | 通过 | 每次调用留痕；每日 token 超额阻断已实测 |
| 群记忆提取 | 完成离线部分 | 通过 | 真实群提取任务完成；真实模型写入质量未验收 |
| 多 Bot 协作 | P1-05 | 通过 | 三个 Bot 真实交接通过；工作台界面未做 |
| QQ 空间只读 | P2-02 | 通过 | 真实账号读取 4 条说说 |
| QQ 空间授权评论 | P2-03 部分 | 通过 | 自己说说真实可见；范围外待审；学习未做 |
| 远程执行与产物 | P3-01 | 通过 | 独立 worker、取消和产物下载已实测；跨主机常驻未做 |
| MCP stdio | P3-03 部分 | 通过 | 真实本地 MCP 服务调用、开关和绑定已实测；远程 / 插件目录未做 |
| 技能库 | P3-06 部分 | 通过 | 版本化、启停注入和删除已测；示范录制 / 重放未做 |
| 时间 / 事件自动化 | P3-07 部分 | 通过 | 结构触发、时区 / 夏令时、错过运行、预算、webhook 已用真实 PG / Pi / HTTP 测；QQ 例行送达未连真实协议端 |
| 文档与 Pages | P3-08 部分 | 通过 | 真实 docx / xlsx / pptx 重新打开校验、修订、发布 / 撤销和 CSP 已测；工作台预览、PDF / 导入和编程 Agent 未做 |
| 产品组织与工作台 | P3-10 部分 | 通过 | 复制 / 归档 / 模板 / 搜索 / 设置 / 用量和六个工作台入口已测；记忆、Bot 群、QQ 空间界面和物理删除未做 |
| 浏览器工作面 | P3-02 部分 | 通过 | 真实 Edge 打开、快照、点击、输入、截图、人工接管和 profile 隔离已测；桌面 / 本机桥未做 |
| GitHub 只读连接器 | P3-04 部分 | 通过 | 公共 API 真实读取仓库和 issue；本地夹具覆盖错误与 token；写操作和其他供应商未做 |
| 具名连接器（Notion / Slack / X / B站 / CalDAV / 邮箱） | P3-04 / P3-05 部分 | 通过 | 读取、写动作和审批链用本地夹具测；真实账号、OAuth 和平台写入未验收 |
| 语音留言 | P3-09 部分 | 通过 | 转写 / 合成用本地端点测；真实音频服务、实时通话、手机和通知未做 |
| 数据库与备份 | 完成备份 | 通过 | 加密逻辑备份与恢复演练通过；数据库文件级加密未做 |

已知限制：

- 真实模型单次 12—82 秒，请求超时 180 秒；已记录 token / 费用，每日限额的真实群压测未做。
- 群记录统计是关键词匹配，换种说法数不到；语义检索还没做。
- 发给 Bot 的消息不计入“说过几次”。
- 附件只做标记，不下载、不存储。
- 平台撤回只停止检索和统计，原文仍保留。
- 停止期间主人的普通消息会被丢弃，没有提示；崩溃窗口的缺口依赖下次启动补记。

逐项证据和续接信息见 [NEXT.md](NEXT.md)。

## 文档

| 文件 | 内容 |
| --- | --- |
| [WATERBOT_PROPOSAL.md](WATERBOT_PROPOSAL.md) | 项目定位和已确认的决策 |
| [NEXT.md](NEXT.md) | 当前进度，唯一的进度入口 |
| [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) | 工作包和验收标准 |
| [BLUEPRINT.md](BLUEPRINT.md) | 阶段划分 |
| [PERSONAL_AGENT_PLAN.md](PERSONAL_AGENT_PLAN.md) | 总体目标与架构 |
| [GROK_PARITY.md](GROK_PARITY.md) | 完整首版的功能清单 |
| [design/](design/) | 各领域实现合同 |

## 许可证

[MIT](LICENSE)
