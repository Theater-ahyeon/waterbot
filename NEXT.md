# 当前状态与续接

## R29：P3-04 / P3-05 / P3-09 连接器与语音留言（2026-11-06，当前权威状态）

本节优先于 R28 及更早记录。供应商连接器和语音只用本地夹具验收；用户明确本轮不要求真实账号验证。

交付：

- `src/connectors/`：Notion（搜索 / 页面 / 追加段落）、Slack（频道 / 消息 / 发消息）、X（只读搜索 / 用户时间线）、B站（WBI 搜索 / 视频 / 评论 / 评论动作）、CalDAV（事件读取 / 创建）、邮箱（IMAP 收件箱 / 邮件读取、SMTP 发送）。
- 读写统一注册表：`GET /api/connectors`、`POST /api/connectors/:provider/read`、`POST /api/connectors/:provider/actions`。
- 所有供应商写入先生成 Action，经过审批或已授权规则后由 `Connectors.deliver` 调用上游；未配置或未授权时明确失败。
- `connector_read` 工具只在主人私聊注入；凭据只来自环境变量，不返回、不写入模型上下文。
- `src/voice.ts`：OpenAI 兼容的语音转写和合成；`POST /voice/transcribe` 接收原始音频，`POST /voice/speak` 写入 audio artifact；未配置时明确返回 503。
- 工作台「工具与执行」增加连接器状态、通用读取 / 写动作表单、语音合成和音频转写。
- `.env.example` 增加 Notion、Slack、X、B站、CalDAV、IMAP / SMTP、语音端点配置。

验证：

- `connectors.test.ts` 7 个测试：Notion 读取 / 追加、Slack 读取 / 发送、X 只读、B站 WBI 签名 / 视频 / 评论 / 评论动作、日历 ICS 重新解析、邮箱配置与收件人校验、注册表。
- `connectors.integration.test.ts` 3 个测试：真实 PG / HTTP，读取连接器、提交写动作、审批后真实调用本地上游、转写和合成接口。
- `voice.integration.test.ts` 3 个测试：转写、合成产物下载、未配置和音频大小上限。
- `npm run check` 退出 0：server unit 77、web unit 23、集成 112、build 成功，共 212 个测试。

未验证 / 已知限制：

- Notion / Slack / X / B站 / CalDAV / 邮箱都没有真实账号、真实 OAuth 或真实平台写入验收；只用本地夹具。
- X 只有 Read Bearer，没有发帖凭据；没有 OAuth 1.0a / OAuth2 用户授权。
- B站 WBI 算法按公开资料实现，没有真实 Cookie 验收；Cookie 过期、风控和验证码没有处理。
- CalDAV 只测了 ICS 生成 / 重新解析；没有真实 DAV 服务器；邮箱没有真实 IMAP / SMTP 连接。
- 语音只有留言式转写 / 合成；没有实时通话、打断、手机原生录音、推送通知或系统分享桥。
- 写入动作仍要求审批或长期规则；没有自动学习何时该发。

下一步：

1. P4-01 全功能回归：逐项核对代码位置、自动化证据和未通过项。
2. P4-02 等部署授权后执行目标主机、恢复对账和用户验收。
3. 真实账号、音频设备和手机桥接就绪后，对连接器 / 语音做平台验收，不把夹具结果写成真实完成。

## R28：P3-04 GitHub 只读连接器（2026-11-06）

本节优先于 R27 及更早记录。只接了一个供应商的只读操作集合，没有写操作。

交付：

- `src/github.ts`：`GithubService` 读取仓库元数据、issue / pull request；zod 校验上游响应；15 秒超时；错误转成 502。
- API：`GET /api/connectors/github/status`、`/repos/:owner/:repo`、`/repos/:owner/:repo/issues`。
- 工具 `github_read_repo`、`github_list_issues` 只在主人私聊注入。
- `GITHUB_TOKEN` 可选；公共仓库不需要。`GITHUB_API_BASE` 支持 GitHub Enterprise 和测试夹具；token 不出现在响应、日志或模型上下文。

验证：

- 新增 `github.test.ts` 3 个测试：本地夹具读取仓库、issue 和 pull request 区分、Authorization 头；非法仓库名和上游 500 失败路径。
- 真实公共 API 冒烟：`octocat/Hello-World` 返回 3905 stars、默认分支 `master`，开放 issue 50 条，耗时约 3.1 秒。
- `npm run check` 退出 0：server unit 70、web unit 23、集成 106、build 成功，共 199 个测试。

未验证 / 已知限制：

- 只有公共读取；没有评论、创建 issue、合并、推送或任何写操作。
- 私有仓库 token 路径没有用真实私有仓库验收；没有 OAuth 安装流程和多账号。
- 没有分页、搜索、速率限制缓存或 ETag；GitHub 限流时直接返回明确失败。
- 其他具名供应商（邮箱、日历、Notion、Slack、X）仍未接入。
- 连接器没有进入工作台界面，只有 API 和主人私聊工具。

下一步：

1. P4-01 全功能回归，逐项核对证据和未通过项。
2. P4-02 等部署授权后执行目标主机、恢复对账和用户验收。
3. 其余供应商、B 站、语音 / 手机在账号或设备就绪后逐项接入。

## R27：P3-02 浏览器工作面与 P4-02 部署准备（2026-11-06）

本节优先于 R26 及更早记录。浏览器已接真实 Edge；部署配置只准备、未执行。

交付：

- `migrations/0021_browser.sql`：`browser_surface`，记录状态、控制者、租约版本、当前 URL 和错误。
- `src/browser.ts`：Playwright Core 1.65 + 宿主 Edge 的独立持久 profile；ARIA 快照、可操作元素 ref、点击、输入、整页截图、人工接管租约；默认拒绝本机和私有网段。
- 浏览器工具 `browser_open` / `snapshot` / `click` / `type` / `screenshot` 只在主人私聊注入。
- API：`GET /api/profiles/:id/browser`、`/snapshot`，`POST open|click|type|screenshot|close|lease`。
- 工作台「工具与执行」增加浏览器打开、快照、元素点击、输入、截图、接管和关闭。
- `src/config.ts` + `src/http.ts` + `src/auth.ts`：`PUBLIC_ORIGIN` 允许同机反向代理的 Host / Origin；HTTPS 时会话 cookie 加 Secure；server 仍只监听回环。`WATERBOT_DATA_DIR` 统一运行数据根目录。
- `deploy/waterbot.service`、`deploy/nginx.conf`、`deploy/README.md`：systemd、HTTPS 反向代理、迁移 / 备份检查单；未在目标主机执行。

验证：

- 新增 `browser.integration.test.ts` 4 个测试：真实 Edge 打开本机测试页、ARIA 快照、点击、输入、截图产物；两个 profile 的 cookie 隔离；人工接管阻止 agent；默认拒绝本机和私有网段。
- 新增 `http.test.ts` 4 个测试：本机 Host、配置后的公网 Host、非法 Host、PUBLIC_ORIGIN 格式和数据目录。
- `npm run check` 退出 0：server unit 62、web unit 23、集成 106、build 成功。

未验证 / 已知限制：

- 只验证了 Windows 上的 Edge；没有验证 Linux Chrome、无头桌面、原生鼠标键盘、本机设备桥或硬件密钥。
- 只做 ARIA 快照和元素引用，没有截图驱动的坐标点击、下载处理、多 tab 管理或实时人工画面。
- 没有密码字段暂停或秘密输入面板：`browser_type` 的文本会经过模型和工具参数，不要把密码、验证码或令牌交给它；快照不回显输入值不等于秘密不会进入上下文。
- SSRF 只按 URL 主机名拒绝本机和私有网段；没有校验 DNS 解析结果和重定向后的地址。
- 人工接管只有 API / 租约，没有实时画面输入通道；接管期间 agent 工具会拒绝。
- 部署文件没有在 Linux、正式 PostgreSQL、证书或 systemd 上执行；P4-02 仍等待部署授权和用户验收。
- P3-04 具名应用连接器、P3-05 B 站、P3-09 语音 / 手机 / 通知仍未开始，真实验收需要账号、设备或宿主。

下一步：

1. P4-01 全功能回归：逐项核对 P / U 项、真实产物、权限与中断，记录未通过项。
2. P4-02 只有在获得部署授权后才执行目标主机配置、恢复对账和用户验收。
3. P3-04 / 05 / 09 在账号或设备就绪后逐项接入，不把模拟结果写成真实平台完成。

## R26：P3-10 产品组织、设置与工作台（2026-11-06）

本节优先于 R25 及更早记录。工作台现在有对话、活动、例行任务、资料库、工具与执行、设置与组织六个入口。

交付：

- `migrations/0020_organization_settings.sql`：`profile.archived_at`、`owner_setting`。
- `src/profiles.ts`：模板创建、复制（默认只带设定文本，显式选择才复制技能）、归档 / 恢复；最后一个活跃人格不能归档；归档同时暂停例行任务并把未派发 outbox 标失败。
- `src/templates.ts`：群聊伙伴、研究助手、写作助手、自动化助理四个内置模板。
- `src/settings.ts`：时区、主题、密度、通知设置，服务端保存并校验。
- `src/workbench-search.ts`：人格、记忆、技能、例行任务、页面、文档、执行任务和群消息统一搜索；按人格过滤时不包括跨人格群消息。
- API：`GET /api/templates`、`GET/PUT /api/settings`、`GET /api/search`、`POST /api/profiles/:id/copy`、`DELETE /api/profiles/:id`（归档）、`POST /api/profiles/:id/restore`、`GET /api/profiles?includeArchived=1`。
- `src/mcp.ts`：服务列表返回已绑定人格，供工作台显示。
- Web：新增 `Automation.tsx`、`Library.tsx`、`Tools.tsx`、`Settings.tsx`；主题 / 密度应用到根节点；文档下载、页面发布 / 撤销、技能启停、MCP 绑定和逐工具开关、执行取消 / 产物可直接操作。

验证：

- 新增 `organization.integration.test.ts` 6 个测试：复制不带技能 / 显式复制、模板创建、归档暂停例行任务和拒绝新会话、设置校验、跨类别搜索与人格过滤、HTTP 复制 / 归档 / 恢复。
- 新增 Web 测试打开例行任务、资料库、工具和设置页；原有聊天 / 草稿 / 重试测试继续通过。
- `npm run check` 退出 0：server unit 62、web unit 23、集成 102、build 成功。

未验证 / 已知限制：

- 工作台界面尚未覆盖记忆管理、Bot 群、QQ 空间、动作长期规则的结构化编辑和移动端真机验收。
- 归档是软删除，没有物理清除入口；历史仍保留。
- 搜索使用子串匹配，没有分词、语义检索或分页。
- 数据与更新只展示服务状态；备份 / 恢复仍是 CLI，没有一键升级或回滚界面。
- 页面 / 文档界面只支持文本块编辑；图表、指标、表格等结构化页面仍通过 API 或 Bot 工具维护。
- 主题应用只覆盖颜色 token 和基础字号；紧凑密度没有重排所有间距。

下一步：

1. P3-02 浏览器 / 桌面与本机桥。
2. P3-04 具名应用连接器，按供应商逐个接。
3. P3-05 B 站、P3-09 语音 / 手机 / 通知；真实验收等待账号、设备或宿主。
4. P4-01 全功能回归与 P4-02 部署恢复交付。

## R25：P3-08 文档、Pages 与产物（2026-11-06）

本节优先于 R24 及更早记录。文档生成在控制进程内用固定版本库完成；页面发布是独立只读副本。

交付：

- `migrations/0019_documents_pages.sql`：`document`、`document_revision`、`page`、`page_revision`、`page_publication`；`artifact.execution_id` 允许为空，新增 `storage_path`。
- `src/documents.ts`：生成真实 `.docx`（docx 9.15.2）、`.xlsx`（exceljs 4.4.0）、`.pptx`（pptxgenjs 4.0.1）；内容校验、版本递增、旧版本保留、产物记录 sha256 / size / mime。
- `src/pages.ts`：结构化块（标题、文本、列表、指标、表格、柱状图、折线图）；版本化修改；发布时保存独立快照和随机 token；撤销后公开链接立即 404；固定表格排序脚本，内容全部转义。
- `src/execution.ts`：下载支持 `storage_path` 直接产物，并同时校验工作区与文档目录；非 ASCII 文件名使用 RFC 5987 形式。
- `update_page` 工具只在 owner 私聊注入；按 Pi conversation binding 校验人格和 `owner_private` 范围，QQ 群、Bot 群看不到。
- API：文档、页面、修订、发布 / 撤销和 `/api/public/pages/:token`。发布页使用 `sandbox allow-scripts` CSP，不读取工作台会话。

验证：

- 新增 `documents.integration.test.ts` 4 个测试：docx / xlsx / pptx 重新打开校验内容、连续修订、OLD 版本保留；页面版本、发布快照、撤销、会话越权；真实 Pi 工具调用更新页面；HTTP 创建 / 下载 / 发布 / CSP / 路径越界。
- `npm run check` 退出 0：server unit 62、web unit 22、集成 96、build 成功。

未验证 / 已知限制：

- 工作台没有文档 / Pages 界面；没有文件预览、分享列表、资料库和置顶。
- 不支持 PDF、notebook、用户上传附件导入；文档生成在控制进程内，不在隔离 worker。
- 发布页面只提供本地 HTTP 只读副本；没有公网域名、访问统计或外部对象存储。
- Pages 的交互只有表格排序和原生折叠；没有实时数据源、定时刷新或组件编辑。
- 编程委派继续复用 P3-01 的命令执行和产物回收，没有单独的编码 Agent、代码审查或差异预览。
- 备份只覆盖数据库元数据；文档文件和发布页快照文件不在逻辑备份内。

下一步：

1. P3-10 产品组织与设置、工作台界面。
2. P3-02 浏览器 / 桌面、P3-04 供应商连接器、P3-05 B 站、P3-09 语音 / 手机按外部条件继续。
3. 文档 / Pages 的导入、预览、资料库与分享管理页面。

## R24：P3-07 时间 / 事件自动化（2026-11-06）

本节优先于 R23 及更早记录。例行任务只计算到期并投递到既有 Pi 会话，不另建队列或调度引擎。

交付：

- `migrations/0018_routines.sql`：`routine`、`routine_occurrence`；唯一键 `(routine_id, revision, logical_occurrence)` 阻止同一槽位重复执行，`trigger_payload_hash` 阻止同一事件 ID 换内容后静默合并。
- `src/routines.ts`：结构化触发（一次、间隔、每天、每周、具名事件、webhook）、IANA 时区与夏令时缺失 / 重复时刻处理、`next_due_at`、revision、skip / coalesce / catch_up（1—20 次）、24 小时 token 预算、暂停 / 恢复 / 删除 / 立即运行、运行历史。
- occurrence、`inbound_event`、`dispatch_outbox` 在同一事务写入；到期的 web 会话任务由现有 `Chats` 派发，QQ 送达由 `QqBridge` 对账后生成 Action。
- `src/qq/bridge.ts`：对账 `source=routine` 且带 `qq.target` 的作业；任务暂停、QQ 停止或发送关闭时标为 blocked，不假装送达。
- API：`GET/POST /api/profiles/:id/routines`、`GET /api/routines`、`GET/PATCH/DELETE /api/routines/:id`、`POST /api/routines/:id/pause|resume|run`、`GET /api/routines/:id/occurrences`、`POST /api/events/:name`、`POST /api/hooks/:token`。
- `GET /api/status` 增加 active / paused / due 例行任务计数。

验证：

- 新增 `routines.test.ts` 6 个测试：触发解析、夏令时缺口跳过、重复时刻只取一次、每周时区计算、间隔锚点、自然语言说明。
- 新增 `routines.integration.test.ts` 6 个测试：一次任务执行并进入聊天 / 历史；重复到期不重复建 occurrence；skip 与 coalesce 不补发全部槽位；预算耗尽暂停并拒绝手动运行；HTTP 创建、webhook 去重与内容冲突、具名事件、暂停与恢复；QQ 送达开关与群接入校验。
- `npm run check` 退出 0：server unit 62、web unit 22、集成 92、build 成功。

未验证 / 已知限制：

- 工作台没有例行任务界面，只有 HTTP API。
- webhook 只在本机监听范围内容易使用；没有公网 TLS、反向代理配置或来源 IP 白名单。
- 预算按最近 24 小时已结算 token 计算；同时运行的调用可能短暂超出，未做额度预留。
- 只有一个 server 进程的调度器；多实例依靠行锁也不会重复执行，但没有跨主机常驻调度。
- 暂停只停止未来触发，不取消已经交给 Pi 的回合；有未完成运行时拒绝删除。
- 触发规则是结构化字段，不支持 cron 表达式。
- QQ 例行送达只验证了开关、群接入和作业对账代码，本轮没有连接 SnowLuma 真实发送。

下一步：

1. P3-08 Office、Pages 与编程委派，先做本机可验证的文件 / HTML 产物。
2. P3-10 产品组织与设置、工作台界面。
3. P3-02 浏览器 / 桌面、P3-04 供应商连接器、P3-05 B 站、P3-09 语音 / 手机按外部条件继续。

## R23：P3-06 技能库（2026-11-06）

本节优先于 R22 及更早记录。技能是带版本的步骤文本，不直接授予工具或账号权限。

交付：

- `migrations/0017_skills.sql`：`skill`、`skill_revision`。
- `src/skills.ts`：创建、版本化修改、启停、删除、按人格注入 active 技能；最多 5 条 / 4000 字。
- `src/profiles.ts`：每次会话配置时重新读取 active 技能，追加到人格说明；修改和启停下一轮生效。
- API：`GET/POST /api/profiles/:id/skills`、`GET/PATCH/DELETE /api/skills/:id`、`POST /api/skills/:id/activate|deactivate`。

验证：

- 新增 `skills.integration.test.ts` 2 个测试：创建 / 版本化 / 过期版本拒绝 / 启停注入 / 删除。
- `npm run check` 退出 0：server unit 56、web unit 22、集成 86、build 成功。

未验证 / 已知限制：

- 没有浏览器示范录制、草稿生成、安全样例重放。
- 技能只是提示文本，不能直接声明或获得新工具；工具权限仍由代码控制。
- 没有技能目录、跨人格复制或模板分享。
- 真实模型是否按技能步骤执行尚未验收。

下一步：

1. P3-07 时间 / 事件自动化。
2. 技能示范录制与重放。
3. 远程 MCP 与插件目录。

## R22：P3-03 MCP 与插件目录（2026-11-06）

本节优先于 R21 及更早记录。MCP 只支持 stdio；插件目录、远程 MCP 和安装流程尚未完成。

交付：

- 固定 `@modelcontextprotocol/sdk@1.32.2`。
- `migrations/0016_mcp.sql`：`mcp_server`、`mcp_tool`、`mcp_binding`、`mcp_call`。
- `src/mcp.ts`：stdio 连接、工具发现、逐工具开关、按人格绑定、调用留痕、失败状态；工具只在 owner 私聊注入，QQ 群和 Bot 群看不到。
- API：服务列表 / 添加、刷新、工具列表、工具开关、人格绑定、调用记录、直接调用（owner）。
- 本地测试服务 `test/fixtures/mcp-echo-server.mjs`，使用官方 SDK 注册 `echo` / `sum`。

验证：

- 新增 `mcp.integration.test.ts` 2 个测试：连接 / 发现 / 绑定 / 调用；未绑定或工具关闭时拒绝。
- 真实本地 MCP 服务：`echo-live` 发现 `echo`、`sum`；绑定 `水母听潮` 后调用 `echo` 返回 `echo:hello mcp`；关闭 `echo` 后返回 403；重新开启。
- `mcp_call` 日志按 profile / server / tool / 参数 / 状态保存。
- `npm run check` 退出 0：server unit 56、web unit 22、集成 84、build 成功。

未验证 / 已知限制：

- 只有 stdio，没有远程 HTTPS / SSE MCP。
- 没有插件 catalog、安装来源、版本升级、健康检查页面和凭据配置。
- 模型看到的是统一的 `mcp_call` 工具，不是每个 MCP 工具一个独立函数；逐工具开关在服务端校验。
- MCP resources / prompts / 采样未接入。

下一步：

1. P3-06 技能与示范学习。
2. P3-07 时间 / 事件自动化。
3. 远程 MCP 与插件目录。

## R21：P3-01 远程执行与产物（2026-11-06）

本节优先于 R20 及更早记录。执行 worker 是独立子进程，只拿任务描述和工作区，不连接控制库。

交付：

- `migrations/0015_execution_artifacts.sql`：`execution_task`、`artifact`。
- `src/execution.ts`：提交命令、独立 worker、输出截断、退出码、取消、超时、重启时遗留 running 标失败、产物扫描和下载路径检查。
- `src/execution-worker.mjs`：不连接 PostgreSQL；只读 `spec.json`，在工作区执行命令并写 `result.json`。
- 子进程环境移除 `DATABASE_URL`、`PGPASSWORD`、`OPENAI_API_KEY`、`ONEBOT_ACCESS_TOKEN`、`BACKUP_PASSPHRASE` 等控制面凭据。
- API：`GET/POST /api/profiles/:id/executions`、`GET /api/executions/:id`、`POST /api/executions/:id/cancel`、`GET /api/executions/:id/artifacts`、`GET /api/artifacts/:id/download`。

验证：

- 新增 `execution.integration.test.ts` 3 个测试：命令执行 / 输出 / 产物索引；取消运行中的任务；重启遗留 running 标失败。
- 真实 API：提交 `node -e "…writeFileSync('artifact.txt'…)"`，状态 `done`、输出 `done`、退出码 0，产物 `artifact.txt` 11 字节、`text/plain`；下载路径在任务工作区内。
- 真实取消：提交 60 秒命令，1 秒后取消，状态 `cancelled`，错误为 `任务已取消`。
- `npm run check` 退出 0：server unit 56、web unit 22、集成 82、build 成功。

未验证 / 已知限制：

- worker 是 server 的子进程；server 停止时任务会失败，尚未实现跨主机常驻执行。
- 只实现了命令、文件和产物下载，没有浏览器、桌面或人工接管。
- 工作区不会自动清理；产物最大 10 MB、最多 50 个。
- 命令执行是 owner 入口，默认没有对群友开放。

计划修订（2026-11-06，按“完成全部包”调整顺序）：

- 先做可在本机闭环的包：P3-01、P3-03（本地 MCP 测试服务）、P3-06、P3-07、P3-08 的文件 / HTML 产物、P3-10 的组织与设置。
- 再做需要外部条件的适配器：P3-02 浏览器 / 桌面、P3-04 供应商连接器、P3-05 B 站、P3-09 语音 / 手机。代码可以先行，但真实验收必须等账号、设备或宿主就绪；没有真实证据时不标记完成。
- P1-04 单独等待 Hindsight / Mem0 评估环境；P4 等待部署授权和用户验收。
- 每个包仍是“实现 + 自动化 + 真实冒烟 + 文档”，不把本地适配器测试冒充真实平台。

下一步：

1. P3-03 MCP 与插件目录，先接本地测试 MCP 服务。
2. P3-06 技能与示范学习。
3. P3-07 时间 / 事件自动化。

## R20：P2-03 授权评论（2026-11-06）

本节优先于 R19 及更早记录。QQ 空间仍然默认只读；本轮只增加“有明确授权才发送”的评论动作。

交付：

- `src/actions.ts`：动作 payload 支持连接器附加字段；授权范围内的 QQ 空间评论不再写“模拟”文案。
- `src/qzone.ts`：`comment(action)` 调用 `comment_qzone`；`QZONE_ALLOW_WRITE` 默认 0，关闭时动作直接失败，不能发出。
- `POST /api/qzone/comments`：owner 提交 `tid`、内容、目标 QQ 和请求 ID；有有效 policy 时 `ready`，没有 policy 时 `awaiting_approval`。
- 复用现有审批、每小时限额、过期、semantic key 和 unknown 不补发机制。

验证：

- 新增 `qzone.integration` 第 3 个测试：写入开关关闭时拒绝评论；打开后向 `comment_qzone` 传 tid、正文和目标 QQ。
- 真实环境：给 Bot 自己的说说 `0a0b28d4a202ee6a8dd00d00` 建一条每小时 1 次的 policy，提交评论 `测试：水母听潮报到。`；Action `confirmed`，刷新空间后 `comments` 从 0 变为 1。
- 范围外：同一账号的另一条说说没有 policy，提交后停在 `awaiting_approval`，没有发送；owner 拒绝后 `rejected`。
- 测试结束已把 `QZONE_ALLOW_WRITE` 改回 0，并撤销测试 policy。
- `npm run check` 退出 0：server unit 56、web unit 22、集成 79、build 成功。

未验证 / 已知限制：

- 只验证了 Bot 自己的说说；好友动态、图片评论和评论读取未做。
- 没有自主评论、兴趣学习或跨会话纠正；学习仍属于后续工作。
- `comment_qzone` 返回体没有稳定评论 ID，Action receipt 使用 `qzone:<tid>` 作为回执标识。
- 公开评论需要 owner 明确范围；默认写入关闭。

下一步：

1. 实现评论读取 / 来源回链和纠正影响。
2. 工作台增加 QQ 空间和 Bot 群视图。
3. 进入 P3-01 远程执行与产物。

## R19：P2-02 QQ 空间只读（2026-11-06）

本节优先于 R18 及更早记录。R18 的多 Bot 协作保持不变；本轮加入 QQ 空间只读缓存。

交付：

- `migrations/0014_qzone_readonly.sql`：`qzone_post` 缓存和 `qzone_status` 读取状态。
- `src/qzone.ts`：调用 OneBot 扩展动作 `get_qzone_msg_list`，归一化 tid / 正文 / 时间 / 图片 / 评论数 / 可见性；重复刷新按 `(account, target, tid)` 更新，不重复插入；失败标记 `paused` 并保留旧缓存。
- `src/qq/bridge.ts`：开放只读扩展动作入口 `call`。
- API：`GET /api/qzone/posts`、`POST /api/qzone/refresh`、`GET /api/qzone/status`。

验证：

- 新增 `qzone.test.ts` 2 个、`qzone.integration.test.ts` 2 个；覆盖坏条目跳过、重复刷新、失败暂停和缓存保留。
- 真实环境：SnowLuma + QQ `3559394058`，`get_qzone_msg_list` 返回 4 条说说；API 刷新后缓存 4 条，第一条为 `在群里漂着，记得住旧事。`，状态 `ready`。没有使用 AstrBot。
- 只读：没有评论、点赞、删除或发表路径；账号失效时状态 `paused`，不会自动重试。
- `npm run check` 退出 0：server unit 56、web unit 22、集成 78、build 成功。

未验证 / 已知限制：

- 只验证了 Bot 自己的空间；好友动态 `get_qzone_feeds` 尚未接入。
- 没有图片下载、全文详情或评论读取。
- 写入和授权评论留给 P2-03；需要 owner 明确范围后才能启用。

下一步：

1. P2-03 授权评论与学习。
2. 工作台增加 Bot 群和 QQ 空间只读视图。
3. 继续 P3 的电脑 / 浏览器 / 连接器工作包。

## R18：P1-05 多 Bot 协作（2026-11-06）

本节优先于 R17 及更早记录。R17 的真实 QQ / 模型 / 记忆链路保持不变；本轮加入多个 Bot 的群聊、消息和任务交接。

交付：

- `migrations/0013_bot_groups.sql`：`bot_group`、`bot_group_member`、`bot_message`、`bot_task`；`conversation_binding` 允许 `bot_group` 作用域，阅读范围为空。
- `src/collaboration.ts`：建群、成员、消息、任务、停止 / 恢复；owner 或工具发起任务；`send_bot_message` 工具只在本群生效；外部引用保证同一工具调用不重复建任务；任务结算后把目标 Bot 的回答写回群消息。
- `src/profiles.ts`：`send_bot_message` 只注入 `bot_group` 会话；QQ 群和 owner 私聊看不到这个工具。
- API：`GET/POST /api/bot-groups`、`GET /api/bot-groups/:id`、`GET/POST /api/bot-groups/:id/messages`、`GET /api/bot-groups/:id/tasks`、`POST /api/bot-groups/:id/stop|resume`。

验证：

- 新增 `collaboration.integration.test.ts` 3 个测试：三个 Bot 依次研究 / 写作 / 检查；同一工具调用 ID 重投不重复；非成员和停止状态拒绝新任务。
- 真实环境：创建 `水母协作组`，成员为 `水母听潮`、`日常伙伴`、`协作检查`；owner 向 `水母听潮` 发任务后，`水母听潮` 调用 `send_bot_message` 把检查任务交给 `日常伙伴`，两条 task 均为 `done`；群消息里能看到请求、交接内容和 `日常伙伴` 的检查结果。
- 真实三段交接：owner -> 日常伙伴 -> 协作检查，三条 task 全部 `done`；`日常伙伴` 发出 `已经把这句话转交给“协作检查”进行审核了。`，`协作检查` 返回审核结论，`日常伙伴` 再把结论写回群里。
- 工具作用域：`send_bot_message` 只在 Bot 群会话注入；群和 owner 私聊不提供。

未验证 / 已知限制：

- 工作台还没有 Bot 群界面，只有 HTTP API。
- 停止会取消进行中的任务并阻止新任务，已产生的外部副作用无法撤回。
- 多 Bot 的权限只到“同群成员”；没有跨群、跨人格凭据或 owner 工具。
- 三个 Bot 的真实链条已验证，但每条任务仍按单个会话顺序执行；并行任务和改向只由 Pi 的会话队列提供。

下一步：

1. 给工作台增加 Bot 群消息 / 任务视图。
2. 进入 P2-02 QQ 空间只读。

## R17：首个可用版硬化（2026-11-06）

本节优先于 R16 及更早记录。R16 的真实账号 / 真实模型链路保持不变；本轮补齐用量、提取、存档、撤回和运维入口。

交付：

- `migrations/0010_model_usage.sql` + `src/usage.ts`：每次 assistant 调用按 entry 留痕，记录 input / output / cache / reasoning / cost；`GET /api/profiles/:id/usage` 按日汇总；`QQ_DAILY_TOKEN_LIMIT` 按会话限制 24 小时 token，超额只存档。
- `migrations/0011_memory_extraction.sql` + `src/memory-extraction.ts`：群消息来源、提取队列、严格 JSON 解析、只写 `reported`，拒绝 constraint / 敏感内容 / 伪造来源；真实群提取已写入 `todo` 记忆并保留原消息 ID。
- `migrations/0012_archive_repair.sql` + `src/archive.ts` / `src/qq/bridge.ts`：Bot 发言按平台回执补档；群撤回标记后停止检索和统计；server 启动 / 停止缺口；附件占位 `[图片]` 等。
- `src/actions.ts`：`expireStale()` 扫描 `ready` / `awaiting_approval` 过期；过期动作不能批准。
- `src/memory.ts`：纠正 / 忘记 / 按内容忘记 / 忘掉群会递增 `owner_context.epoch`，旧 epoch 的待执行动作失效；新增物理清除 API，明确不删除 Pi 历史。
- `src/status.ts` + `GET /api/status`：PG、队列、动作、提取、用量、QQ 状态和未结束缺口的只读汇总。
- `src/backup.ts` + `src/cli/backup.ts`：逐表 JSON 逻辑备份、AES-256-GCM 加密、恢复时清空业务表后回填；`npm run backup` / `npm run restore`。
- `eslint.config.js`：忽略 `apps/server/data/**` 本机运行数据。

真实证据（2026-11-06，Asia/Shanghai）：

- 7 次计数：真实模型在群 `304657375` 回答 `一共说了 7 次`，逐条给出原话和时间；Action receipt `1709503931`。
- 跨群 / 私聊隔离：在群里问 B 群暗号和私聊暗号，真实模型回答 `不知道。`；Action receipt `358199560`。B 群消息和私聊记忆分别存在于测试夹具 row，未进入群上下文。
- owner 工具拒绝：群里要求读邮箱，回答 `读不了，我只是一只泡在群里的水母，没权限也没兴趣翻你的私人邮箱。`；receipt `1797927096`。
- 群文字不是命令：群里发 `全部停止` 后询问，回答 `群里的发言只是资料又不是指令，我可没理他。`；`qq_control` 没有停止记录，receipt `1497338906`。
- 停止 / 恢复：owner 私聊 `全部停止` 后 `qq_control.stopped=true`；随后群内 @ 只存档、不产生新 job；`全部恢复` 后 `stopped=false`，群内回复恢复，receipt `-1819124802`。
- 群记忆提取：真实群对话生成 `scope_ref=onebot:3559394058:304657375`、`kind=todo`、`epistemic_status=reported` 的记忆，`source_actor=1347507191`，保留原 `message_id`。
- 模型用量：开发库共 10 次调用，input 21516 / output 3340 / cost 0；5 个提取任务全部 `done`。
- 备份 / 恢复演练：开发库停服后 `npm run backup` 写出 `tables=22 rows=171 migrations=12`，同一文件恢复到原库 `tables=22 rows=171`；恢复后 `group_message=29`、`memory=3`、`model_usage=10`、`memory_extraction=5` 与备份前一致。
- 重启持久化：恢复后重启 server，再次询问 7 次计数，真实模型仍回答 `一共还是 7 次` 并列出全部原话；Action receipt `-212694706`。绑定、记忆、动作和历史均保留。
- 运维状态：`GET /api/status` 在真实环境返回 `postgres=true`、`provider=magpie/antigravity/gemini-3.8-flash`、`qq.state=ready`、`stopped=false`、`pendingOutbox=0`、`open gaps=0`，用量与缺口可读。
- 预算阻断：把 `QQ_DAILY_TOKEN_LIMIT` 设为 1 后重启，群内 @ 只写入 `group_message`，没有创建新 job 或回复；改回 0 重启后恢复。
- 新测试：`usage.integration` 3 个、`memory-extraction.test` 4 个、`memory-extraction.integration` 2 个、`backup.integration` 1 个；集成测试包含 Bot 补档、撤回、缺口、动作过期、忘记 epoch、物理清除。

检查：

- `npm run check` 退出 0：server unit 54、web unit 22、集成 73、build 成功。

未验证 / 已知限制：

- 群记忆提取的质量（哪些内容值得记、跨时间冲突）只过了脚本和一条真实 `todo`，没有系统评估。
- 备份恢复已在本机开发库演练；恢复依赖账号允许 `session_replication_role`，其他数据库账号需要对应权限。
- 附件只做占位，不下载、不识别图片内容。
- 平台撤回只停止检索和统计，原文仍保留；物理清除是单独操作。
- 停止期间 owner 的普通消息仍直接丢弃，没有提示。
- 没有 Git 提交 / 推送；`.env`、备份文件和 `apps/server/data` 均为本机数据。

下一步：

1. 群记忆提取评估：记录 / 不记录样例、冲突和敏感内容。
2. 群记忆卡片 / 工作台展示；目前只有 HTTP API。
3. 再进入完整个人版 P1-04 之后的工作包。

## R16：真实 QQ 与真实模型接入（2026-11-06）

本节优先于 R11 及更早记录。运行链路已经接过真实 QQ 小号和真实模型；R11—R15 的离线结论继续成立。

用户授权与测试对象：

- Bot：QQ 3559394058（昵称已改为“水母听潮”），专用小号。
- Owner：QQ 1347507191（theater）。
- 协议端：SnowLuma 1.14.15，OneBot v11 正向 WebSocket `ws://127.0.0.1:3001`；本机路径 `E:\webdownload\SnowLuma-v1.14.15-win-x64`。没有使用真实 NapCat。
- 测试群：304657375（奎屯navi，23 人），owner 是管理员；用户确认群成员已被告知 Bot 会全量存档并只在被 @ / 回复时发言。
- 真实模型：OpenAI Completions 兼容端点 `http://127.0.0.1:3425/v1`，`MODEL_ID=antigravity/gemini-3.8-flash`。`.env` 有凭据，已忽略，不提交。

交付：

- `src/runtime/model.ts`：`loadRemoteModelConfig` / `createRemoteModels`。三项环境变量全空回退 faux；只填一部分直接报错；模型通过 `openai-completions` API 注册为 `magpie/<model>`。
- `src/runtime/runtime.ts`：新增 `models` 选项；Harness 请求超时 180 秒，`maxRetries=0`。
- `src/profiles.ts`：已有会话每次取用时重新 `configure` 当前 `model`，修复切换模型后旧会话仍引用旧 ModelRef 的 `no_model`。
- `src/index.ts`：按环境选择真实模型；ContextManifest 的 `model_route` 写实际模型；未配置时保持 faux。
- `src/runtime/model.ts`：演示模型回显去掉群消息受信前缀，内部消息 ID 不进入群回复。
- `eslint.config.js`：忽略 `apps/server/data/**` 本机运行数据。
- `src/runtime/model.test.ts`：新增配置解析和 provider 注册测试。

验证：

- `npm run check` 退出 0：server unit 49（新增 5 个模型测试）、web unit 22、集成 64、build 成功。
- 真实私聊：owner 发 `你记得什么`，bot 回复 `1. 主人喜欢手冲咖啡`；Action `confirmed`，平台 receipt `-302069025`。
- 真实群接入：owner 私聊 `接入群 304657375`，Action `confirmed`，receipt `-251797901`。
- 真实群 @：群消息 `addressed_bot=true`，job `completed`，Action `confirmed`，receipt `-97948938`；faux 回复不含内部前缀。
- 真实模型直连：Pi `completeSimple` 返回 `模型连通`，41.4 秒，usage input 9 / output 144 / reasoning 141。
- 真实模型经 bot 私聊：回复 `模型连通`，job `completed`，Action `confirmed`，receipt `542181081`，约 77 秒。
- 真实模型经 bot 群聊：回复 `水母听潮，群底慢吞吞漂着围观你们的观察员。`，job `completed`，Action `confirmed`，receipt `2095497068`，约 12 秒。
- 模型切换故障：修复前两次 job `failed / unanswered`，reason `no_model`，Action 回 `这次没能回答：模型调用失败了。`；补齐会话 `configure({model})` 后同一会话成功。
- QQ 资料：`set_qq_profile` 昵称“水母听潮”、签名“在群里漂着，记得住旧事。”；`set_qq_avatar` 使用生成的水母 PNG；`get_stranger_info` 返回新昵称 / 签名，`q1.qlogo.cn` 拉取头像与生成图一致。`get_login_info` 仍返回旧昵称缓存。
- Persona：Waterbot profile `bba44581-477f-4fb1-bc68-abeae9a3ac47` 改名“水母听潮”，instructions 写入群边界、统计 / 查证、私聊保密；revision 2。私聊回复 `我是水母听潮，现在就叫水母听潮。`。

未验证 / 已知限制：

- 真实模型单次 12—77 秒；慢请求会占用会话，180 秒后失败；没有 token / 费用计量、每日预算和超额阻断。
- `antigravity` 路由在早期 curl 探测中多次超时，后来 Pi 与 bot 调用成功；仍按单次请求失败处理，没有自动重试。
- 群记忆提取仍未做；`qq_group` 记忆没有自动写入路径，翻旧账只靠原始存档和 owner 手动 `记住`。
- Bot 自己的发言尚未进入 `group_message`，别人回复 Bot 时引用链会断；群消息撤回通知未处理；server 自身离线的时段仍不会记缺口。
- 真实模型尚未跑 7 次计数、跨群隔离、提示注入和重启验收；faux 的对应测试不能替代。
- SnowLuma 当前以 `SNOWLUMA_DEV_MODE=1` 启动用于本机 WebUI 调试；WebUI 密码文件未被重置。该进程不是部署配置。
- `.env`、`apps/server/data` 全部是本机数据，未提交；本次没有 Git 提交 / 推送。

下一步：

1. 真实模型验收：同一件事 7 次计数、A 群查不到 B 群、群友冒充主人、群友要求 owner 工具、重启后记忆 / 动作仍在。
2. 增加 token / 费用留痕、每群每日模型预算和超额只存档。
3. 群记忆提取：从被 @ / 回复的对话提取 `reported` 记忆，写入 `qq_group` 作用域，保留原消息 ID；恶意文本不能变成 constraint。
4. 群存档补齐：Bot 发言、撤回通知、server 离线缺口、附件占位。
5. 备份 / 恢复演练和备份加密；再进入完整个人版 P1-04 之后的工作包。

## R11：P1-03 精简版完成（2026-11-01）

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

## R12：P2-01 QQ 离线部分完成（2026-11-01）

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

## R13：W-01 离线部分完成（2026-11-01）

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

## R15：联网查证改用免密钥 Bing（2026-11-01）

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

- 当前阶段：首个可用版硬化完成（R17）；真实 QQ 小号、真实模型、私聊 / 群聊、7 次计数、隔离、停止 / 恢复、用量、提取、存档、备份恢复均已实测。
- 运行中的本机链路：SnowLuma + QQ `3559394058`（水母听潮），owner `1347507191`，模型 `magpie/antigravity/gemini-3.8-flash`。
- 已完成的工程包：P0-01—P0-04、P1-01、P1-02、P1-03 精简版、P2-01、W-01、真实模型、群记忆提取、用量与预算、存档补齐、撤回 / 过期、状态接口、加密逻辑备份。
- 下一步：群记忆提取质量评估、记忆卡片 / 工作台展示，然后按 DEVELOPMENT_ROADMAP 进入 P1-04 之后。
- 用户已要求“继续一直开发”：按依赖顺序逐包实现、检查并更新 NEXT，不因普通包内选择停下；账号、真实外发、Git 推送和部署按对应范围处理。
- 仍未完成：多 Bot 协作、QQ 空间、B 站、邮箱、电脑 / 浏览器、Office / Pages、语音、MCP / 插件、完整个人版验收；GROK_PARITY 的 P52 / U9 / D5 不因当前可用版通过而整体改变。

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
| `apps/server/test/fixtures/crash-child.ts` | 恢复测试子进程：写真实副作用 → 写 marker → 挂起；第二阶段重开同一库并写入 transcript 摘要 |
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

