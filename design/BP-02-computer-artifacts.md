# BP-02：电脑、浏览器、本机连接与产物

版本：R3，2026-10-28。详细设计，尚未实现。负责 P16—P23、P36—P41 及共享文件的隔离边界。与 [BP-01](BP-01-runtime-persona-memory.md) 共用身份、epoch、Action 和产物权限。

## 1. 部署形态

主程序运行在独立常开主机，owner 关闭笔记本不会停止云端任务。执行环境使用持久 Linux VM 或经验证的现有 sandbox 服务，浏览器和桌面放在执行环境内。首版不自建 VM 集群调度平台。

worker 与控制程序可以部署在同一物理主机，但使用不同权限主体、存储挂载和进程边界。主程序的数据库、备份、连接器凭据不可出现在 worker 文件系统中。能读取用户授权工作文件，不等于能读取控制服务的全部目录。

建议先验证：一个常驻 server、一个持久执行主机、多个人格私有执行空间，以及一个 Qzone sidecar。按并发实际需要增加 worker，不按 Bot 数量提前启动同等数量的空闲 VM。

## 2. 执行对象

| 对象 | 字段 / 内容 | 约束 |
| --- | --- | --- |
| ExecutionSpace | id、profile_id / explicit_shared_scope、worker_id、root、state | active / sleeping / disconnected / needs_recovery |
| BrowserProfile | id、owner / shared_grants、account_bindings、storage_ref、version | 独立 profile，不导入用户已有浏览器资料绕过授权 |
| DesktopSurface | id、space_id、display_ref、control_state | 每个工作面有独立控制权 |
| ControlLease | surface_id、holder、version、expires_at | agent / human / none，一次只允许一方输入 |
| WorkspaceGrant | space_id、resource_ref、read / write、audience | 只挂载被授权的私有 / 共享目录 |
| WorkerReceipt | action_id、status、external_ref、evidence_ref | 不因重新连接重复执行已进入发送的动作 |

共享工作区和共享浏览器是显式选项。多个人格可共同使用同一资料；一旦共享同一登录态，其账号效果也共享，UI 必须显示。严格隔离的空间不能靠目录名或浏览器 tab 代替 sandbox / 访问控制。

## 3. 执行契约与 Pi 映射

Pi 的 env 回调根据受信 ConversationBinding 选择执行空间，不接受模型直接传任意宿主 cwd。NodeExecutionEnv 是本机执行实现，不是隔离产品；生产社交人格不能直接获得控制服务器的 NodeExecutionEnv。

本项目的 worker 协议提供：能力与健康状态、受限工作文件读写、命令执行 / 终止、浏览器观测与操作、屏幕观测与输入、文件传输及回执查询。具体方法通过当前 Pi ExecutionEnv 的公共接口实现，并做上游 conformance 检查；桌面和浏览器操作作为产品工具另行注册。

所有写请求携带 job、action、profile、space、epoch、请求内容 hash 和短期执行授权。worker 校验签发方、目的空间和有效期，按 action ID 保存接收 / 开始 / 完成记录；重复请求只查回执。主程序重启更新运行代际，旧连接不能继续接受新任务。

命令传参数数组；确需 shell 语法时在指定 sandbox 执行。输出限额、超时、取消、临时文件和最终文件分别处理。网络与工具范围根据空间用途设置；不把任意宿主命令包成一个“已安全审批”的通用工具。

## 4. 浏览器与桌面

首选验证 agent-browser 的导航、DOM / 可访问树、截图、持久 profile 和实时画面输入；关闭其额外 AI 对话循环，推理由 Pi 控制。noVNC 用于桌面查看与人工输入；桌面自动点击还需 worker 内的受限输入驱动，noVNC 本身不是 agent 推理或自动化引擎。

浏览器操作遵循 observe → act → verify。元素定位来自当前观测，页面变化后重新观测。网页抓取不能替代交互浏览器，浏览器也不能替代完整桌面操作。

每个 surface 使用版本化 lease。人工接管：暂停 agent 输入队列 → 释放 agent lease → 授予 human lease → 完成后撤销 human lease → 新观测 → 才允许 agent 继续。断线不自动把输入权交回 agent；敏感步骤仍待用户明确交还。

登录、验证码和支付确认期间暂停该工作面的模型观测与示范录制；不把密码字段、剪贴板和验证输入送入模型、日志或技能。用户填写后只保留会话可用状态，不记录秘密文本。

## 5. 浏览器副作用与能力限制

结构化接口的目标、账号、正文可由程序严格校验；通用网页与桌面点击没有天然精确的“发送”语义。BrowserActionGate 使用当前页面信息、目标定位、已知站点规则和风险判断；无法识别的高影响操作进入待审。

不能只限制名为 send 的工具，却允许脚本、HTTP 或浏览器绕开。受控账号操作优先走具名连接器；worker 不持有控制程序全部令牌。已授权网页登录只存在于对应 profile，按规则使用。

对于任意网页 / 任意 shell，语义分类并非数学保证。首版必须用实际目标网站和负例测试边界，并在不确定时停下；不能把模型审查写成覆盖所有网站行为的完美防线。

## 6. 本机连接与网络路由

本机 agent 通过出站认证连接配对到 server，配对密钥保存在系统安全存储，权限按设备设置：不允许、一次允许、指定目录 / 动作持续允许。默认不开放整个磁盘。

本机离线时作业显示 waiting_device；不退回访问另一台设备的同名路径。Windows 执行 PowerShell 使用用户偏好的当前稳定 pwsh；后台进程默认隐藏窗口。

经本机网络访问仅用于明确授权的网络资源，不用来绕开平台拒绝或安全限制。可限制目标与路由范围，断开后立即停止新连接；界面显示当前实际执行位置和网络路径。

硬件安全钥匙属于平台桥接能力，必须验证宿主、浏览器及设备转发路径。远程画面可看不代表钥匙转发可用；该项按 GROK_PARITY 的 D04 保持缺口，直到有真实证据。

## 7. 文件与产物模型

Artifact 包含 id、owner_profile_id、job_id、kind、mime、storage_ref、version、source_refs、audience、visibility、render_status 和校验信息。原始附件不可被输出覆盖；修订产物创建新版本。

支持声明的格式必须分别验证：图片、音频、视频、PDF、Office、CSV / JSON / YAML、HTML / 邮件、源码与 notebook。超限、加密、损坏或不支持内容返回可理解的失败，不编造已读取。

生成能力通过执行环境中经过固定版本验证的文档 / 表格 / 演示文稿工具提供，不依赖聊天模型直接宣称已生成。验收包含重新打开、结构 / 公式检查和视觉渲染；需要重算的表格必须验证缓存与计算结果。

浏览器下载、邮件附件和远程媒体统一进入受限的下载 / 导入路径，校验大小、类型、重定向和本地路径；禁止把不可信文件路径当作任意宿主文件操作。

## 8. Pages 与分享

Page 是独立产物：结构化内容 + 引用数据 + 渲染资源 + 版本，而非把任意 HTML 直接注入工作台。支持图表、表格、跟踪器与交互组件，并能由例行任务更新指定版本。

受信的工作台与生成内容使用不同 origin / 沙盒边界。生成脚本不能读工作台凭据、记忆 API 或浏览器会话；确需数据通过明确授权的数据接口提供。

公开分享使用经过用户确认的发布副本与随机不可猜链接，内容和引用都检查可公开范围；取消分享阻止后续访问。独立下载副本和第三方已获得内容无法由撤销链接收回。模板分享不得包含凭据、私有历史和隐含挂载路径。

## 9. 持久性、备份和恢复

server 是单进程单写者；由 systemd 或容器生命周期管理恢复，禁止多个实例同时打开同一 Pi 存储。数据库、业务文件、browser profile 和 worker 卷各有版本与备份清单。

数据库使用受支持的在线备份 / 一致快照，不直接复制正在写入的单个 SQLite 主文件。Pi 默认 SQLite 持久性描述不等于断电零丢失；是否需要更强刷盘配置在 P0 验证。

R4 数据库分工为 Pi SQLite 与业务 PostgreSQL，Hindsight 若采纳则有独立数据库 / 账号。各自使用支持的备份和迁移流程，恢复时核对业务 outbox、Pi 回执、worker 回执和产物版本；不是把所有库放同一主机就自动获得一致事务。

一致性恢复顺序：停止新入队 → 记录正在 sending 的动作 → 备份 app / runtime 及文件版本引用 → 恢复后对账 Pi 提交、业务 outbox 和 worker 回执 → 未能证明完成的外发标为 unknown → 才恢复自动任务。

数据备份包含秘密材料时加密，备份密钥与数据分开。UI 明示当前备份时间和已知未保存变化；不伪造 RPO / RTO，待实测后记录指标。

## 10. 运维与验收

基本观测：运行时错误、parked task、worker 心跳、控制权、队列积压、账号失效、未知动作、用量和产物渲染失败。日志以 ID 和状态为主，默认不记录完整正文、凭据或视频帧。

测试至少覆盖：客户端关闭继续工作、server 重启、worker 断线重连、人工接管互斥、共享目录越权、浏览器 profile 串号、本机离线、Page 访问撤销、产物修订和备份恢复对账。首次真实部署在限定账号 / 样例任务验收后再开启自主写入。

来源：[agent-browser](https://github.com/vercel-labs/agent-browser)、[noVNC](https://github.com/novnc/noVNC)、[Pi 固定版本存储及环境说明](https://github.com/earendil-works/pi/blob/72363383ff79d3f12cfa91b03cddb3eb333c6ebc/packages/durable/README.md)、[OpenComputer 自托管备选](https://github.com/diggerhq/opencomputer/blob/main/SELFHOSTING.md)。worker 协议、权限和产物方案为应用设计，尚未验证组件间兼容。
