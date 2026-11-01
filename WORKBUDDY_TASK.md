# WorkBuddy 交接记录：P0-04

用户现已要求由 Codex 自己接手继续开发。WorkBuddy 不再进入任何新工作包；已有 P0-04 改动作为交接基线保留，后续实现、审查和进度由 Codex 更新。下面保留此前任务合同供核对，不能据此再次启动开发。

用户已要求“继续一直开发”，不逐包向用户重新请求许可。执行模型保持 DeepSeek V4.1 Flash；Codex 逐包审查和独立验证。

先读 AGENTS.md、NEXT.md、DEVELOPMENT_ROADMAP.md 的 P0-04、design/BP-01-runtime-persona-memory.md 的存储 / 入站 / 两库衔接合同，再检查已有 runtime。P0-03 经 Codex 审查返修，独立 typecheck / lint / test:unit（40 个）/ build 通过。Codex 另把 Node 最低版本改为 >=22.19.0（上游要求），并修正测试子进程 helper 对 signalCode 的判断；修正后 server 25 个测试通过。保留这些变动。

当前实现 P0-04 的完整闭环：

1. 真实 PostgreSQL 产品业务库，使用 pg 之类成熟驱动，不拿 SQLite / PGlite / 内存 mock 替代验收。只建当前实际需要的 inbound_event、dispatch_outbox、job / submission mapping 等表；人格 / 记忆表留到对应包，不提前铺空壳。
2. 最小可重复迁移入口，事务执行，迁移状态可核对，重复运行不破坏已有数据。业务表与 Pi SQLite 保持明确所有权，绝不直接改 Pi 内部表。
3. 同一 PG 事务落入站事件和 outbox，稳定 requestId，平台事件唯一约束。相同事件重投返回原记录；相同身份但不同 payload 不可静默错当相同意图。
4. dispatcher 使用真实 Pi Durable 的 submit/requestId，保存真实 submission id。Pi 已受理而 PG 映射未保存时，重启 / 重试仍使用同一会话和 requestId，不重复添加用户输入或工具效果。claim / lease / 更新条件要防止两个 dispatcher 同时越权完成同一记录；失败可恢复，不能永远卡在 processing。job 状态不得在只受理时就伪称 completed。
5. 故障测试覆盖 PG 事务回滚、唯一性 / 事件重投、并发 claim、正常派发、Pi 已受理但映射未保存。关键两库崩溃窗口用真实子进程和受控同步点验证重启后对账；不要只测 mock submit 返回同一个数字。
6. 建立实际 test:integration 等入口，默认完整检查入口应覆盖必要集成测试，或明确一个真实 check 脚本串起所有必要检查。不能把集成测试默认静默跳过而报告全绿。
7. 本地开发的 PG 启动、迁移、停止与连接配置可实际执行。只监听回环地址，生成的本地开发密码不写进源码 / 控制台 / NEXT，数据与秘密放忽略路径。不得改系统用户、服务或全局设置。保留 8787 / 5173 的开发页面可试用，必要重启应恢复。
8. 全部实际运行 typecheck / lint / unit / integration / build，失败修复。NEXT 只记真实实现和证据，区分无凭据、真实数据库与真实平台验收。完成后交给 Codex 审查，接着推进 P1。

环境与已验证的解法：
- 已安装 Docker Desktop 启动失败，报本地 dockerInference socket 路径错误；不要重置、重装或修改全局 Docker 配置。
- Codex 在临时目录验证了 embedded-postgres 18.4.0-beta.17 所带的 Windows x64 PostgreSQL 18.4，真实连接 127.0.0.1:55432、SQL 事务回滚成功。预检目录 C:\Users\theater\AppData\Local\Temp\personal-agent-pg-preflight-20261028 可读取其中安装包 / 自建 probe，不含用户私人配置；不要把此临时路径变成项目运行依赖。
- 可将 embedded-postgres 仅用作项目 dev dependency 的二进制分发，实际启动直接使用公开平台二进制子包（Windows 为 @embedded-postgres/windows-x64，导出 initdb / pg_ctl / postgres），使用成熟 pg 驱动连接。
- 不要在 Vitest 主进程直接 import embedded-postgres 包装器：它的 async-exit-hook 绑定 beforeExit 到退出 0，可能吞掉 process.exitCode=1，导致测试假成功。可读其已安装源码核对。采用直接二进制，或完全隔离的 PG 宿主进程，保证失败仍能返回非零。
- Windows 用 pg_ctl 时不要等待后台 postgres 继承的 stdio 管道全部关闭；启动命令用不继承管道的 stdio 或等待自身 exit 事件，并使用 pg_ctl -w / 真实连接作为就绪条件。停止使用 pg_ctl fast shutdown，测试结束回收自己的数据库进程后再清理自己创建的目录。
- 可以支持 TEST_DATABASE_URL / 项目自己的开发数据库配置，但不连接或删改未明确归属于本项目的既有数据库。隔离测试 database/schema，清理前核对准确目标。

所有 PowerShell 任务通过 C:\Program Files\PowerShell\7\pwsh.exe -NoLogo -NoProfile 执行。允许项目编辑、必要本地依赖、本项目自己的测试数据库与服务；不提交/推送、不部署、不全局安装、不接真实平台/模型 API、不真实外发、不提取秘密，不创建其他代理。

