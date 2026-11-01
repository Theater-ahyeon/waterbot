# BP-01：运行、人格、记忆与多 Bot 协作

版本：R4，2026-10-28。Pi Durable 已由用户选定；业务 PostgreSQL 为本版设计基线，尚未实现。范围对应 P01—P15、P47—P52 的服务端部分及 U01—U04、U09。跨领域接口以本文件的身份、上下文和动作约束为准。

记忆专题已依据 [开源项目与论文调研](../research/LONG_TERM_MEMORY_RESEARCH.md) 补充。首选验证 Hindsight 派生记忆服务，以 Mem0 / 受控简单检索作对照；尚未采纳或安装具体记忆后端，Pi 主运行时不变。

## 1. 实体和身份

首版采用 **一个 Bot 对应一个人格主体**，共用 `profile_id`，避免重复建立 Bot / Persona 两套权限树。工作台切换人格就是选择对应 Bot 的会话；不会把旧会话只换一段 system prompt。人格模板可复用，实例经历默认不复制。

| 对象 | 核心字段 | 语义 |
| --- | --- | --- |
| Profile | id、name、avatar、role、active_revision、status | 长期人格主体，status 为 active / paused / archived |
| ProfileRevision | profile_id、revision、base_prompt、style、model_route、source | 用户配置或经采纳的成长版本，不可覆盖旧版本 |
| ConversationBinding | profile_id、audience、topic_id、context_epoch、runtime_conversation_id | 业务会话与 Pi 会话的映射 |
| Job | id、owner_profile_id、origin、goal、parent_job_id、runtime_link、status_projection | 一次工作及其负责人；运行状态由 Pi 回执投影 |
| Group | id、member_profile_ids、topic、delivery_policy | 同一用户的多 Bot 群聊，不引入企业成员权限体系 |
| BotMessage | id、sender、recipient / group、job_id、content_ref、hops、status | 异步交接与可追溯唤醒 |

所有业务 ID 使用应用生成的字符串；Pi ConversationId / TaskId / SubmissionId 是其运行时自己的类型，保存显式映射，不假定与业务 ID 相同，也不修改其内部表。

`audience` 至少区分主人私聊、指定联系人、群 / 线程、公开发布、内部执行。人格相同不代表受众相同。QQ 私聊窗口与公开评论各用独立上下文。

## 2. Pi Durable 的接入边界

基线固定 `@earendil-works/pi-durable` / `pi-ai` / `chord` **1.4.0**；源码参考提交 `72363383ff79d3f12cfa91b03cddb3eb333c6ebc`。已核对包、README 和公共类型；集成仍须通过实际类型与恢复测试。

| 上游能力 | 应用使用方式 |
| --- | --- |
| Harness.open + SQLite storage | 单个 owner 账号一个 Harness，单个 server 进程持有 runtime.sqlite |
| createConversation / configure | 按 Profile、受众、主题与权限 epoch 建立并显式配置会话 |
| submit + requestId | 同一业务事件使用同一请求 ID，应用重试不会重复受理 |
| whenBusy | 明确选择 steer / followUp / reject，不隐式猜测用户意图 |
| defineExtension / defineTool | 注册有限业务工具，按会话显式选择，避免默认启用全部扩展 |
| defineTask / runtime.commit / sleepUntil | 长任务、检查点、可恢复延迟与审批等待 |
| abort / abortTask / background | 结合应用作业图执行停止，区分普通子任务与后台边界 |
| inspect / watchTaskGraph / watchEvents | 调试、任务投影与实时呈现；不让模型无条件查询全部会话 |

控制会话保持可交互，长工作放到独立工作会话。用户可在工作期间继续聊天、语音或提交纠正；只有明确的改向请求进入相应作业。二者仍由同一个 Pi 运行时执行和记录。

不 fork Pi 内核。应用包装只负责产品语义，不再写第二套模型循环。升级必须固定同组依赖，备份、暂停新入队、验证历史任务定义迁移后再恢复；不得给仍在运行的任务静默替换不兼容代码。

## 3. 存储归属与两库衔接

| 存储 | 权威内容 | 不负责什么 |
| --- | --- | --- |
| runtime.sqlite | Pi transcript、任务检查点、工具调用、运行回执 | 业务长期记忆和外部动作最终事实 |
| 产品 PostgreSQL | 人格、记忆、授权、动作、连接器配置、日程、产物元数据 | 复制一套 Pi 调度状态 |
| 文件目录 | 实际附件、产物、私有 / 共享工作文件 | 以路径代替访问权限 |
| 凭据存储 | 加密凭据与密钥引用 | 向模型提供秘密值 |

若接入 Hindsight，其 bank、索引、observation 和画像为可重建派生视图；应用来源、明确纠正和共享授权仍在自有记录中。业务与 Hindsight 可共用 PostgreSQL 实例，使用独立数据库、账号与迁移；不直接查询或修改其内部表。额外记忆服务和模型开销在 P1-04 验证，候选不等于已经采用。

业务逻辑记录按实际索引需求建表；低频配置可存有版本的 JSON，不要求每个名词一张表。首批需要索引与唯一约束的是 profile、conversation_binding、inbound_event、dispatch_outbox、job、bot_message、memory、memory_grant、memory_edge、context_manifest、action、approval。

跨库不伪造原子事务。入站处理：在业务 PostgreSQL 同一事务中落入站事件和 dispatch_outbox → 由 dispatcher 调 Pi.submit → 保存 Pi ID。进程若在第三步前崩溃，仍使用相同 requestId 补投并获得原提交。作业状态是可重建投影，不能自行宣布 Pi 任务成功。

唯一约束至少包括：平台事件身份、dispatch request_id、会话绑定键、BotMessage id、动作 semantic_key、审批目标 revision。检查失败回滚当前业务事务；不要在 Pi commit 回调中等待另一条会阻塞自己的运行时队列。

## 4. 一次请求的处理

1. 认证入口并识别来源；平台 sender 与真正 owner 权限分别解析。
2. 持久化事件，选择 profile、受众、主题和账号绑定，生成稳定 job ID。
3. Context Builder 检查当前权限 epoch，选择允许的记忆、来源、技能及文件。
4. 给会话配置明确工具列表，通过 outbox 提交。
5. Pi 生成与调用工具；所有实际副作用进入 Action Service。
6. 工具产物及外部回执关联作业，UI 状态由真实记录更新。
7. 工作结束时提取学习候选，作为独立有预算的整理任务，不阻塞交付。

每轮模型请求保存 ContextManifest：profile_revision、context_epoch、受众、memory_id / version、source_ref、artifact / workspace 引用、skill_version、model_route。它用于纠错、撤回影响分析和诊断，不展示模型私有推理。

## 5. 记忆数据模型

Memory 记录包含：id、owner_profile_id、kind、subject、content、source_refs、epistemic_status、valid_from / valid_to、version、state、audience_scope。kind 区分事实、用户偏好、人格自身兴趣、关系经历、程序经验和待办；state 为 active / superseded / archived / revoked。

增加 Source / Episode 作为原始经历依据，与候选 Claim、人格视角 / 反思、短概览和程序技能分开。必要补充字段为 source_actor、observer_profile_id、subject_entity_id、occurred_at、recorded_at、source_revision、projection_generation 和 processed_through。事情发生 / 事实有效的时间与系统何时得知分别记录，不把迟到信息当成刚发生。

Source 优先指向已有 Pi entry、附件或受限外部原件的版本，保留必要 excerpt；不复制一套可独立修改的完整聊天历史。引擎处理副本与缓存仍需统一失效和删除。

`epistemic_status` 区分用户明确表达、观测事实、外部转述和待证推测。来源可以指向聊天、动态、邮件或实际动作回执。引用第三方的一句话不等于用户给出了长期指令。

人物理解保留“哪个人格对谁的认识”，不建立自动全人格共享的唯一用户画像。工具回执支持实际行为；助手的计划、自动回复或想象不能反复作为独立事实来源。QQ 与 B站同名联系人不自动合并。

MemoryGrant 表示对指定 profile 的持续可读范围，默认接收方只读，可提出修改建议；用户可直接修订。共享写入必须明确，不能让接收人格覆盖原经历。

MemoryEdge 记录 derived_from / summarizes / supersedes 等来源关系。无环检查防止自引用；混合多个来源的摘要继承全部来源约束，不允许通过压缩扩大可见范围。

首版默认操作语义：

- **共享**：共享同一记录，用户选择接收人格；更新和撤回持续生效。
- **分享摘要**：明确选择内容及受众，生成带来源的独立分享结果。
- **独立复制**：用户显式发起并看到“以后独立变化”的说明；复制仍保留来源。不把它混入普通共享开关。
- **纠正**：创建新版本并失效旧结论，保留用户可见变更记录。
- **归档**：停止正常召回，原记录供用户检查。

来源归属保持不变：B 读到 A 的经历，不自动把它写成自己亲历。这些是设计默认值，用户仍可调整共享与复制语义。

## 6. 权限先于检索

检索条件先限定 profile、有效授权、受众与记录状态，再做文本 / 语义排序。关键词索引、向量索引和缓存都不是权限来源。中文真实样例决定分词与 embedding 方案；首版不另部署图数据库或向量集群。

当前状态查询排除已失效结论；历史查询允许读取当时有效的旧版本，但 revoked 记录始终受当前权限限制。引用某城市、临时不吃辣和长期口味变化不能仅按“最新一句”互相覆盖。

Context Compiler 优先加入当前明确纠正和关键约束，再取相关事实、概览、经历与证据；主题概览是带来源和水位的缓存。关键词 / 实体、语义和时间检索可融合排序，最终受 token 预算限制。没有有效证据时拒绝补造确定答案。

用户在记忆卡或明确记忆操作中做出的纠正先更新应用当前版本，随后请求可用；异步提炼不能覆盖它。记忆 outbox 记录来源版本、权限 epoch 和投影 generation，迟到作业在写回前复核，不能复活已撤回内容。

默认仅把与当前任务相关的少量记忆放入上下文，历史按授权来源检索。搜索 API、后台整理、摘要、批量导出、工具与文件访问都复用相同的权限判断。禁止给模型通用“读取任意 profile”参数绕开身份绑定。

公开回复的上下文不能先加载私聊秘密，再要求模型“不要说出去”。公开任务从允许公开使用的材料构造；无法确认可披露范围的动作进入待审。

## 7. 撤回共享与上下文更新

首版使用 owner 级权限 epoch，减少复杂的增量漏失：

1. 同一 app 事务撤销 grant、标记相关衍生项失效、递增 epoch，并记录影响作业。
2. 禁止受影响作业产生新的对外动作，终止 / 暂停对应模型请求。
3. 失效索引缓存与由该来源产生的摘要、学习提案和共享产物权限。
4. 新请求使用新 epoch 的干净会话，从仍有权使用的来源重建上下文；不把受影响的旧摘要直接续入。
5. 旧记录仅供 owner 检查，模型历史搜索过滤失效来源。

外部动作在实际开始发送处检查 epoch / 授权。撤回无法逆转已经开始的网络发送，也不能收回接收方已获得的公开内容；UI 区分“已生效阻止后续使用”和“历史内容仍存在”。

逻辑遗忘与物理删除分开。Pi 历史和备份不因删一条记忆自动消失。彻底清理需要按支持的存储操作重建必要状态、停用旧库并处理备份保留；本方案不承诺模型或第三方备份上的即时不可恢复遗忘。

### 派生记忆后端的额外约束

若选用 Hindsight，wrapper 由受信会话绑定 bank / 作用域，模型不能任意选 bank。首轮按 profile × audience policy × generation 分投影视图，不把强隔离人格的全部原文混在一起再只靠标签过滤。标签匹配模式显式固定；空过滤、未打标签内容和 observation 整理范围均须验证。

分享单条 Claim 只投影该事实及必要限定内容，不把原始 Episode 中的其他私事一起分享。撤回后旧 generation 立即停止使用，再异步更新 / 重建；服务尚未追平时受控回退或等待，不沿用旧画像。其他独立合法来源支持同一事实时，可由该来源重新生成当前判断。

来源、observation、Mental Model、Page 和 Pi 旧上下文是不同对象，不能只删一个就称已全部撤回。严格受众上下文需要可核对依据；来源因预算截断时按权限补取，补不齐则不使用该派生结论。首轮可先不自动注入预计算画像，验证更新 / 删除后再开放。

## 8. 作业与外部动作状态

Job 对外状态：queued、running、waiting_input、waiting_approval、blocked、completed、failed、cancelled。它们是应用投影，不冒充 Pi 自身的任务枚举。

Action 才是外发事实的权威：

| 状态 | 允许的下一步 |
| --- | --- |
| proposed | 校验目标、内容、账号和长期授权 |
| awaiting_approval | 用户批准 / 拒绝 / 过期 / 修改后重新提案 |
| ready | 再检查当前授权、epoch、预算和目标版本 |
| sending | 执行一次发送，不能因超时直接回到 ready |
| confirmed | 有明确回执；记录是否另有回读证据 |
| unknown | 只读核对；不能证明未发生时停止补发 |
| rejected / expired / cancelled / failed | 终态；明确新意图才可产生新的 action |

Action 固定 profile_revision、account_id、kind、target_ref、payload_hash、trigger_event_id、policy_revision、context_epoch 和来源。semantic_key 包含实际账号、动作、资源与触发事件，避免同一账号的不同人格重复争抢。同一事件中改写文案不生成无限新身份；新一轮真实回复或用户明确重试可创建关联的新意图。

审批绑定 action revision、账号、目标、内容 hash 和有效期。批准后修改内容必须重新审查。规则内自动发送不要求用户反复批准，规则外等待用户。

## 9. 可恢复审批与重放

ActionJobTask 按 prepare → await_decision → execute → reconcile → finish 划分阶段，每阶段提交检查点。审批决定存业务 PostgreSQL；等待阶段用 Pi 的持久 sleepUntil 做短间隔查询，不持有无法恢复的 Promise，也不调用模型来轮询。建议初始查询间隔 5 秒，结束或过期即停止。

读取类工具只有在确认重跑不会产生副作用时标记 replay safe。外发工具默认 unsafe。恢复后的任务或模型若再次请求发送，Action Service 仍先查已有动作记录；不能把 beforeTool 当成唯一检查，因为恢复路径与初次调用路径不同。

worker 请求携带 action ID。worker 自己保存执行回执并按该 ID 去重；若平台不支持幂等键，worker 在“可能已发出”后崩溃仍然会留下 unknown，不能伪造 exactly-once。

### 作业完成不由模型自述决定

工具可以返回 action ID 和 pending 状态，但控制程序不能因模型结束回答就把整个作业标为 completed。必需 Action 未处理完时显示等待，unknown 显示需核对；必需产物需通过存在与格式检查，通知送达状态单独记录。

ActionJobTask 由持久 dispatcher / 宿主管理，不只依赖一个已经结束或崩溃的临时工具调用。任务记录持有 action ID，重复调度只核对同一 Action。作业取消必须覆盖这些业务关联任务；不能假设 Pi 的普通会话 abort 自动跨过所有后台边界。

## 10. 多 Bot 消息与停止

群聊先由路由选择接收者，显式 @ 优先。BotMessage 在业务 PostgreSQL 提交后进入 dispatch_outbox，接收方用稳定 requestId 唤醒。交接只发送正文、允许的上下文 / 产物引用和预期输出，不复制发件人的全部记忆、凭据或权限。

交接任务保留原 requester、发起 Bot、执行 Bot、job lineage、受众和预算。消息不能扩大接收者权限；接收者执行外发时仍用当前授权。重复消息、循环交接通过稳定 ID、有限 hops、作业预算与超时处理；初始 hop 上限提议为 6，用户可在明确任务中调整。

停止分为当前回答、指定作业、人格自主活动、全部活动。作业取消先落取消意图，再中止 Pi 所属任务及必要后台锚点、撤销尚未使用的 worker 能力。停止不是撤回已发送消息；刚好已开始的外部操作可能仍需核对。

## 11. 应用 API 设计

以下是本项目接口契约，不是 Pi 上游 API。所有写入验证身份、资源可见范围、body schema 与版本；客户端不能靠传 profile_id 获得权限。

| 接口 | 关键约束 |
| --- | --- |
| POST /api/profiles；PATCH /api/profiles/:id | 创建 / 修订，要求 expected_revision，防覆盖 |
| POST /api/conversations/:id/messages | client_request_id、when_busy、附件引用；异步返回 job ID |
| POST /api/jobs/:id/steer；POST /api/jobs/:id/cancel | 绑定现有作业，不能误路由到当前界面所选人格 |
| GET /api/memories；POST /api/memories/:id/revisions | 由服务端限定可见范围，纠正生成新版本 |
| PUT /api/memories/:id/grants | 目标人格列表、expected_version；原子更新和 epoch 失效 |
| POST /api/actions/:id/decision | allow / deny、expected_payload_hash、expected_revision |
| POST /api/groups；POST /api/bot-messages | 成员、受众、上下文引用校验 |
| GET /api/events | SSE cursor，断线重连补事件；超出保留窗口先取新快照 |

业务写 API 支持幂等请求 ID。错误区分版本冲突、权限失效、账号离线、待用户输入、结果未知和服务器故障；不能统一返回“成功，稍后处理”。

## 11A. 真人 QQ 群（Waterbot 首个可用版）

本节的 QQ 群是有真人成员的外部群，与第 1 节由 owner 的多个 Bot 组成的 Group 不是同一对象。

新增实体：

| 对象 | 核心字段 | 语义 |
| --- | --- | --- |
| QqGroup | id、account_id、external_group_id、status、proactive_policy | 已接入的真人群及其发言策略 |
| GroupMember | id、group_id、platform_user_id、nickname_history | 平台身份；昵称不用于判定身份，也不授予 owner 权限 |
| GroupMessage | id、external_event_id、group_id、member_id、content、reply_to、occurred_at、recorded_at | 群消息原始存档，是独立于 Pi 对话记录的来源 |

未 @ Bot 的群消息不会进入 Pi，因此群场景不适用“Source 优先指向 Pi entry”。GroupMessage 全量保存，不做敏感内容过滤。这是用户的明确决定。

权限：

- 群会话只能读本群存档和本群记忆，多群隔离。
- owner 私聊可读私聊记忆和授权的群记忆；私聊内容绝不进入群上下文。
- 群友只能聊天、查本群记录和使用公开搜索，不能调用 owner 连接器、电脑、登录态或技能。
- 只有经平台身份验证的 owner 能下达管理命令和批准动作。消息正文不能声明身份或授权。
- 审批、密钥、登录请求、草稿和私聊内容不出现在群里。

记忆与回答：

- 群记忆记成“谁在何时说过什么”，不记成绝对事实，可跳回原消息。
- 次数统计由数据库完成，不由模型估算。
- 上下文优先读回复和引用链，再读最近消息，最后读相关长期记忆。
- owner 通过 QQ 私聊使用“记住”“忘掉”“你记得什么”，走第 6 节的即时纠正路径。只有 owner 能删除；普通删除先停止召回，物理清除单独操作。

主动发言不进入待审，不确定时保持沉默。它只使用本群记录，不调用工具，默认每群每天最多 3 次、间隔至少 2 小时，发送仍经过 Action，结果未知时不补发。
## 12. 关键验收

- 每个记忆查询入口、摘要任务、文件检索与公开上下文都有私有 canary 用例。
- 在出站前、出站后回执前、app 记录后 Pi checkpoint 前分别模拟崩溃。
- 取消共享与审批同时发生时，现行授权优先；已发起网络请求明确列为需核对。
- 三个 Bot 交接产物，拒绝跨人格凭据与无授权记忆引用。
- 升级缺失任务定义、迁移失败和超出恢复次数可见，不能无限重启。
- 记忆专项覆盖时间、迟到信息、当前偏好、纠正、新情境迁移与适当拒答；共享 X 不得带出同一原文中的私有 Y。
- 记忆服务异常、空标签、旧画像、撤回期间异步提炼和旧队列回放保持受控；发布权限不依赖引擎自然语言自述。

来源：[固定提交 README](https://github.com/earendil-works/pi/blob/72363383ff79d3f12cfa91b03cddb3eb333c6ebc/packages/durable/README.md)、[任务公共类型](https://github.com/earendil-works/pi/blob/72363383ff79d3f12cfa91b03cddb3eb333c6ebc/packages/durable/src/types.ts)、[会话与工具公共类型](https://github.com/earendil-works/pi/blob/72363383ff79d3f12cfa91b03cddb3eb333c6ebc/packages/durable/src/harness/types.ts)、[工具恢复实现](https://github.com/earendil-works/pi/blob/72363383ff79d3f12cfa91b03cddb3eb333c6ebc/packages/durable/src/harness/tool.ts)。具体产品实体、API、状态机与默认数值为本方案设计，不是上游已经提供的功能。
