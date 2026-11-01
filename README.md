# Waterbot

一个住在 QQ 群里的长期成员，同时也是只服务主人的私人助理。

它有自己的性格，被 @ 时能读懂上下文，能带着时间和原话翻旧账，也能联网查证并给出来源。私聊时，它是只听主人一个人的外脑。

> **当前状态：开发中，尚不能在真实群里使用。**
> 目前全程运行在模拟模型上，还没有接入真实大模型，也没有连接过真实 QQ 账号。回复内容是“【本地演示】”文字。详见[开发进度](#开发进度)。

## 为什么做这个

普通群聊机器人大多记不住事，或者把所有内容混在一起。Waterbot 想解决的是这几件事：

- **翻旧账要有证据。** “他说过几次”由数据库统计，不让模型估算，并给出原话和时间。
- **查证要有来源。** 联网结果保留链接；查不到就说查不到。
- **记忆有边界。** 私聊内容绝不进群，A 群查不到 B 群。
- **权限不靠提示词。** 模型根本拿不到无权读取的数据，而不是拿到后再叮嘱它别说。

## 功能

已实现的功能都只经过模拟环境验证，详见[开发进度](#开发进度)。

### 群聊

- 被 @ 或回复 Bot 时才调用模型，其余消息只存档
- 接入的群全量存档，掉线缺口单独记录
- 上下文按顺序取：引用链 → 最近消息 → 相关旧消息 → 长期记忆
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

### 工作台

本机网页界面：访问码登录、多人格聊天、动作审批记录。记忆目前只有 HTTP API，还没有界面。

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

**技术栈：** Node.js、TypeScript、[Pi Durable](https://github.com/earendil-works/pi)、PostgreSQL 18、React、Vite、Tailwind CSS、Vitest。

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
| `SEARCH_DISABLED` | 关闭 | 设为 `1` 关闭联网搜索 |
| `SEARCH_DAILY_LIMIT` | `100` | 每 24 小时的搜索上限 |
| `TAVILY_API_KEY` | 无 | 填了就改用 Tavily，否则用 Bing |

`ONEBOT_WS_URL`、`QQ_BOT_ID`、`QQ_OWNER_ID` 要么全填，要么全不填。

### 接入 QQ（尚未经真实账号验证）

1. 准备专用 QQ 小号，不要用主号。
2. 单独运行支持 OneBot v11 的协议端（候选：[NapCat](https://github.com/NapNeko/NapCatQQ)），开启正向 WebSocket。
3. 在 `.env` 填好上面三项，先不要设置 `QQ_ALLOW_SEND`。
4. 私聊 Bot 发送 `接入群 <群号>`。
5. 用 `GET /api/qq/status` 查看连接状态和掉线缺口（需要登录）。

在接入真实模型之前，不要在真实群开启 `QQ_ALLOW_SEND`，否则群里只会收到演示回复。进入真实群前，请告知群友消息会被全量保存。

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
    actions.ts        动作、规则、审批
    archive.ts        群消息存档与检索
    memory.ts         记忆与上下文编译
    memory-context.ts 模型请求钩子
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
| `GET` `POST /api/profiles` | 人格列表和创建 |
| `GET` `POST /api/profiles/:id/messages` | 聊天记录和发送 |
| `GET /api/profiles/:id/events` | SSE 实时更新 |
| `GET` `POST /api/profiles/:id/actions` | 动作列表和提案 |
| `POST /api/actions/:id/decision` | 审批动作 |
| `GET` `POST /api/profiles/:id/memories` | 记忆列表和写入 |
| `POST /api/memories/:id/revisions` | 纠正记忆 |
| `POST /api/memories/:id/forget` | 忘记记忆 |
| `GET /api/profiles/:id/context-manifests` | 查看模型请求用了什么 |
| `GET /api/qq/status` | QQ 连接状态 |

## 开发进度

已验证的范围：`npm run check` 通过，共 130 个测试，集成测试使用真实 PostgreSQL 和 Pi，模型和 OneBot 是模拟的。

| 模块 | 代码 | 模拟环境 | 真实环境 |
| --- | --- | --- | --- |
| 运行恢复、入站派发 | 完成 | 通过 | 不涉及 |
| 人格与聊天 | 完成 | 通过 | 网页外观和用户试用未验收 |
| 动作与审批 | 完成 | 通过 | 只有本地模拟发送 |
| 记忆（来源、作用域、纠正、Manifest） | 精简版 | 通过 | 未验证真实模型效果 |
| QQ 接入 | 完成离线部分 | 通过 | **未连接过真实账号** |
| 群消息存档与翻旧账 | 完成离线部分 | 通过 | **未验证** |
| 联网查证 | 完成 | 通过 | 真实 Bing 查询可用，模型行为未验证 |
| 真实大模型 | **未开始** | | |
| 群记忆提取 | **未开始** | 需要真实模型 | |
| 数据库和备份加密 | **未开始** | | |

已知限制：

- 群记录统计是关键词匹配，换种说法数不到；语义检索还没做。
- 发给 Bot 的消息不计入“说过几次”。
- 附件只做标记，不下载、不存储。
- 停止期间主人的普通消息会被丢弃，没有提示。
- server 自身离线的时段不会记录为缺口。

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
