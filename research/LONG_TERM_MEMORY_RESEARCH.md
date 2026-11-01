# 长期记忆调研与 Pi Durable 接入建议

日期：2026-10-28。状态：官方资料、原论文与部分关键源码的静态研究；未运行服务或复现指标。Pi Durable 主底座和完整个人首版范围不变。

## 1. 建议结论

采用 **自有来源 / 事实 / 授权记录 + 可替换的派生记忆引擎 + 有预算的上下文编译**。优先验证 Hindsight，保留 Mem0 作为较轻的对照；不同时部署多个主记忆系统，也不先自研图数据库和全套反思算法。

关键分工：

- Pi Durable 保存对话和工作过程，并执行可恢复的记忆处理任务。
- 应用保留原始经历来源、用户明确事实与纠正、有效时间、人格归属、共享授权及版本。
- 开源引擎提炼候选事实、建立索引 / 派生观察并召回证据；其结论不自动等同用户明确事实。
- Context Compiler 按人格、受众、当前时间、来源状态和 token 预算组装输入，记录 manifest。

这是针对当前产品约束的工程建议，不是已运行得出的性能排名。R4 开发规划采用业务 PostgreSQL，Hindsight 可共用实例的独立数据库；额外服务、pgvector 与模型成本在 P1-04 验证，未采纳前不写成已安装依赖。

## 2. 本项目实际需要的记忆能力

| 能力 | 典型问题 | 单纯保存聊天的不足 |
| --- | --- | --- |
| 经历连续性 | 上次刷空间看到了谁的什么动态？ | 摘要可能丢作者、事件和时间 |
| 当前事实 | 我现在住哪里？ | 最近提到某城市不等于住在那里 |
| 偏好更新 | 我以前喜欢什么，现在为什么变了？ | 最新一句也可能是引用、临时状态或反例 |
| 个性化迁移 | 换一个场景，怎样帮我才贴切？ | 背出偏好不等于正确应用 |
| 人格视角 | A 怎么认识我，B 又知道哪些？ | 全局 user profile 容易串人格 |
| 共享与撤回 | 只分享这一件事，后来取消 | 搜索过滤不能清除已混入的画像 / 摘要 |
| 程序经验 | 下次处理同类邮件少犯错 | 人物事实与操作技能需要不同更新方式 |
| 不知道时克制 | 这件事从未提过 | 相似召回和反思可能补造细节 |

## 3. 开源项目比较

### Hindsight：首选验证的派生记忆引擎

[项目](https://github.com/vectorize-io/hindsight)提供 retain / recall / reflect、来源文档、派生 observation、混合召回及预计算画像等机制。本轮实际读取了标签过滤、请求默认值、来源删除及 observation 处理代码；检查提交 `0df5398efe63211bd21638f3c5378b9c241b0001`，包元数据为 1.1.0、MIT、Python >=3.11。

值得复用的是经历到派生知识的组织与检索。它仍需要运行服务、模型与数据库；自托管常见路径使用 PostgreSQL / pgvector。应用必须掌握授权与快照失效，不能把 bank 名字当作完整认证系统。

首轮先验证 retain + recall，复杂 reflect 和预计算画像按场景加入，不每轮叠加一次额外反思调用。论文、当前 OSS 与 Cloud 的具体能力分开核对。[R1—R4]

### Mem0：较轻的事实提炼与召回对照

[项目](https://github.com/mem0ai/mem0)提供提取、存储、检索、更新和删除，以及 user / agent / run 维度。本轮读取了提交 `26cdefb46600c0fa5953c4b5ee5003c125539fc4` 的主要 Memory 实现。

优点是调用面较直接、可选择组件；但仍要配置 embedding / 索引后端，不能把“SDK”理解成零基础设施。它不会自动实现本产品的共享撤回和所有时间语义。当前 OSS 的 timestamp / reference_date 部分参数明确指向平台版，不能按商业文档声称可用。[R5]

### Graphiti：时间关系复杂时的候选

[项目](https://github.com/getzep/graphiti)将 episode、实体、关系与有效时间组织起来，适合查询关系演变及历史事实。读取了提交 `2b5db9e139b2627c3ba18ff55f9181569b0d8224` 的 episode 删除路径：它考虑其他 episode 对同一关系的支持，不简单把相关图全部删掉。

代价是图后端、LLM、embedding 与应用服务 / 权限仍需维护。Graphiti 不等于完整 Zep 托管产品。先借鉴双时间与来源设计，等关系查询成为真实瓶颈再引入图引擎。[R6]

### Letta / MemGPT：分层上下文与可编辑记忆

[MemFS](https://docs.letta.com/concepts/memfs)把长期记忆组织为 Git 支持的文件，核心内容常驻，其他按目录与索引读取；记忆和消息历史搜索分开。值得借鉴可检查、可修订、分层加载的方式。

不为使用这类结构再引入第二套 agent runtime。当前文档也说明默认没有语义向量索引，不能把其文件系统直接等同任意语义检索服务。[R7]

### Honcho：理解人的视角值得借鉴

[项目](https://github.com/plastic-labs/honcho)以 peer、session、representation 和 observer / observed 关系组织对参与者的理解。它比简单事实清单更贴近“不同人格如何认识我”。本轮仅核对官方 README / 文档结构，未审计推理代码；已记录 main 提交 `bcaf722a9f9077593e0c89a0bb644061c43481b3`。

首版借鉴视角分离，不叠加另一个常驻用户推理系统。画像是推断，不能无来源覆盖用户事实。当前项目 README 标识 AGPL-3.0，代码使用前核对实际版本与许可。[R8]

### OpenViking：分层与目录检索

[项目](https://github.com/volcengine/OpenViking)以文件系统式上下文组织资源、记忆和技能，并用 L0 摘要、L1 概览、L2 原文减少全量读取。适合借鉴“先看概览，再打开证据”的上下文编译方式。

本轮仅文档级研究。当前 README 为主项目及部分组件列出不同许可，不能沿用旧介绍把整个仓库都标作 Apache。是否整套采用应比较额外服务和已有产物系统的重叠。[R9]

### Acontext：更适合程序经验

[项目](https://github.com/memodb-io/Acontext)把任务经验整理为可复用技能，适合研究怎么从执行记录沉淀操作方法。它不是用户当前事实、偏好变化与人格共享的全部答案。

首版借鉴技能提炼流程，不把其完整上下文 / sandbox 后端与已有 Pi、worker、存储再叠一遍。本轮为文档级研究。[R10]

## 4. 论文提供了什么

| 论文 / 基准 | 可采用的机制或问题 | 对本项目的限制 |
| --- | --- | --- |
| [MemGPT](https://arxiv.org/html/2310.08560v2) | 核心上下文与外部记忆分层，按需调入 | 不直接解决事实正确性、共享撤回和权限 |
| [Generative Agents](https://arxiv.org/html/2304.03442v2) | 经历流、相关性 / 时间 / 重要性、反思与计划 | 主要评估模拟行为可信度，不等于真人助手的事实可靠性 |
| [Mem0](https://arxiv.org/abs/2504.19413) | 提取、整合、召回及成本比较 | 论文版本与当前 OSS / 平台能力不能混用 |
| [Zep / Graphiti](https://arxiv.org/abs/2501.13956) | 动态事实、时间关系和来源 | 借鉴字段与操作，不必先部署完整图系统 |
| [A-MEM](https://arxiv.org/abs/2502.12110) | 带属性的笔记、动态链接与记忆组织 | 推断链接不能回写为发生过的原始事实 |
| [Hindsight](https://arxiv.org/html/2512.12818v1) | 区分世界信息、经历、派生理解，组合多种召回方式 | 论文逻辑网络与当前存储类型不必一一对应 |
| [LongMemEval](https://arxiv.org/html/2410.10813v1) | 信息提取、跨会话、时间、更新和拒绝无依据回答 | 问答基准不能覆盖本产品所有主动互动与权限要求 |
| [PersonaMem](https://arxiv.org/html/2504.14225v1) | 当前偏好、变化原因及新情境个性化 | 合成画像与历史不等于真实长期相处效果 |
| [LoCoMo](https://arxiv.org/abs/2402.17753) | 长对话、事件及跨会话记忆评估 | 不能仅凭其分数证明纠错、主动性和撤回正确 |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | 网站状态、工作流、环境坑点与错误前提 | 面向环境经验，不能和 v1 的用户历史问答直接视为同一成绩 |

ReasoningBank / ACE 继续指导程序经验与增量维护；Harness² 可用于比较记忆策略 / 技能变化；Dream-RSI 需要历史探索树与评分条件。它们不替代来源、时效和共享控制。

不把不同 README 的最高分排成榜单。读者模型、提炼模型、embedding、重排、输入历史、token 预算、数据版本和 LLM judge 都可能不同；成本还需包含写入 / 整理，不能只比较一次 recall。

## 5. 推荐的五类数据

| 类别 | 内容 | 更新规则 |
| --- | --- | --- |
| Source / Episode | 实际消息、动态、读取内容、动作回执及有限上下文 | 保留来源和版本；不是自动全文常驻 |
| Claim / Preference | 当前事实、明确偏好、临时状态 | 有有效时间、来源、修订与争议状态 |
| Perspective / Reflection | A 对用户的理解、关系概括、人格自身兴趣 | 标为推断，区分 observer / subject，可失效重建 |
| Core Context / Topic Overview | 当前人格和主题的短概览 | 是有来源与水位的派生缓存，不是第二份真相 |
| Procedural Memory / Skill | 做事方法、失败条件与验证方式 | 有适用范围、版本及实际使用反馈 |

任务待办仍由任务系统管理；可以在记忆里引用，但不能让“总结里说完成”改变任务状态。人格基础配置由用户设置；事实、理解与表达习惯的变化分别处理。

## 6. 数据字段的必要补充

在 BP-01 的基础上补充：

- `source_actor`：谁真正说了 / 做了这件事；不是把助手生成文本都归给用户。
- `observer_profile_id` 与 `subject_entity_id`：哪个人格对谁 / 什么形成认识。
- `occurred_at` / `valid_from` / `valid_to`：事情发生或事实有效的时间。
- `recorded_at`：系统何时得知；避免把迟到信息当成刚发生。
- `source_revision`、`acl_epoch`、`projection_generation`、`processed_through`：追踪异步处理与失效。
- 原文 / excerpt、精确来源 ID、推断类型和修订关系：让记忆卡可纠正和核对。

不要求先建立复杂证明系统。首版遇到混合来源撤回，保守失效受影响视图，再由仍有权使用的来源重建。相同事实可能有独立合法来源；撤回一份共享不必删除另一份独立证据，但必须能解释当前依据。

Source 优先引用已有 Pi entry / 附件及其版本，外部内容保存受限原件或必要 excerpt；不再维护第二套可独立修改的完整聊天历史。投影服务为了处理保存的副本仍受同一失效与删除流程管理。

## 7. 时间、冲突和偏好的例子

例 1：“我搬到上海了”可更新当前居住地；“我昨天去上海出差”不能覆盖居住地。历史城市仍可用于回答过去的问题。

例 2：“这周不吃辣”是有期限的状态，不能覆盖长期口味。到期后回到长期偏好；不能只按向量相似度取最新一句。

例 3：A 在 QQ 中听用户说喜欢简短回复，B 未被共享就不知道。后来用户向 B 独立说了同样偏好，取消 A 的共享后，B 可以依据自己的来源继续使用。

例 4：B 站评论里的“我喜欢……”来自第三方账号，不能归入 owner 的偏好。QQ 与 B站相同昵称不自动合并为同一人。

当前查询优先有效事实；历史查询可读取该时间点的旧事实；撤回记录无论问“现在”还是“以前”都受权限限制。新消息不总比旧消息权威，引用、假设、讽刺和推测分别保留。

## 8. 写入流程与即时纠正

1. 原始事件先进入应用来源记录；实际工具行为以回执为准。
2. 用户在记忆卡编辑或明确记忆操作中给出的事实 / 纠正，写入应用当前版本，保证随后请求能使用；异步画像不得覆盖它。
3. 其他对话按主题、会话边界与有限上下文切成 episode，进入持久记忆 outbox。
4. Hindsight / 对照引擎异步提炼；结果按来源映射为候选和派生视图，不再调用第二套 LLM 重复抽取同一事实。
5. 读取时确认源版本和授权水位；旧处理任务不得把撤回或已改正内容重新写活。

不要每句话都完整提炼、反思和重建画像。保留原始事件可以是便宜的写入；昂贵处理按新增、主题结束、重要纠正或预算内整理触发。助手的计划、想象和自动回复不能作为其实际完成过事情的独立证据。

## 9. 读取与上下文编译

优先读取顺序：当前明确纠正 / 关键约束 → 与任务相关的当前事实 → 有效主题概览 → 相关经历及原始证据 → 必要时进一步查询。

检索使用语义、关键词 / 实体、时间和来源的组合。可用 RRF 等方式融合不同检索列表，再选取支持回答所需的证据；不要靠未经验证的固定“重要性分数”删除不常访问但仍重要的事实。

用户问当前状态时排除已失效结论；问历史时按时间选择。无有效证据就说不知道 / 请求补充，不用相似记忆补出确定答案。背景推断只能作为不确定理解，不作对外事实。

ContextManifest 增加记忆后端、命中 ID、原始来源 ID、版本、时间范围、读取 epoch 和视图 generation。总 token 有预算，先保留关键约束和证据；需要时让 agent 打开细节，而非总是塞满全部历史。

## 10. 人格隔离与 Hindsight 接入

应用 wrapper 绑定 bank / namespace，模型不获得任意 bank 名称或管理工具。bank 是组织和召回边界，仍需受信服务端认证与路由。

首轮采用每个有效 `profile × audience policy × generation` 的投影视图，不把多个需要强隔离的人格原文全部塞进一个 bank 再只依赖 tags。标签用于组织和辅助过滤，传入明确的 strict / exact 语义；空过滤和未打标签内容都要负例测试。

共享选中的 Claim 时，只投影该事实及必要限定内容，不能把包含其他私事的整段 A 原文一并投到 B。共享仍由应用 grant 决定，后台引擎不能自行扩展。

撤回时先在应用层禁止旧 generation / 旧上下文使用，再删除 / 更新投影、刷新画像和摘要。重建未完成时使用允许来源的受限回退，或明确等待；不能继续用旧的自然语言 reflect 结果。

不完整 lineage 的派生内容不进入严格受众上下文；可保守使整个视图失效重建。投影只是可重建缓存，数据导出和改正不会被单一供应商锁住。

## 11. 源码和文档核对中的实质发现

### Hindsight

- 固定提交的请求默认值为 `any`，`any` / `all` 包含未打标签内容；strict 模式排除它。部分当前文档描述了不同默认值，因此依赖版本和请求字段都必须显式固定。[R2]
- 删除来源文档的实现处理依赖 observation，并使其他受影响来源重新整理；这是有价值的来源维护机制，但不等于应用所有缓存都已撤回。[R3]
- Mental Model / Page 是另外的派生缓存。官方 API 对 `is_stale` 明确说明删除不抬高该标记；不能仅靠它判断撤回后的缓存是否安全。[R4]

这些是静态接口 / 实现边界，不是已经复现的安全漏洞或效果结论。首轮建议先不自动注入预计算 Mental Model，待删除和刷新路径验证后再开放。

### Mem0 与 Graphiti

- Mem0 当前 OSS 代码要求 search 的身份通过 filters 提供，并区分平台版时间参数；已有 metadata 身份字段保护，但这不替代应用认证与共享 ACL。[R5]
- Graphiti 的时间窗口及来源 episode 适合历史查询；删除来源还要考虑其他来源是否支持同一事实。图数据、实体摘要和应用缓存仍需分别核对。[R6]

## 12. 实现选择与运维成本

方案 A（优先验证）：应用 PostgreSQL 保留来源 / 当前事实 / 权限，Pi SQLite 保留运行状态，Hindsight 作为一个派生记忆服务，使用独立数据库和 embedding / 提炼模型。先验证 retain / recall 和来源接口，再选择 observation / reflect 的开放程度。

方案 B（轻量对照）：相同业务 PostgreSQL 来源和权限层，使用 Mem0 的事实 / 召回能力及明确配置的本地或外部索引。必要时间语义由应用保留，不依赖缺失的平台特性。

方案 C（保底基线）：同一来源与 Claim 结构，仅做受控关键词 / 语义召回及有限摘要，用来衡量记忆引擎究竟带来什么收益。它是对照，不默认走向自研全部记忆算法。

不同时加 Hindsight、Honcho、Letta 和 Graphiti 来“取长补短”。这会多出多套事实、用户推断、更新与删除路径。Graphiti、Honcho、OpenViking 只有在目标查询或组织方式出现可测缺口时再单独评估。

记忆服务自己的 LLM、embedding、重排和整理调用不一定自动计入 Pi usage；wrapper 需记录 / 预留对应开销。服务不可用时，保留当前明确事实与受控来源回退，不能静默扩大检索范围或丢失写入。

## 13. 评估计划

先用相同输入历史、读者模型、回答预算和运行环境比较；写入模型或 embedding 无法保持一致时，明确记录差异。固定运行版本和数据版本，拆开检索命中、回答质量、权限正确性及成本。

参考 LongMemEval / PersonaMem / LoCoMo 的不同能力，但加入自己的中文多平台用例。LongMemEval-V2 用来检查网站 / 流程经验，不与 v1 成绩直接并排比较。

提议先设计 8 组各 10 个有区分度案例，再选择少量端到端场景。数量是评估计划，不是已经完成的数据集：

| 组 | 关注点 | 失败例 |
| --- | --- | --- |
| 事实与来源 | 用户 / 第三方 / 助手角色归属 | 把好友的话记成用户喜好 |
| 时间与迟到信息 | 当前、过去、相对时间 | 出差覆盖居住地 |
| 偏好更新 | 临时状态、纠正与冲突 | 仍按旧偏好建议 |
| 跨会话推理 | 多段证据与不确定性 | 只凭一句摘要下结论 |
| 个性化迁移 | 新场景应用、变化原因 | 会背偏好却给反向建议 |
| 共享与撤回 | 单事实分享、摘要与旧上下文 | 分享 X 同时暴露原文里的 Y |
| 受众与平台 | 公共评论 / 私聊 / 不同人格 | 公开评论引用主人私事 |
| 不知道与污染 | 无来源、外部指令、反复自述 | 助手生成内容自我强化为事实 |

必须通过的权限用例包括：无 tags、错误 bank、未打标签记录、混合来源 observation、过期画像、撤回时并发提炼、服务异常和旧队列回放。样例全部通过是该组准入门，不代表开放世界绝无泄漏。

度量：当前 / 历史事实正确性、偏好迁移、引用支持率、适当拒答、更新延迟、召回证据量、p50 / p95 延迟、写入 / 读取 / 整理总用量。用户评价人格连续性与主动互动是否合适，单独记录，不能换算成伪精确“理解度”。

## 14. 对现有设计的修改建议

1. 保留 BP-01 的应用权威与 epoch 撤回机制，增加 Source / Episode、时间双轴和观察者视角。
2. 增加 Context Compiler、投影 generation / 水位、显式纠正的立即可用路径。
3. 把摘要 / 画像标为可重建视图，查询当前与历史的状态过滤分别定义。
4. Hindsight 进入首选验证，Mem0 为对照；未决定增加服务前不修改已选 Pi 主架构。
5. BP-05 的学习评估增加 PersonaMem 式迁移与 LongMemEval 式时间 / 更新 / 拒答，避免只测背诵。

## 14A. 2026-10-30 补充

Mem0 官方迁移文档显示，当前版本改为单次、只新增的提取，把更新和删除的处理放到检索时；图记忆已从开源 SDK 移除。第 3 节基于的是更早提交，P1-04 比较前要按实际版本重新核对。

Waterbot 首个可用版先做受控基线：消息存档、关键词和语义检索、SQL 统计。之后再用翻旧账案例比较 Hindsight 与 Mem0，指标是出处正确、次数正确、隔离正确、费用和延迟。来源：[Mem0 迁移文档](https://docs.mem0.ai/migration/)、[Mem0 图记忆文档](https://docs.mem0.ai/components/graph_memory/overview)。
## 15. 证据与来源

已做：阅读原论文 / 官方资料、克隆 Hindsight 到临时目录静态阅读，读取 Mem0 / Graphiti 的相关源码；记录以下提交。未做：安装依赖、运行第三方代码、输入私人对话、调用模型、跑 benchmark 或验证真实删除。

- Hindsight：`0df5398efe63211bd21638f3c5378b9c241b0001`。
- Mem0：`26cdefb46600c0fa5953c4b5ee5003c125539fc4`。
- Graphiti：`2b5db9e139b2627c3ba18ff55f9181569b0d8224`。
- Honcho：`bcaf722a9f9077593e0c89a0bb644061c43481b3`，仅 README / 文档级。

主要工程来源：

- R1：[Hindsight README](https://github.com/vectorize-io/hindsight)、[论文](https://arxiv.org/html/2512.12818v1)。
- R2：[固定提交 tags 实现](https://github.com/vectorize-io/hindsight/blob/0df5398efe63211bd21638f3c5378b9c241b0001/hindsight-api-slim/hindsight_api/engine/search/tags.py)、[HTTP 请求定义](https://github.com/vectorize-io/hindsight/blob/0df5398efe63211bd21638f3c5378b9c241b0001/hindsight-api-slim/hindsight_api/api/http.py)。
- R3：[来源 / observation 处理实现](https://github.com/vectorize-io/hindsight/blob/0df5398efe63211bd21638f3c5378b9c241b0001/hindsight-api-slim/hindsight_api/engine/memories/pg/documents.py)、[observation 文档](https://hindsight.vectorize.io/1.0/developer/observations)。
- R4：[Mental Model API](https://hindsight.vectorize.io/developer/api/mental-models)、[API reference 中 is_stale 定义](https://hindsight.vectorize.io/api-reference)。
- R5：[Mem0 固定提交实现](https://github.com/mem0ai/mem0/blob/26cdefb46600c0fa5953c4b5ee5003c125539fc4/mem0/memory/main.py)。
- R6：[Graphiti README](https://github.com/getzep/graphiti)、[固定提交 episode 删除实现](https://github.com/getzep/graphiti/blob/2b5db9e139b2627c3ba18ff55f9181569b0d8224/graphiti_core/graphiti.py)。
- R7：[Letta MemFS](https://docs.letta.com/concepts/memfs)、[Memory & dreaming](https://docs.letta.com/configuration/memory)。
- R8：[Honcho](https://github.com/plastic-labs/honcho)。
- R9：[OpenViking](https://github.com/volcengine/OpenViking)。
- R10：[Acontext](https://github.com/memodb-io/Acontext)。
- 评估代码：[LongMemEval](https://github.com/xiaowu0162/LongMemEval)、[PersonaMem](https://github.com/bowen-upenn/PersonaMem)。

论文表中的机制说明来自对应原文；具体应用结构、投影隔离、字段与评估计划是本项目的设计推导，不是上述项目已为本产品提供的保证。
