# InkOS 学习与复用 TODO

本文把 InkOS 中适合 AgentPress 的产品行为拆成可独立验收的工作项。目标不是移植
InkOS，也不是继续扩张现有协调器，而是在保留 AgentPress PostgreSQL 事实源、官方 Pi
Runtime、审批和文章版本边界的前提下，优先复用现有依赖、仓库能力和经过测试的上游行为。

Web 展示层已经完成的对齐项见 `docs/inkos-web-agent-alignment.md`。本文关注尚需持续审计和
实施的运行协议、Multi-Agent、Review/Recovery、Context、Skill、Web Research 以及相应的
产品投影。

## 固定上游与许可边界

- 上游：[`Narcooo/inkos`](https://github.com/Narcooo/inkos)
- 版本：`v1.7.2`
- Commit：`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`
- License：`AGPL-3.0-only`
- 当前决定：行为和测试参考，不复制 InkOS 源码或测试；若未来决定复制，必须先完成明确的
  AGPL 分发评估，再更新 `THIRD_PARTY_NOTICES.md` 和本清单。
- AgentPress Runtime：继续使用 `@earendil-works/pi-agent-core@0.82.1` 和
  `@earendil-works/pi-ai@0.82.1`，不得引入 InkOS 的旧 Pi Runtime 形成第二套事件模型。

## 四类能力展示盘点与复用裁决

本节回答“界面上如何展示、哪些值得学、落到哪里、哪些不能照搬”。证据均来自上述固定 commit；
它是本清单唯一所称的 InkOS，GitHub 上同名的电子墨水系统、操作系统练习和无关 fork 不在调研范围内。

| 能力                  | InkOS `v1.7.2` 的真实展示                                                                                                                                                                                                                                                                                                                                                                          | 值得 AgentPress 学习                                                                                                                                        | 本项目复用与落点                                                                                                                                                                                                                                                                                    | 不采用或需修正                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Multi-Agent           | `sub_agent` 以消息流中的 pipeline operation 展示；Architect/Writer/Auditor/Reviser/Exporter 转成业务标签，卡片显示 running/processing/completed/error、耗时、阶段、字符进度和日志；运行时展开，完成 500ms 后折叠；连续 read/edit/grep/ls 合并为“n 个文件操作”；生成物预览和确认动作位于过程详情之前                                                                                                | 用户看目标、当前角色、阶段、耗时和业务结果，不把 Agent 拓扑当产品导航；低价值操作聚合；长任务可展开审计；结果优先于日志                                     | 继续复用 AgentPress Execution Plan、Task/Attempt、lease/fencing、Kafka worker、TaskResult、Artifact、Proposal、RunEvent projector 和 `assistant-ui@0.15.1`；应用层 owner 拆为 planner、DAG scheduler、task executor、specialist runtime、result/evidence store、synthesis，Web 只消费 typed RunPart | 不复制 `sub_agent` 状态机、任意角色创建、文件事实源、私有 thinking、原始日志默认展开或普通聊天完整工具表；不把所有状态分支塞进 `PlannedRunExecutor` 或单个 React renderer                                          |
| MCP                   | **InkOS 没有 MCP 子系统，也没有 MCP Server 管理或 MCP 专用 UI**；只能借鉴其通用工具活动与结果优先展示                                                                                                                                                                                                                                                                                              | MCP 是传输/工具来源，不应成为普通作者必须理解的主导航；用户主要看到业务动作、审批、结果、失败和恢复，JSON-RPC/transport 放到审计详情                        | 直接使用 `@modelcontextprotocol/sdk` 和现有 `packages/mcp-runtime`，复用 Oh My Pi reconnect、pi-mcp-adapter output guard、PersistentToolBridge、ToolCall ledger、approval/settlement、Run projection；首版仍是三个内置 Server                                                                       | 不得声称 MCP 来自 InkOS，不新造 MCP manager，不开放任意 stdio/remote Server，不让 Server/tool list、Skill 或网页内容授予 capability；Domain 不暴露 transport/JSON-RPC 类型                                         |
| Skill                 | Composer 的 `+` 打开 Skill picker；列表展示名称、`@id`、来源和用途，勾选后成为可移除 chip，只强制下一条消息并在发送后清空；Agent 也可按意图自主调用；设置页可导入含 `SKILL.md` 的 AgentSkills/OpenClaw 文件夹，显示未加载诊断、来源和删除入口；脚本明确不自动执行                                                                                                                                  | 显式选择与模型选择并存；选择贴近 Composer；来源/诊断进入管理面；Skill 是当轮声明式上下文，不是永久权限                                                      | 复用现有 Skill Revision、Run Skill Binding、`validateSkillConformance`、`discoverSkillsWithWarnings`、PiSkillPreselector 和 `badlogic/pi-skills` 格式证据；owner 分为 discovery、selection、binding、resource loading、tool narrowing，版本/hash 固定到 PostgreSQL Run                              | 不复制本地目录为事实源，不执行脚本，不扫描凭据，不把 `use_skill` 当授权；InkOS 没有 AgentPress 所需的不可变 revision/hash 投影，其激活工具还会落入通用 utility 分组，本项目必须保留独立 Skill part/chip 和审计事实 |
| Web Search / Research | `research_web` 接收 topic、purpose 和 quick/standard/deep；完成结果是保存路径、来源数、confidence、partial failure 数，完整报告写入本地 Markdown，含 summary、claims、conflicts、unknowns、creative implications、sources、query log；设置页直接配置 Tavily/兼容端点、环境变量名和 API key；但 `research_web` 未进入 pipeline tool 集合，会被通用“文件操作”分组，没有专用 Research result renderer | 不只暴露裸 query；输出显式区分 Claim、冲突、未知项、来源、置信度和部分失败；外部资料只是 reference，不能直接修改正文/事实；消息流显示摘要，完整材料按需打开 | 复用 `packages/web-research`、内置 `web_research` MCP、Evidence/Artifact persistence、SSRF/output guard、`parse5@7.3.0`、`unpdf@1.8.0` 和 `pi-web-access@v0.15.0` provider 行为；research policy 独立拥有查询扩展、去重、并发、预算与来源上限                                                       | 不复制 Tavily 专用领域字段、明文项目级密钥、本地 Markdown 事实源、串行抓取、正则去 HTML 或误导性的“文件操作”投影；来源数不等于可信度，Claim 必须关联当前 Run/Task 的 Evidence ID，恶意网页内容始终是 untrusted     |

### 展示层完整清单

以下项目是产品投影的穷举基线。新增展示项必须先有稳定事实和 typed projector，React 不得根据文案、
tool 名称、timer 或 provider 名称猜状态。

#### Multi-Agent

- [x] 顶层目标、当前业务角色、阶段、运行状态、耗时和完成摘要进入消息流；不新增 Specialist 导航栏。
- [x] active pipeline 自动展开，settled pipeline 自动折叠，用户手动展开后不被轮询 timer 反复抢夺。
- [x] 低价值连续工具调用聚合；Approval、Ask User、Evidence、Artifact、Article Change、Recovery 和 Warning
      保持独立可见。
- [x] Product outcome 和接受/拒绝动作先于 pipeline、日志和原始 tool result。
- [ ] 补齐 partial success、Specialist timeout、预算耗尽、取消、恢复、late result 和 synthesis failure 的
      typed 消费者状态；同一事实在 live SSE 与 PostgreSQL replay 中必须同构。
- [ ] 用 Playwright 验证桌面/移动端长角色名、长阶段名、并行 Task、折叠、失败、恢复和无重叠。
      已新增可复用的 `degraded` fixture：部分成功、`completed_with_degradation`、恢复提示、长角色/服务
      标识和凭据错误脱敏断言；原有 streaming fixture 仍通过。完整浏览器验收还需要刷新有效认证状态后重跑
      桌面/移动端 degraded 场景，再补 timeout、cancel、budget exhausted 和 synthesis failure。

#### Multi-Agent 证据级 TODO

InkOS 的 `packages/core/src/agent/agent-tools.ts` 是固定
`architect|writer|auditor|reviser|exporter` 的单工具路由器，不是可复制的动态 Agent 网络；
写作、审阅和恢复的行为证据分别位于 `packages/core/src/pipeline/runner.ts`、
`chapter-review-cycle.ts` 和 `chapter-state-recovery.ts`。按这些源码和测试执行：

- [ ] 为 Plan/Task/Attempt/ToolCall/Artifact/Evidence/Proposal/Settlement 建立一个 PostgreSQL
      event-chain fixture；同一 fixture 的 live SSE 和 replay 必须输出深相等的 `RunPart[]`。当前已用真实
      ToolCall settlement publisher 与 `RunProjectionService` PostgreSQL replay 证明 activity RunPart 深相等，
      并另有 `task.timed_out` PostgreSQL replay fixture；Plan/Attempt/Artifact/Evidence/Proposal/Settlement
      的完整单链 fixture 仍待补齐，因此总项不勾选。
- [ ] 定义 typed activity outcome：`succeeded|degraded|failed|cancelled|timed_out|interrupted|stale|outcome_unknown`；
      projector 不得把 degraded 映射为 completed 或普通 error。当前 Web consumer status 已保留
      `degraded|failed|cancelled|timed_out|interrupted|stale|outcome_unknown` 并有 102 个 Web 测试，但还需把完整
      outcome 矩阵作为 host-owned RunPart fact 接入所有 PostgreSQL/live-SSE 场景后才能勾选。当前
      `packages/agent-application/src/run-projection.ts` 为普通 activity 写入不可变 `outcome`，并将
      `tool.outcome_unknown` 投影为独立 warning part；outcome 同时复制到 lifecycle stage。103 个 Agent
      Application tests 与 102 个 Web tests 通过，ToolCall live/replay 深相等集成已通过，但其余完整事件链仍待补齐。
- [x] 定义 host-owned typed stage fact（`stageId/labelKey/status/startedAt/completedAt/progress`），
      本地化只发生在 projector/consumer；React 不得匹配日志或阶段文案来推断状态。
      `run-projection.ts` 现在从 durable event 确定性生成 stage identity、label key、时间、outcome 和可选
      progress；Web consumer 只本地化受控 `labelKey`，未知旧事件才使用兼容 fallback。Agent Application
      96 个测试和 Web 92 个测试覆盖 opaque status + typed label/outcome 场景。
- [ ] 为 execution/task/attempt 统一 correlation id；所有 progress/log/result 必须带归属，缺 id 时
      fail closed，不回退到“最近运行项”；补齐乱序、重复、旧 attempt 晚到、断线、刷新和 worker 重启回归。
      当前 Specialist terminal/skip event 已持久化 attempt，RunPart 写入 `correlationId`；Task lifecycle 使用
      `taskId + attempt` 隔离，缺 attempt 的历史事件保持独立而不按 taskId 猜测。旧 attempt 晚到与缺身份
      fail-closed 测试已通过，五 Specialist PostgreSQL fixture 证明 5 个 terminal event 均携带 attempt；
      progress/log 全链、断线刷新和 worker restart 仍待补齐，因此总项不勾选。
- [ ] 将 planner、DAG scheduler、task executor、lease store、Specialist runtime、result/evidence
      store、synthesis、projection 固定为窄 Port/Command/Event owner；禁止共享 mutable plan context、
      隐式 callback 链或新增 `AgentManager/RunCoordinator`。
- [ ] 固定角色 label、allowlist、budget、timeout、maxAttempts、output schema 和可见 Artifact policy；
      Specialist 私有 thinking 只能留在受保护事实中，Main 只消费闭合 TaskResult/Evidence/Artifact/Usage/error。
- [ ] 故障矩阵覆盖模型拒答/断流、输出 Schema 失败、非法 TaskResult/Evidence、越 run/task/attempt 引用、
      Artifact 越权、synthesis 失败、partial success、依赖 skipped、budget exhausted、cancel/recover race、
      Kafka duplicate/out-of-order 和 late settlement；“审阅无需修订”必须不创建 Reviser Task。
- [ ] UI 只展示目标、业务角色、阶段、耗时、typed outcome 和摘要；结果/Artifact/Evidence/审批先于诊断，
      utility 按 typed category 聚合，settled 全部折叠且不被 timer 抢回；删除第二套 Sidebar progress reducer。
- [ ] 用真实 Pi/目标模型验收 research -> writer -> fact_checker/editor -> proposal、no-change review、
      partial success、timeout、conflicting Evidence、cancel/recover 和 budget exhaustion，并保存完整版本 manifest。

#### MCP

- [x] 普通消息流使用“联网研究、工作区检索、授权媒体”等业务标签，不显示 Server transport 或 JSON-RPC。
- [x] ToolCall 状态、审批、用户可操作错误、Evidence/Artifact 结果与恢复状态来自统一 RunPart projector。
- [ ] 审计详情展示 server/tool/revision、参数摘要、耗时、重试、输出引用和脱敏错误；凭据、原始 header、
      stack、私有 thinking 与超大输出正文不得进入消费者 transcript。
      当前 Web consumer projector 已把 MCP provenance 转为有界 `ToolActivityAudit`，在过程详情内按需
      展示 server/tool/adapter revision、Specialist task attempt、参数名和 Artifact 引用；普通标签仍只显示“搜索资料”等
      业务动作。原始参数值和 transport 对象会在进入 assistant-ui transcript 前从成功、失败和待审批
      ToolCall 中删除，刷新后再次净化不会丢失 Artifact 引用。schema-aware 参数值摘要和 retry 尚未
      完成，因此总项保持未勾选；redacted failure 已单独完成。
      其中 redacted failure 已完成：ToolCall settlement 依据 typed `ToolRuntimeError`、
      `ToolExecutionError` 和 side-effect 风险生成 `code/messageKey/retryable`；ledger 只在 protected
      failure 中保留截断后的诊断，RunEvent/live/replay 只携带公共结构，Web 对旧的非结构化 failure
      fail closed。未知副作用仍保持 `outcome_unknown`，不会被转成普通失败或自动重试。
- [ ] Server/tool revision 变化、断线重连、调用中断线、重复结果、`outcome_unknown` 和旧连接晚到结果必须
      有独立 projection fixture 与 Playwright 场景。

InkOS `v1.7.2` 及 2026-08-03 的 `master` HEAD
`a6e05d4d4567df0efd5825e9b0037146a16e4f3e` 都没有 MCP 业务源码、配置页、生命周期或测试；
lockfile 中的 `@modelcontextprotocol/sdk` 只是 Pi/Google GenAI 的传递依赖，不能当作 InkOS MCP 实现证据。
因此 MCP 技术实现没有可直接复用项，只有通用工具执行的渐进披露与时序呈现可作行为参考：

- [ ] ToolCall/RunEvent 事实补齐 `serverId/toolName/server/tool/provider/adapter revision/attempt`、
      authoritative timestamps、retry/reconnect、output reference 和 redacted failure；Web 不生成权威状态或时间。
      当前 `ToolDefinition.transport` 已固定内置 MCP 的 server/tool/revision/adapter，ToolCall ledger 与
      `tool.proposed`/`tool.approval_requested` durable event 会保存同一 PostgreSQL JSONB 快照；执行与
      idempotency replay 都校验当前定义和持久化来源完全一致，revision drift 会在 provider 调用前以
      `approval_mismatch` fail closed。Tool Registry、三个内置 MCP 工具和 21 个 ToolCall PostgreSQL
      集成场景已通过；attempt、authoritative timestamps、retry/reconnect 和完整 output reference 仍未
      补齐，redacted failure 已完成，因此总项保持未勾选。
- [ ] 为 disconnect-before/after-dispatch、stale client result 和 late result 投影独立 `outcome_unknown`；
      不压成普通 error/completed，也不自动重放可能有副作用的调用。
      当前 `tool.outcome_unknown` 已由 Agent Application projector 投影为独立 warning part，并写入
      `outcome_unknown` 和 `execution.outcome_unknown` stage label；Web Notice 保持“结果待核对”，不会映射为
      failed 或 completed，也不提供自动重试；warning 复用 activity sanitizer，原始 arguments/transport 不进入
      transcript。真实 PostgreSQL interrupted-call live/replay fixture 已通过。disconnect-before-dispatch、
      stale late result、duplicate end 和 Playwright 场景仍待补齐。
- [ ] approval/denied/cancel/degraded/duplicate-result/recovered 各有 typed event；权限只来自宿主 capability、
      Approval 和 Settlement 事实，远端 Server、Skill、网页内容和工具名称不能授予权限。
- [ ] 复用现有 RunPart projector 增加 MCP 审计投影：消费者只显示业务 label；server/tool/revision、attempt、
      retry、duration、schema-aware 参数摘要、output refs 和脱敏错误只进入按需详情。
- [ ] guarded raw payload、JSON-RPC、header、credential、stack 和 private thinking 不进入普通 transcript；
      超大输出只以 Evidence/Artifact/reference 展示。
      当前 consumer boundary 已覆盖 MCP `arguments`、`transportProvenance` 和 Artifact output reference，
      并有成功、失败、审批三种投影回归；JSON-RPC/header/stack/private thinking 的全事件矩阵仍待验证。
- [ ] projector fixture 覆盖正常、审批拒绝、Schema 非法、超大输出、timeout/rate limit、断线前后、重连、
      duplicate end、stale late result、cancel/retry/revision drift，并验证 live/replay 等价。
- [ ] PostgreSQL 集成验证 ToolCall ledger、RunEvent、Evidence/Artifact ref 同构恢复且重复/晚到不改已结算事实；
      Playwright 验证业务标签、详情披露、手动折叠、长名称/错误脱敏和桌面/移动端无溢出。

#### Skill

- [x] Composer 以名称/用途列表选择 Skill，已选项显示为可移除 chip；普通用户不需要输入版本或 hash。
- [x] 管理面展示来源、版本、诊断和禁用状态；损坏或冲突 Skill 不静默消失。
- [x] 消息/运行详情展示实际绑定的 Skill，而不是只显示用户发送前的临时选择。
- [ ] 明确展示“用户显式选择、模型自主选择、被策略禁用、加载失败、历史已过期”五种不同状态。
- [ ] PostgreSQL replay 和浏览器验证 worker 重启、恢复、分支切换后 revision/hash 不漂移，旧 instructions
      不重新进入新 turn。

#### Web Search / Research

- [x] 运行中展示查询阶段、已保留来源数和部分失败，不滚动输出完整网页正文。
- [x] 完成后优先展示 Research Artifact 摘要、confidence、conflicts/unknowns 和来源入口；Evidence chip 与
      来源抽屉承载 URL、标题、摘录和 provenance。
- [x] 无结果或部分失败仍使用同一 typed Artifact；不得用成功色或普通 completed 掩盖 degraded 状态。
- [ ] 补齐 search/fetch/synthesis 各阶段 timeout、rate limit、cancel、非法 Schema、全部失败和持久化失败投影。
- [ ] Playwright 验证 0/1/多来源、冲突来源、恶意页面、超长标题/URL、来源打开、错误脱敏和移动端溢出。

### 复用顺序与 Owner 门禁

- [ ] **先直接依赖**：官方 Pi、`assistant-ui`、官方 MCP SDK、`parse5`、`unpdf` 和既有 Workspace package；
      只有公共 API 无法覆盖明确契约时才进入下一层。
- [ ] **再扩展现有 Adapter/Port**：`PiRuntimeAdapter`、`PersistentToolBridge`、`McpClientGateway`、
      `ContextAssembler`、Research ports、RunEvent projector；不得从 UI 或 coordinator 绕过这些边界。
- [ ] **再独立适配上游行为与测试**：先复制行为 fixture/contract，再写最小实现；AGPL InkOS 只允许行为参考，
      未完成许可评估不得复制源码或测试文本。
- [ ] **最后才自研**：必须在 `docs/references/pi-ecosystem.md` 逐项记录候选库、固定版本、源码/测试路径、
      许可证和拒绝原因；“代码不多”“自己写更快”不是理由。
- [ ] 新增 owner 使用窄接口和 typed command/event/result；禁止创建 `AgentManager`、`ToolManager`、
      `SkillManager`、`ResearchManager`、`RunCoordinator` 一类同时拥有多种状态转换的总控模块。
- [ ] 新增 Agent-facing TypeScript/TSX 文件继续受 500 行硬门禁；拆分必须按领域职责，不能以
      `helpers.ts`、`utils.ts`、barrel 或回调链规避。

## 强制执行顺序

每个 TODO 行为单元都按以下顺序执行，任何一步没有证据时不得直接编码：

- [ ] 搜索 AgentPress 当前依赖、源码和测试，记录该能力属于“已有、可扩展、缺失、应拒绝”中的哪一类。
- [ ] 核对固定 commit 下的 InkOS 源码和对应行为测试，记录输入、状态转换、失败语义和可见结果，
      不只阅读 README、UI 或 Prompt。
- [ ] 检查官方 Pi、assistant-ui、MCP SDK、Oh My Pi、pi-mcp-adapter、pi-web-access 和
      `pi-skills` 是否已有许可证兼容的成熟实现。能直接依赖就直接依赖；不能直接依赖时优先扩展
      仓库现有 Adapter；只有两者都不成立时才允许独立实现。
- [ ] 在 `docs/references/pi-ecosystem.md` 写清采用或拒绝理由、不可变版本、上游源码/测试路径、
      本地接口和领域边界。不得以“更容易”或“自己写更快”作为自研理由。
- [ ] 先建立上游行为对应的契约测试，再实现最小适配；补充 AgentPress 领域边界测试、相反语义
      回归和 PostgreSQL replay/recovery 测试。
- [ ] 使用真实 Pi runtime 和目标模型验收语义行为，记录 provider、model、Prompt、Skill、Tool、
      Context、Runtime 和配置版本；faux runtime 只能证明确定性状态机，不能代替语义验收。
- [ ] 每个独立行为单元测试通过后单独提交，提交中不得混入无关重构或用户已有修改。

## 禁止 God Code

初始审计显示 `packages/agent-application/src/planned-run-executor.ts` 约 2200 行，
`packages/agent-application/src/direct-run-service.ts` 约 2080 行。两者均已完成第一轮拆分并降到
500 行以内；后续行为必须继续进入已建立的单一职责 owner，不能重新堆回 facade。

- [x] 在扩展 Planned Run 前，将计划持久化、Task 调度、Specialist 执行、结果合成、恢复和 transcript
      记录拆到独立应用服务；`PlannedRunExecutor` 只保留用例编排。
      `PlannedRunExecutor` 已降至 476 行；Main Control、DAG scheduler、plan revision、Task executor、
      plan/task store、Specialist result store、协议和结果策略分别拥有独立模块，所有新增模块均低于
      500 行。
- [x] 在扩展 Direct Run 前，将 turn profile、session lifecycle、directive、terminal outcome、proposal
      settlement 和 transcript 投影拆到独立应用服务；`DirectRunService` 只保留用例编排。
      `DirectRunService` 当前为 500 行；创建、分支、消息 codec、交互命令、恢复、结算和消费者投影
      分别由独立 service/adapter 拥有。`@agentpress/agent-application` lint、typecheck、94 个离线测试
      和 build 通过；Web projection 已拆为 246/320 行，91 个 Web 测试和 `pnpm check:file-lengths`
      通过。Agent Application 的 55 个 PostgreSQL 集成测试已通过。
- [x] 新增 Agent-facing TypeScript/TSX 文件控制在 500 行以内；目标是单一领域职责，而不是通过
      `utils.ts`、`helpers.ts` 或重新导出文件规避行数检查。
      Context 来源装载已从 `RunContextService` 拆到独立 `run-context-sources.ts`，主服务降至 481 行；
      `schema-compatibility.ts` 已拆为 258/357 行，`pi-runtime-adapter.ts` 已拆为 487/493 行，
      `worker-lifecycle.ts` 已降至 500 行，`tool-call-service.ts` 已拆为 327/446/56 行，
      `proposal-service.ts` 已拆为 260/488/43 行。仓库级文件长度门禁已覆盖 Agent-facing 源码。
- [ ] 一个模块只能拥有一种状态转换；跨模块协调通过显式 Port、Command、Event 或 typed result，
      禁止共享可变上下文对象和隐式回调链。
- [ ] Domain 不依赖 Pi、InkOS、HTTP、Kafka、React 或数据库类型；这些类型只存在于对应 Adapter。
- [ ] Web renderer 按 `plan/activity/approval/evidence/artifact/article-change/recovery/usage` 分 owner，
      不把所有 RunPart 分支重新集中到单个消息组件。
- [ ] 将 InkOS 的大文件组织只当反例：固定 commit 下 `agent-tools.ts` 约 2933 行、
      `pipeline/runner.ts` 约 3703 行、`studio/api/server.ts` 约 6539 行、`ToolExecutionSteps.tsx`
      约 942 行，chat action/stream-events 也同时拥有多种状态转换；不得复制这种 owner 划分。
- [x] 为文件长度、循环依赖、domain import boundary 和公共导出面增加 CI 检查；触碰已超限文件时必须
      先减少职责和净行数，不允许以“后续再拆分”放行。
      GitHub Actions 使用不可变 commit 固定官方 checkout/setup-node/pnpm actions，并只执行根
      `pnpm check`；该入口聚合 Agent/Web 文件长度、dependency-cruiser、publint、格式、lint、typecheck、
      离线测试和 build，避免 CI 与本地门禁漂移。Drizzle 生成快照由 `.prettierignore` 明确排除，源码与
      手写文档已通过全仓格式门禁。API Extractor report 仍作为公共 API 稳定化的后续增强。

架构门禁实施顺序（2026-08-07 更新）：

- [x] 按 protocol conversion、execution、settlement、lifecycle、provider compatibility 和 proposal
      workflow 等真实职责拆分核心 Agent owner：`pi-runtime-adapter.ts`、`tool-call-service.ts`、
      `worker-lifecycle.ts`、`schema-compatibility.ts`、`proposal-service.ts` 均已通过 500 行门禁；
      拆分没有创建笼统 `helpers.ts` 或第二套状态机。
- [x] 将现有 Web walker 提升为根级文件长度命令，为 Agent-facing TS/TSX 建立 500 行硬门禁；普通 Web
      源码的 1000 行规则独立保留。不得对白名单文件、文件名或目录名做例外来隐藏新增职责。
      根 `pnpm check` 同时运行 `check:agent-architecture` 与 Web `check:file-lengths`，两套阈值保持独立且
      没有超限白名单。
- [x] 固定并复用 `dependency-cruiser@18.1.1`（MIT）检查源码循环、Workspace deep import 和 Domain
      边界；不自行实现 import parser 或图算法。当前只读审计未发现 Workspace package 环、deep import，
      且 `@agentpress/domain` 无外部依赖；门禁已巡检 5750 个模块、762 条依赖且无违规。
- [x] 固定并复用 `publint@0.3.23`（MIT）验证 20 个 package 的 `exports/main/types/files` 和构建产物；
      若公共 API 需要防止意外增长，再使用 `@microsoft/api-extractor@7.58.12`（MIT）生成可审查的 API
      report，不用手写 barrel diff，也不用 Knip 代替 API 合同。当前全部 package 打包表面已通过
      `publint --strict`；API report 冻结仍随公共 API 稳定化继续实施。
- [x] 新增根 `check:architecture` 聚合上述门禁，并接入根 `pnpm check`；在 CI 中只保留这个统一入口，
      避免 Web 局部检查被误报为全仓通过。

建议本地所有权：

| 责任                            | 首选本地落点                                             | 不允许进入               |
| ------------------------------- | -------------------------------------------------------- | ------------------------ |
| Action Envelope / capability    | `packages/contracts/`、`packages/agent-application/`     | Prompt、React 组件       |
| Session / transcript projection | `packages/agent-application/`、`packages/database/`      | Pi session 文件          |
| Plan / Task / Specialist        | `packages/agent-application/`、`apps/agent-worker/`      | Web store、单体 executor |
| Review / recovery policy        | 独立 application policy/service                          | editor renderer、Prompt  |
| Context governance              | `packages/agent-context/`                                | Composer 临时状态        |
| Tool / MCP execution            | `packages/tool-runtime/`、`packages/mcp-runtime/`        | Specialist 自定义执行器  |
| Research                        | `packages/web-research/`                                 | 通用 Agent coordinator   |
| Skill                           | `packages/agent-context/`、`packages/agent-application/` | 可执行脚本目录           |
| Consumer projection             | `apps/web/src/lib/` 与小型 typed renderer                | PostgreSQL 写模型        |

## 当前未完成执行队列

以下顺序按事实源中的已知阻塞关系排列，不允许通过增加 Prompt、放宽 Schema、延长 timeout 或在 Web
层伪造终态跳过前置项：

- [x] **P0：固化 ResearchBrief 完成协议。** `packages/web-research` 导出唯一的 strict TypeBox
      `researchBriefContentSchema`；既有语义 validator 在结构校验后继续检查 Claim -> Source Evidence ID
      引用、冲突/部分失败时置信度降级等跨字段规则。`task_complete`、Task Brief、持久化
      `callerOutputSchema` 和执行时校验必须从同一 role-specific schema factory 取得 Researcher Schema，
      不在 Agent Application 复制第二份 ResearchBrief 定义。其他 Specialist 暂时保持既有 Artifact policy。
      role-specific `task_complete`、canonical normalization、宿主派生 Artifact Evidence 边和 PostgreSQL
      持久化均已通过，提交为 `b0a83d6`。
- [x] ResearchBrief 契约测试覆盖缺失 `schemaVersion`、任意嵌套对象、额外字段、空 Evidence ID、Claim
      引用未列 Source、重复 Source、冲突但满置信度，以及有效 canonical payload；真实评测中首次
      `task_complete` 应可通过宿主 Schema，不依赖 protocol-repair Prompt。目标模型在确定性 HTTP fixture
      下首次完成协议已通过；这不等于真实公网搜索通过。
- [x] **P0：固定 Provider Schema capability。** 不再仅从可自定义的 provider ID 名称猜测 OpenAI/
      Anthropic/Google 兼容族；backend 显式声明 wire schema capability。任何 strict normalization 必须有
      optional <-> required-nullable 的双向转换，并覆盖 unsupported keyword、嵌套对象、数组上限和
      `failure:null` round-trip；`strict=require` 在 provider 不能保证执行时请求前失败，`prefer` 保留
      wire codec 和宿主复验。52 个 Runtime 测试、真实 custom endpoint 调用与构建门禁通过，提交为
      `2114866`。
- [x] Researcher 输出体积预算必须从 `ResearchExecutionPolicy.maxSynthesisTokens` 进入真实 Pi
      `streamSimple(maxTokens)`；同时保证 Provider wire schema 与 canonical 本地 Schema 的差异可审计，
      不能因 wire 降级跳过 Evidence 引用、置信度或数组边界校验。真实目标模型报告已确认该预算进入
      Specialist runtime，canonical 宿主复验保持启用，提交为 `b0a83d6`。
- [x] **P0：接通研究执行预算。** `researchExecutionPolicy('deep')` 的 8 次 query 上限进入真实 Specialist
      Pi Runtime；连续 24 条 Evidence 载荷超时后，每次搜索上限收紧为 2 条（总量 <=16，canonical
      Schema 仍保留 <=24 的兼容上限）；并行批次中的超额
      调用被拒绝后仍允许同批 `task_complete` 结算。该行为由 Web Research、MCP、Pi Runtime 和 Agent
      Application 分层测试覆盖，提交为 `f7281ab`。
- [x] **P0：闭合研究 Evidence 事实链。** Researcher submission 不重复填写 Artifact 外层
      `evidenceIds`，宿主从 canonical `content.sources[].evidenceId` 确定性生成关联边；Claim 只能引用
      Source 子集，Source 集合与 Artifact Evidence 集合必须精确相等，之后再验证每个 UUID 属于当前
      Run/Task。`91f47a7` 已增加强类型 `source_tool_call_id`、ToolCall attempt 关联、幂等唯一键和
      inline/oversized ToolOutput 同构投影。`0afeed3` 将 Evidence projection 放入 ToolCall succeeded
      settlement 的同一 PostgreSQL 事务；故障注入时 projector 失败会使 ToolCall 保持 `executing`，不产生
      `tool.succeeded` 事件，也不写入 Evidence。ToolCall integration 17/17、Direct Run integration 41/41
      和该回滚断言已通过，故本项完成。
- [x] **P0：闭合研究来源 provenance。** Provider/adapter revision 必须由 Tool Definition 明确声明并
      快照到 ToolCall，不能由模型填写或把 `source_revision` 内容哈希冒充 Provider revision；oversized
      ToolOutput Artifact 路径已由 `91f47a7` 产生与 inline output 相同的 Evidence。`1318d00` 由内置
      `web.search` Tool Definition 不可变声明 revision，快照到 PostgreSQL ToolCall；Researcher wire
      submission 不再接收该字段，宿主只从当前 Task 的 Evidence -> succeeded ToolCall 事实链派生，并在
      revision 缺失、混用或运行时漂移时 fail closed。PostgreSQL 已核对 6 条 ToolCall/6 条闭合 Evidence。
- [ ] **P0：复跑最小在线闭环。** 只运行 `workflow-02`，要求 Researcher 在 120 秒内结算、ToolCall <= 8、
      Evidence <= 24、ResearchBrief 结构与引用合法、无证据 Claim 为 0，并从 PostgreSQL 核对 Root
      Request、Run、transcript、ToolCall、Task、Evidence、Artifact 和 terminal projection。
- [ ] **P1：复跑完整工作流矩阵。** `workflow-02` 通过后才运行 `workflow-01..05`；失败时先从
      PostgreSQL 事实链定位所属层，再决定是否实现，不把单场景模型行为写成通用 coordinator 分支。
- [ ] **P1：完成恢复与 MCP 失败矩阵。** 先接现有 recovery policy、validator、ToolCall ledger 和
      settlement，不建立第二套恢复或 MCP manager；所有新增 Agent-facing 源文件继续保持 <= 500 行。
- [ ] Skill replay/recovery 的实现已补充 PostgreSQL 集成回归：旧 Run 固定 `run_skill_bindings` 与
      Context Pack，新 Skill revision 发布后重启加载仍保持旧 hash/allowedTools。该回归已使用仓库
      PostgreSQL（`DATABASE_URL=postgresql://agentpress:agentpress@localhost:5432/agentpress`）通过；
      完整的 worker recovery、branch switch、旧 instructions 不进入新 turn 仍待补齐，因此总项不勾选。
- [ ] **P2：浏览器结果投影验收。** 真实 PostgreSQL replay 与 live SSE 使用同一 projector；Playwright
      验证桌面/移动端的结果优先展示、折叠、错误脱敏、恢复和无重叠，不在 React 中推断运行状态。

## P0：结构化意图与工具授权

InkOS 证据起点：

- `packages/core/src/interaction/action-envelope.ts`
- `packages/core/src/agent/agent-session.ts`
- `packages/core/src/__tests__/interaction-models.test.ts`
- `packages/core/src/__tests__/agent-session.test.ts`
- `packages/core/src/__tests__/instruction-adherence-boundary.test.ts`

TODO：

- [x] 对照现有 AgentPress Action Envelope 和 Turn Profile，列出相对 InkOS
      `actionSource/requestedIntent/actionPayload/requestedSkills` 的行为差距，不平行创建第二套协议。
      差距与拒绝项已记录在 `docs/references/pi-ecosystem.md`：AgentPress 只保留实际宿主表面需要的
      `free_text/button + article_edit`，Skill 走不可变 Run Skill Binding，拒绝 slash、quick-action 和
      fiction-specific intents，未创建第二套协议。
- [x] 将用户自然语言、宿主确认动作、历史上下文和系统产生的 wake/recovery 事件保持为不同 typed origin，
      不能在拼接 Prompt 后丢失来源。
      `RuntimeCurrentTurn.source` 区分 `user/application/recovery`，Action Envelope 独立区分
      `free_text/button`；queued Run 保持 user origin，持久 Run 恢复使用 recovery origin，内部 Main/Specialist
      轮次使用 application origin。Context Pack 和 committed history 仍是独立 typed 字段/消息，不伪装为
      当前用户请求。Runtime converter、validator、Turn Profile 和 queued/recovery source tests 已覆盖。
- [x] 由宿主根据当前 turn capability 生成精确工具表；普通问候、解释、研究和确认后的文章修改必须拥有
      不同工具集合。
      `AgentTurnProfile + PlannedRunExecutor + PersistentToolBridge` 共同生成工具表：无文章会话只有控制工具，
      研究通过受限 Plan/Specialist capability 委派，文章自由文本只有宿主授权的提案工具；确认修改确定性
      映射为单个 Editor Task，只暴露 `article.read_current/article.propose_edits/task_complete`，没有 Main
      plan/research/Skill 选择工具。契约测试和 PostgreSQL confirmed-turn exact-table 集成测试覆盖该边界。
- [ ] 所有文章修改、发布、付费媒体和外部副作用都要求当前轮次匹配的结构化能力；模型文本、关键词、
      历史意图和 Skill 不得授予权限。
- [x] 参数 Schema 在宿主边界校验；未知 intent、额外字段、缺失对象、过期 action 和重复确认必须 fail closed。
      `ActionEnvelopeV1` 和 payload 使用 TypeBox strict object；契约测试覆盖未知 intent、顶层/payload
      额外字段和缺失对象。Action Proposal 过期在事务中持久化 `expired + action.expired` 后拒绝，重复确认
      不创建 Run 或事件；PostgreSQL 回归已覆盖。
- [x] 已确认动作使用 PostgreSQL Root Request、Action Proposal、capability 和 operation key 保证幂等，
      不依赖 Pi session 是否仍在内存中。
      confirmed Run 使用 `action:<proposalId>` 幂等键、branch-scoped advisory transaction lock 和
      `root_requests_branch_idempotency_unique`；Proposal 条件结算并追加一次 `action.confirmed`。并发三次确认、
      串行 replay、单 confirmed Run 和单事件均由 PostgreSQL 集成测试覆盖；ToolCall 副作用继续使用持久
      operation key/arguments hash，不依赖内存 Session。
- [x] 相反语义测试至少覆盖：写作后问候不会续写、仅讨论修改不会改文、明确继续写可以创建提案、
      旧确认不能授权新 turn、Skill 不能扩大工具权限、恢复不能重复副作用。
      `routing-06/07/08/09/10` 固定 greeting、显式继续、当前确认、只讨论和旧确认边界；Action capability
      测试证明 confirmed grant 不跨 turn，Tool Registry 测试证明 Skill 只能收窄交集，PostgreSQL ToolCall
      与 Kafka detached Task recovery 测试证明重放不重复成功副作用。Agent Evals 41 个测试、Agent
      Application 94 个离线测试通过；真实模型语义门禁仍由下一项单独约束。
- [ ] 真实模型同时验收 greeting-after-writing、proposal-only、confirmed-mutation 和 explicit-continuation。

## P0：持久会话恢复与 Transcript 修复

InkOS 证据起点：

- `packages/core/src/interaction/session-transcript-schema.ts`
- `packages/core/src/interaction/session-transcript.ts`
- `packages/core/src/interaction/session-transcript-restore.ts`
- `packages/core/src/__tests__/session-transcript.test.ts`
- `packages/core/src/__tests__/session-transcript-restore.test.ts`

TODO：

- [x] 建立 InkOS restore 行为与现有 PostgreSQL RunEvent/agent transcript projector 的逐项差距表。
      `docs/references/pi-ecosystem.md` 已记录 commit、源码/测试路径、六项行为映射、拒绝 JSONL/Pi 类型的
      适配边界和本地验证落点。
- [x] 只恢复已经提交的用户请求和完成到有效边界的 attempt；失败前未提交的临时消息不能成为新事实。
      PostgreSQL projector 仅接纳 `agent_sessions.status=completed`；interrupted/failed attempt 被排除，
      单元和真实数据库测试均覆盖 completed 与未提交消息的相反场景。
- [x] 在投影层修复 ToolCall/ToolResult 邻接、缺失结果和重复结果；无法确定的历史必须 fail closed，
      不能伪造成功 ToolResult。
      同 session 的显式 ToolCall/ToolResult 必须 ID、tool name 一致且各只有一条才折叠为历史状态；missing、
      orphan、duplicate 和 mismatch 全部省略。当前批准工具的 raw continuation 仍由 Runtime history validator
      fail closed。单元与 PostgreSQL 乱序插入回归均覆盖。
- [x] 历史失败请求、过期 action、旧 Skill 指令和私有 Specialist thinking 不得重新进入当前模型上下文。
      非 completed session 不投影；自然 assistant 历史移除 ToolCall/thinking/presentation；旧 `use_skill`
      只留下 expired 状态而不含指令。历史文本不携带当前 Action Envelope 或 capability。
- [x] Provider/model/Prompt/Tool/Skill/Context revision 变化时明确失效缓存，不能复用不兼容的内存 Agent。
      `AgentSessionRunner` 每个 attempt 创建新 Pi Runtime，不保留内存 Agent；Context Pack 固定 Prompt、Skill、
      Tool capability 和 Context revision。投影 cache key 包含 Run/Task 与事实行，跨 Run revision 不复用。
- [x] live SSE 与 replay 必须使用同一 projector，并证明刷新、断线恢复、worker 重启和分支切换后 UI 一致。
      Redis 只通知；API 先订阅缓冲再按 PostgreSQL sequence replay。Web 对 durable 事件只推进 cursor 并刷新
      `RunProjectionService`，不在浏览器重算 RunPart；live delta 是可丢弃瞬时层。API 顺序测试、terminal
      parity、thread snapshot 和 branch selection 测试覆盖重连、刷新与分支恢复。
- [x] PostgreSQL 集成测试覆盖部分写入、重复事件、乱序到达、旧 worker 晚到结果、恢复中再次取消。
      Database inbox/domain 同事务、durable event sequence、Task lease fencing/cancel tests，API replay buffer，
      Agent Application recovery/ToolCall tests 和 Kafka detached Task recovery/cancel-late-command tests 共同
      覆盖；本地真实 PostgreSQL 14 个 Database、53 个 Agent Application 与真实 Kafka 2 个 recovery
      integration tests 通过。

## P0：Multi-Agent 写作流水线

InkOS 证据起点：

- `packages/core/src/agent/agent-tools.ts` 中的 `sub_agent`
- `packages/core/src/pipeline/runner.ts`
- Architect、Writer、Auditor、Reviser、Exporter 对应 pipeline 与测试
- `packages/studio/src/components/chat/ToolExecutionSteps.tsx`
- `packages/studio/src/components/chat/__tests__/ToolExecutionSteps.test.ts`

优先复用：现有 AgentPress Execution Plan、Agent Task、Task Attempt、lease、Context Pack、
TaskResult、Kafka worker、Oh My Pi structured-subagent 行为和 stale-owner tests。不得重新创建另一套
`sub_agent` 状态机。

TODO：

- [x] 将 InkOS Architect/Writer/Auditor/Reviser/Exporter 映射为 AgentPress 有限 Specialist catalog，
      记录采用、合并或拒绝理由；不允许模型动态创建无 owner 的任意角色。
      完整映射表已写入 `docs/references/pi-ecosystem.md`：Architect 归 Main planner，Auditor 拆为
      fact_checker/editor，Exporter 归确定性 publication application，Writer/Reviser 最小映射，并保留
      AgentPress researcher/illustrator；角色均为宿主 enum。
- [x] 为每个 Specialist 定义 Task Brief、输入 Schema、输出 Schema、工具 allowlist、预算、超时、
      最大重试、可见 Artifact 和禁止能力。
      strict plan/task_complete Schema、角色 capability policy、120 秒 timeout、3 次默认 attempt 和持久 Task
      Brief 已存在；timeout 现在同时约束 Task lease 和真实 Pi Runtime `AbortSignal`，超时持久化为
      `task_timeout`，父级取消仍保持 `cancelled`。角色 Artifact policy 在 Evidence/TaskResult 持久化前拒绝
      越权 Artifact。
- [x] Specialist 只获得最小不可变 Context Pack，不继承完整 Conversation；私有 thinking 不投影给 Main
      或用户，只返回结构化 TaskResult、Evidence、Artifact、Usage 和错误。
      Specialist application turn 只包含 Task Brief 与 accepted upstream summaries，不复制 root request/context；
      私有 thinking 隔离由 PostgreSQL 集成测试覆盖，Main 只接收 closed TaskResult envelope。
- [x] Specialist 不直接结算文章正文、Skill、Memory 或外部系统；写作结果进入 Artifact/EditProposal，
      由 Main 和现有 editor proposal boundary 统一治理。
      角色 capability 与 Artifact policy 不含 canonical settlement；Editor 只能产生 EditProposal，Writer 只能
      产生 Outline/ArticleDraft，外部副作用继续走 ToolCall/Approval ledger 与领域 application。
- [x] 写作、审阅和修订使用持久化 DAG，限制深度、宽度、并发和总预算；递归委派默认拒绝。
      `validateSubmittedPlan`/`plan_revise` 共享宿主策略：12 Task、6 层、4 并行宽度和 96,000
      估算 Token 上限；现有 acyclic、Specialist depth/owner、attempt/lease 约束继续生效。
- [x] 每个 Task Attempt 使用 lease/fencing token；旧 worker、过期 attempt 和取消后的结果不能覆盖新结果。
      `claim/settleAgentTaskAttempt` 绑定 attempt 与 lease token，取消释放 lease，过期重排同事务写 Event/Outbox；
      stale-owner、late result、cancel race 的数据库/Kafka 测试已存在。
- [x] Task 等待、取消、恢复和 synthesis 复用现有 PostgreSQL/Kafka 服务，不在 coordinator 中实现轮询器。
      `AgentTaskWaitService`、Task lease store、Outbox/Kafka handler、DAG scheduler 和 Main synthesis 各自拥有
      单一职责；PlannedRunExecutor 只编排，不持有第二套轮询状态。
- [x] UI 默认展示目标相关的顶层步骤、当前角色、耗时和结果摘要；依赖、重试和技术日志折叠，
      不展示 Specialist 列表作为产品主导航。
      RunPart server projector 折叠 Task lifecycle 并计算 duration，Web typed renderer 展示 plan/activity；
      Specialist registry 只作为运行详情事实，不是工作区导航。现有 projection/renderer 测试覆盖。
- [x] 合约测试覆盖 Schema precedence、工具越权、递归拒绝、预算耗尽、部分成功、并行结算、late result、
      cancel/recover race 和 private-thinking isolation。
- [ ] 补齐 Specialist runtime timeout、模型/输出 Schema 失败、非法 TaskResult/Evidence、synthesis 失败、
      Kafka 重复/乱序、并发分支同时耗尽预算、上游 degraded/failed 与 Main 部分成功终态的故障矩阵。
- [ ] 明确并测试 Main planner、DAG scheduler、Task executor、lease store、Specialist runtime、result/evidence
      store、synthesis 和 projection 的 Port/Event 边界；禁止共享可变 plan context 或把状态机塞回 facade。
- [ ] 在 `docs/references/pi-ecosystem.md` 固定 Oh My Pi structured-subagent 的版本、commit、许可证、源码与
      测试路径，只复用已验证行为，不复制成 AgentPress 的第二套 Task 状态机。
- [ ] 真实模型验收至少覆盖“研究 -> 写作 -> 审阅 -> 修订 -> 提案”和“审阅认为无需修改”两个相反场景。
- [ ] 在线矩阵还需覆盖部分成功、Specialist timeout、冲突 Evidence、取消/恢复和预算耗尽；量化门槛为
      DAG/Task/Tool 不超宿主上限、重复副作用=0、非法 capability=0、private thinking 泄漏=0、Proposal
      越权=0，并保存 PostgreSQL 完整事件链与浏览器投影证据。

## P0：审阅、修订与最佳版本选择

InkOS 证据起点：

- `packages/core/src/pipeline/chapter-review-cycle.ts`
- `packages/core/src/__tests__/chapter-review-cycle.test.ts`

TODO：

- [x] 先审计 AgentPress Article Proposal、Batch、Artifact Version 和 Evidence policy，禁止创建平行的
      chapter truth 或文件 snapshot 体系。
- [x] 将 InkOS fiction-specific 检查替换为文章领域的确定性检查：引用完整性、事实声明、链接安全、
      结构、字数/格式和 stale revision。
- [x] 每一轮都先运行确定性检查，再运行可选模型审阅；模型输出 Schema 解析失败时 fail closed。
- [x] 限制最大修订轮次、模型调用、Token 和费用；达到上限后返回显式 degraded result，而非无限自我修订。
- [x] 每轮保存不可变候选 Artifact Version、review score、问题列表、来源和选择理由。
- [x] 最终选择“最佳有效快照”，而不是盲目采用最后一次输出；新版本得分下降或事实校验失败时保留旧版本。
- [x] “无需修改”是合法终态，不得为了展示 Agent 工作而强制产生 diff。
- [x] 审阅结论只创建修改提案，不自动覆盖 canonical article revision。
- [x] 测试覆盖零问题、持续改进、后轮退化、解析失败、确定性检查失败、预算耗尽、stale article、
      Evidence 丢失和用户拒绝提案。

## P0：状态恢复与降级输出

InkOS 证据起点：

- `packages/core/src/pipeline/chapter-state-recovery.ts`
- `packages/core/src/__tests__/chapter-state-recovery.test.ts`

TODO：

现状审计：AgentPress 已有 PostgreSQL Checkpoint、Run/Task lease fencing、ToolCall operation key、
`decideToolReplay`、`outcome_unknown` 和 `completed_with_degradation`，因此不得创建第二套 Recovery
状态机。InkOS 可复用的真实缺口是“仅重试 settlement、冻结已验证事实、恢复候选重新校验、结构化列出
降级保留/缺失项”。实现应落在独立 application policy/service；`RunRecoveryService` 只保留 Run/Tool
恢复编排，Article/Evidence/Artifact 校验继续调用各自现有 owner。

应用契约进度：`recovery-policy.ts` 已限制 settlement 最多重试一次，只允许显式 replay-safe 操作，
重试后重新执行 validator；失败结果携带 preserved/missing/unverified/nextActions，已验证事实不会被
重试结果覆盖。提交后断线可由 typed `SettlementOutcomeUnknownError` 保持为独立
`outcome_unknown`，不降格为普通失败或 degraded。5 个纯策略测试已通过；接入 PostgreSQL store、
Article/Evidence/Artifact validator 和故障注入矩阵前，本节其余集成项仍保持未完成。

MCP 调用中断的确定性边界已由 `f333750` 接通：调用发出后连接丢失不会在新连接自动重放，退役 client
的晚到结果由 identity fence 拒绝，只有调用前连接 probe 可安全重连；真实 Streamable HTTP 重启测试
证明中断逻辑调用执行 0 次，下一次新逻辑调用执行 1 次。其余凭据、握手、Schema、timeout/cancel、
重复结果、恶意输出、审批拒绝和审计投影矩阵仍未完成。

运行时故障注入进度：inline 与 detached Specialist 的 timeout 已接入实际 Pi Runtime
`AbortSignal.timeout`，并与父级取消通过 `AbortSignal.any` 组合；超时结果是 failed `task_timeout`，不会把
用户取消误报为超时。真实 PostgreSQL 用例证明悬挂 Specialist 会在 deadline 后终止，Run 进入
`completed_with_degradation`，并且非法 timeout 配置 fail closed。该用例只证明 Specialist deadline 的
确定性状态转换，不替代真实 provider timeout；provider timeout、worker crash、提交前后断线、重复恢复、
部分 Artifact、失效 Evidence、stale worker 和恢复期间取消尚未形成完整矩阵，因此总项不勾选。
已有 PostgreSQL 回归证明重复 `prepareRecovery` 在 `recovering` 状态下不追加 RunEvent/Checkpoint，且不重复
增加 Tool Choice recovery count；该幂等边界已覆盖，但不能替代完整恢复矩阵。

- [ ] 将 InkOS chapter state 映射为 AgentPress Article Revision、Context Pack、Evidence、Artifact Version、
      TaskResult、Checkpoint 和 settlement，不引入本地 truth file 事实源。
- [ ] settlement 重试与生成重试分离；只有确定 replay-safe 的结算步骤才允许自动重试。
- [ ] 恢复时冻结此前已经验证的事实和 Artifact，只重新计算损坏或未结算部分。
- [ ] 恢复后的候选结果重新执行 Schema、权限、Evidence 和 stale revision 校验，不能因“来自恢复”而跳过。
- [ ] 无法完整恢复时返回 typed `completed_with_degradation`，列出保留内容、缺失内容、未核验项和下一步。
- [x] `outcome_unknown` 不得转成普通失败或自动重试；必须保持独立状态并等待人工核对。
- [ ] 测试覆盖 provider timeout、worker crash、数据库提交前后断线、重复恢复、部分 Artifact、失效引用、
      stale worker 和恢复期间用户取消。

## P1：Context Governance

InkOS 证据起点：

- `packages/core/src/utils/context-assembly.ts`
- `packages/core/src/utils/governed-context.ts`
- `packages/core/src/utils/context-filter.ts`
- `packages/core/src/__tests__/context-filter.test.ts`

优先复用现有 `packages/agent-context` 的 Context Pack、Context Manifest、compaction、Mention、Skill、
Evidence 和 token budget 实现。

TODO：

- [x] 建立 InkOS selection/filter/budget/validation 与 AgentPress Context Pack 的差距表，只补真实缺口。
- [x] 每个上下文项携带 typed origin、owner、revision/hash、trust、token cost、选择原因和截断状态。
- [x] 用户当前请求、宿主上下文、历史对话、Evidence、Attachment、Skill 和工具输出保持不同来源，
      禁止把注入上下文伪装成新的 user message。
- [x] Context Pack 在 Run/Task 开始时冻结；运行中的 Composer 改动不能回写历史 Context。
- [x] 预算策略必须确定性排序并记录被丢弃项；权限和 trust 校验先于 token 裁剪。
- [x] 外部网页、附件、Skill、MCP 和 Tool Result 均为 untrusted，不能覆盖 system policy 或 capability。
- [x] 测试覆盖超预算、同名冲突、陈旧 revision、跨 workspace 引用、恶意指令、空上下文和恢复 replay。

## P1：Skill 发现、选择与资源加载

InkOS 证据起点：

- `packages/core/src/skills/types.ts`
- `packages/core/src/skills/registry.ts`
- `packages/core/src/skills/external-loader.ts`
- `packages/core/src/agent/skill-tool.ts`
- `packages/core/src/__tests__/external-skill-loader.test.ts`
- `packages/core/src/__tests__/skill-registry.test.ts`
- `packages/core/src/__tests__/skill-agent-tool.test.ts`
- `packages/studio/src/pages/skill-ui-state.ts`
- `packages/studio/src/__tests__/skills-endpoint.test.ts`

优先复用现有 AgentPress Skill Revision、Run Skill Binding、`validateSkillConformance`、
`discoverSkillsWithWarnings`、PiSkillPreselector 和 `badlogic/pi-skills` 格式证据。

TODO：

- [x] 对照 InkOS registry/loader/use_skill 行为审计当前实现；已有 conformance、冲突诊断、hash 和
      resource safety 不得重写。
- [x] 保留“用户显式选择”和“模型从允许 catalog 选择”两条路径；显式禁用优先级最高。
- [x] Skill 只加载 Markdown 指令和声明的静态 regular-file resource；不执行脚本、不扫描系统目录、
      不隐式发现凭据。
- [x] 资源读取复用现有安全路径、symlink、类型、单文件/总量和 UTF-8 限制，不新增第二套文件读取工具。
- [x] Skill 只能缩小 Tool allowlist，不能授予平台、Workspace、Agent 或 Task 未拥有的 capability。
- [x] Run 固定 Skill revision/hash；历史 Skill instructions 在后续 turn 中过期，除非再次显式绑定。
- [x] Composer 只展示 Skill chip、名称和用途；版本、来源、hash、资源和诊断进入详情或管理页。
- [x] 测试覆盖 disabled、unknown、duplicate、同名优先级、malformed frontmatter、symlink、超大资源、
      prompt injection、历史过期和 Skill 越权。
- [x] 补齐 path traversal、非 UTF-8、单文件/总资源分别超限和发现后文件/hash 改变的资源边界测试；
      `013d7b8` 使用 fatal UTF-8 decode、独立预算和内容寻址 revision fail closed，`skill.ts` 保持 400 行。
- [ ] 补齐恢复时 revision 缺失、资源读取中断、模型选择 Schema 非法/timeout、显式选择与模型选择冲突
      的失败矩阵。
- [ ] 把 discovery、selection、binding、resource loading 和 tool narrowing 固定为独立 owner；明确
      `badlogic/pi-skills` 是格式/行为证据还是直接依赖，禁止汇总进单一 Skill manager。
- [ ] PostgreSQL replay 验证 Run Skill Binding revision/hash 在 worker 重启、恢复和分支切换后不漂移，
      旧 Skill 指令不进入新 turn；Playwright 验证显式禁用、缺失/失效 Skill 与诊断详情。当前已补充
      binding hash drift 的 fail-closed 回归（`PersistentToolBridge`），并用 PostgreSQL 证明旧 Run 在新
      revision 发布后保持 v1、sibling branch 可显式绑定 v2、未再次选择 Skill 的新 turn 不注入 v1/v2
      instructions。完整 worker recovery 和 Playwright 状态矩阵仍待完成。
- [x] 使用 `pnpm eval:skill` 的固定数据集验证准确选择、选择 none、禁用项和恶意 description。
      2026-08-07 使用真实 Pi Runtime 与目标模型 `gpt-5.6-terra` 运行 5 个固定用例：5/5 exact match、
      0 forbidden selection、0 error。版本化报告为
      `.agentpress/evals/2026-08-06T21-25-03-167Z-gpt-5.6-terra-skill-selection.json`。
- [ ] 将 Skill 在线门槛固定为 exact match、none precision、forbidden selection=0、恶意 description
      bypass=0、Schema/error rate；扩大数据集前不得用当前 5/5 替代这些独立指标。

## P1：Web Research 与 Evidence

InkOS 证据起点：

- `packages/core/src/utils/web-search.ts`
- `packages/core/src/agents/researcher.ts`
- `packages/core/src/agent/agent-tools.ts` 中的 `research_web`
- `packages/core/src/__tests__/researcher.test.ts`

InkOS 使用 Tavily、简单 HTML 清洗和本地 Markdown 报告。AgentPress 不复制这些基础设施；优先复用
现有 `packages/web-research`、SSRF guard、内置 `web_research` MCP、Evidence/Artifact persistence 和
Tool output guard。正文抽取继续直接依赖 `parse5@7.3.0`，PDF 抽取继续直接依赖 `unpdf@1.8.0`；
provider 搜索复用 `nicobailon/pi-web-access@v0.15.0` 的 MIT 行为适配，不重新实现 HTML parser、PDF
parser 或搜索 provider client。

TODO：

- [x] 将 InkOS `purpose`（worldbuilding/era/profession/market/fact-check/general）和
      `depth`（quick/standard/deep）评估为 AgentPress Research Brief 的产品级枚举，避免只暴露裸 query。
- [x] 研究输出定义为 typed Research Artifact：summary、claims、conflicts、unknowns、implications、
      sources、confidence、query log、partial failures 和版本信息。
- [x] Claim 必须引用 Evidence ID；source count 不能自动等价为事实可信，单来源和抓取失败必须降级。
- [x] 搜索、URL 获取、正文抽取和报告合成使用独立 Port，不把 provider-specific Tavily 字段泄漏进领域层。
- [x] URL 获取继续复用 DNS/redirect SSRF guard、HTTPS allowlist、媒体类型、大小、超时和 secret redaction；
      不采用 InkOS 的正则 HTML 去标签作为生产抽取器。
- [x] 查询扩展、去重、抓取并发、来源上限和预算由 Research policy 拥有，不写进通用 Agent executor。
- [x] 外部内容始终为 untrusted；网页中的指令不能调用工具、改变 Skill、提升权限或直接写文章。
- [x] Research Artifact 可打开和继续引用；消息流默认显示“查询数、保留来源数、部分失败、置信度”，
      Evidence chip/来源抽屉承载来源，不默认展开原始页面正文。
- [x] 测试覆盖无凭据、零结果、重复 URL、redirect-to-private、超大响应、非文本、部分 fetch 失败、
      互相冲突来源、恶意网页指令和全部失败的 degraded report。
      provider-neutral failure policy 与现有 SSRF/fetch 测试合计 22 个测试通过；失败产物继续使用
      ResearchBrief Schema，恶意网页指令只进入 ignored/partialFailures，不生成 Claim。
- [ ] 补齐 search timeout/rate limit/部分 query 失败/provider Schema 非法、fetch timeout/cancel、DNS
      失败、redirect loop、非法 URL、空正文、PDF 签名或页数失败、synthesis timeout/Schema 失败、
      Token/费用耗尽以及 Evidence/Artifact 持久化失败的执行链矩阵。
- [ ] partial query/fetch failure 必须保留已成功来源；全部 search/fetch/synthesis 失败只允许产出无 Claim、
      `confidence=0` 的 typed degraded Artifact；持久化失败不能投影为成功 Artifact。
- [ ] 恶意网页指令不仅不能生成 Claim，还必须证明不会产生 ToolCall、Skill Binding 或 Article Proposal。
- [ ] 真实目标模型验收来源引用准确率、未知项保留、冲突表达和“无可靠来源时拒绝硬结论”。
- [ ] 在线验收预先固定 citation precision、无证据 Claim 数、unknown retention、conflict recall 和拒绝
      硬结论通过率，并在报告记录 provider/model/Prompt/Tool/Skill/Context/Runtime revision。

## P1：MCP 边界

InkOS `v1.7.2` 没有 MCP 子系统，因此不得把 MCP 实现归因于 InkOS，也不得为了“对齐 InkOS”新造
MCP manager。

- [x] 继续直接使用官方 MCP TypeScript SDK，并复用现有 `packages/mcp-runtime`、Oh My Pi reconnect
      行为和 `pi-mcp-adapter` output guard；真实缺口先进入 `docs/oh-my-pi-reuse-todo.md`。
- [x] 首版仍只注册 `web_research`、`workspace_knowledge`、`licensed_media` 三个宿主内置 Server。
- [x] MCP Tool 必须通过同一 PersistentToolBridge、ToolCallService、capability、approval 和 settlement；
      不为 Multi-Agent 或 Skill 创建旁路。
- [x] UI 显示用户目标和结果摘要，不默认显示 JSON-RPC、Server transport 和原始 JSON；技术详情可审计。
- [ ] 在 `docs/references/pi-ecosystem.md` 逐项固定官方 MCP SDK client/session/transport、Oh My Pi
      reconnect、`pi-mcp-adapter` Schema/output guard 以及本地 Tool Registry、PersistentToolBridge、
      ToolCall ledger、Approval、Settlement 和 Run projection 的版本、许可证、源码/测试路径与 owner。
- [ ] 明确 Adapter 边界：Server capability/tool-list revision 在 Run 冻结；MCP Schema -> 宿主 Tool Schema
      转换由 Adapter 拥有；stdio/HTTP transport 和 JSON-RPC error 不进入 Domain 公共契约；远端 Server、
      Skill 或网页内容永远不能授予 capability。
- [ ] 建立无凭据/过期凭据、初始化/握手失败、Server 不可达、tool list/Schema 非法、工具消失或 revision
      变化、timeout/cancel、断线重连、调用中断线、重复 result、超大/恶意 output、JSON-RPC error、
      Approval 拒绝、settlement `outcome_unknown` 和旧连接晚到结果的专项失败矩阵。当前 `McpClientGateway`
      已在 capability 入口拒绝空/重复 tool name 与非 object input Schema，32 个 MCP Runtime 测试通过；
      其余故障场景未完成，因此总项不勾选。
- [ ] MCP 验收必须包含官方 SDK contract test、真实 MCP Server、PostgreSQL ToolCall/Approval/Settlement
      replay、重连后重复副作用=0、错误脱敏、桌面/移动 projection，以及真实 Pi Runtime 对三个内置
      Server 的调用；`docs/oh-my-pi-reuse-todo.md` 只能承载细节，不能替代本清单的完成门禁。

## P1：结果优先的消费者投影

InkOS 证据起点：

- `packages/studio/src/components/ai-elements/reasoning.tsx`
- `packages/studio/src/components/chat/ToolExecutionSteps.tsx`
- `packages/studio/src/components/chat/__tests__/ToolExecutionSteps.test.ts`

现有完成项继续以 `docs/inkos-web-agent-alignment.md` 为事实，不重复实现。

- [x] 每次新增 domain part 前先扩展稳定 RunEvent -> RunPart projector，再添加 renderer；Web 不从文案、
      timer 或 tool 名推断领域状态。
- [x] Product outcome（Research Artifact、Article Proposal、可打开结果）显示在 pipeline/log 前面。
- [x] active pipeline 自动展开，完成后折叠；摘要、耗时和终态保持可见。用户手动展开状态不能被 timer 抢夺。
- [x] 连续低价值工具操作按语义分组；审批、Ask User、Evidence、Article Change、Artifact、Warning 和
      Recovery 不能被吞进普通工具组。
- [x] 原始结果和日志默认折叠并脱敏；错误显示可操作的公共信息，stack、credential 和私有 thinking 不投影。
- [x] 复用 assistant-ui、Streamdown、Lucide 和现有 typed renderer，不复制 InkOS React 组件。
- [x] Playwright 覆盖 streaming、自动折叠、用户手动展开、长结果、部分失败、恢复 replay、桌面/移动端
      溢出和无重叠；截图之外还要断言真实交互和投影事实。

以上完成证据集中记录在 `docs/inkos-web-agent-alignment.md`：RunEvent projector、typed renderer、
timeline/outcome 顺序、折叠控制、错误脱敏和桌面/移动 Playwright 场景均已有测试与历史验收记录。

## P2：端到端写作产品行为

离线验收契约进度：`workflow-01..05` 已固定完整研究写作链、research-only、no-change review、
conflict degradation 和 recovery-pending-proposal 五个 schema version 4 场景；Eval scorer 新增禁止
Artifact 与精确终态断言，防止“只研究”偷偷产生 ArticleDraft/EditProposal，或把来源冲突的普通
completed 误判为降级。Agent Evals 42 个测试通过。

真实 Pi Runtime 与目标模型评测先后暴露并确认两层根因：Specialist timeout 没有进入 Runtime
`AbortSignal` 已由 `e6900d6` 修复；Researcher 无上限重复搜索已由 `f7281ab` 接通宿主预算。最新单场景
报告 `.agentpress/evals/2026-08-06T22-08-33-858Z-gpt-5.6-terra-workflow-02.json` 已把 ToolCall 从 12
降到 8、Evidence 从 96 降到 24，引用有效，但仍在 120 秒 deadline 失败。PostgreSQL Run
`cfa218aa-51a6-42af-9e07-be8dd48eb11e` 的 transcript 证明 Researcher 已调用 `task_complete`，宿主因
`ResearchBrief requires schemaVersion=1` 拒绝；当前暴露给模型的 `content` 只是通用
`Record<string, unknown>`。因此下一步是当前执行队列中的 role-specific constrained completion Schema，
不是增加 Prompt、放宽 validator 或延长 timeout。五个场景尚未全部复跑，完整 trace、质量指标和浏览器
验收仍保持未完成。

后三次真实复跑进一步收窄了剩余缺口：

- `.agentpress/evals/2026-08-06T22-22-37-027Z-gpt-5.6-terra-workflow-02.json`：8 次 ToolCall、24 条
  Evidence、引用有效；首次完成 payload 生成 4304 output tokens、耗时约 82 秒，遗漏
  `content.summary`，自动修复在 deadline 前被取消。
- `.agentpress/evals/2026-08-06T22-35-42-988Z-gpt-5.6-terra-workflow-02.json`：接入 6000 token
  synthesis 上限后首次 payload 降至 3652 output tokens、约 70 秒，但仍遗漏 required 字段且 Claim
  超出本地上限，23 秒修复窗口仍不足。
- `.agentpress/evals/2026-08-06T22-41-23-136Z-gpt-5.6-terra-workflow-02.json`：将自定义
  `agentpress-eval` 强制视为 OpenAI strict 的实验导致搜索参数上限从 wire schema 被移除、optional
  字段 required-nullable 与本地 validator 不对称，最终 0 Evidence；该实验已撤销，不能作为采用方案。

2026-08-07 的后续在线事实：

- `.agentpress/evals/2026-08-06T23-06-34-240Z-gpt-5.6-terra-workflow-02.json`：旧 MCP dist 仍产生
  22 条 Evidence；模型在 deadline 到达时才生成完成调用，因此 Task timeout。该报告同时证明在线门禁
  必须先 build 依赖包，不能把 typecheck 当运行产物。
- `.agentpress/evals/2026-08-06T23-10-01-359Z-gpt-5.6-terra-workflow-02.json`：新 MCP dist 将 Evidence
  降至 8；首次 `task_complete` 的 7 个 Source 与 6 个外层 Evidence ID 不一致，宿主闭包正确拒绝。
  Researcher submission 已移除重复外层字段，由宿主从 Source 目录生成关联边。
- `.agentpress/evals/2026-08-06T23-14-49-233Z-gpt-5.6-terra-workflow-02.json`：AnySearch 返回 402，
  0 Evidence；模型随后虚构非 UUID 引用。ResearchBrief Schema 已将 Evidence ID 固定为 UUID。Provider
  原始错误正文曾包含自动生成凭据，现已改为不保留响应正文；MCP `isError=true` 也改为失败结算，不能再
  作为 succeeded ToolCall 投影。该场景受外部搜索额度阻塞，不能标记为真实在线成功。
- `.agentpress/evals/2026-08-06T23-49-11-116Z-gpt-5.6-terra-workflow-02.json`：显式 Provider
  capability/codec 上线后，模型正常提交 4 个上限为 2 的 `web.search` ToolCall，但搜索端仍全部返回
  MCP error，最终 0 Evidence、0 Artifact、0 越权写入并在 134 秒后 `task_timeout`。PostgreSQL
  `9eeaf81d-6e2f-41cc-b1c2-2d93b8844dfe` 的 ToolCall/RunEvent 只保存脱敏错误
  `MCP tool search returned an error`，证明 Provider wire 根因已移除，但外部搜索额度仍阻塞在线闭环。
- `.agentpress/evals/2026-08-06T23-59-24-715Z-gpt-5.6-terra-workflow-02.json`：真实
  `gpt-5.6-terra` 目标模型配合进程内确定性 AnySearch HTTP fixture 完成协议验收；Run
  `6bb37e8b-2d75-4473-ab59-23d40468d04e` 含 4 个 succeeded ToolCall、8 条 Evidence、1 个
  ResearchBrief、0 个 Proposal/越权写入，Researcher 约 113 秒，Artifact Evidence 集合与两个 canonical
  Source 精确相等，Claim 只引用该 Source 子集。该报告证明真实模型的协议行为，不是公网搜索成功；fixture
  未写入生产代码且验收后已删除。

因此 Provider wire capability、双向适配、ResearchBrief canonical Schema、研究输出预算、来源
provenance 以及 ToolCall settlement -> Evidence projection 的事务闭包已完成；真实公网 `workflow-02`
仍未完成，在搜索服务额度恢复并从 PostgreSQL 验收前不得标记在线闭环通过。

- [ ] 固定“资料研究 -> 结构/提纲 -> 草稿 -> 事实/编辑审阅 -> 有界修订 -> Article Proposal ->
      用户接受/拒绝”的版本化业务场景，不能只测试每个工具孤立成功。
- [ ] 固定“用户只要研究，不要改文”“审阅认为无需修改”“来源冲突导致降级”“恢复后仍等待审批”
      等相反语义场景。
- [ ] 每个场景从 PostgreSQL 还原 Root Request、Run、transcript、ToolCall、Task、Artifact/Evidence、
      Proposal/Batch、settlement 和 Web projection 的完整事件链。
- [ ] 在线报告记录结果质量、引用准确率、Task/Tool 次数、恢复次数、延迟、Token、费用和重复副作用，
      并保留版本 manifest。
- [ ] 未完成真实 Pi/目标模型验收、浏览器验收和 PostgreSQL replay 前，不得把行为项标记为完成。

## 明确不采用

- [x] 不采用 InkOS file/JSONL session、book truth file 或本地目录作为 AgentPress 事实源。
- [x] 不采用 InkOS `@mariozechner/pi-agent-core@0.67.1` 和 `pi-ai@0.67.1` 集成。
- [x] 不采用关键词 matcher 作为意图、权限、写作继续或终态判断。
- [x] 不向普通聊天 turn 暴露完整文章修改、封面、导入、truth-file 和 `sub_agent` 工具表。
- [x] 不把注入的文章/书籍上下文伪装为新的用户消息。
- [x] 不复制 InkOS React 组件、默认展开的原始结果、TUI/desktop 偏好或正则 HTML 抽取。
- [x] 不允许 Specialist、Skill、MCP 或网页结果绕过 Tool Registry、审批、Proposal 和 settlement。
- [x] 不为了表面一致性创建第二套 Plan、Task、Artifact、Evidence、Skill、MCP 或 Transcript 模型。

这些排除项由当前依赖图、PostgreSQL schema、Action/Tool capability、Context Pack、MCP adapter、
`parse5` 抽取和 Web alignment 实现共同证明；详细采用/拒绝依据见
`docs/references/pi-ecosystem.md` 的 InkOS adoption map 与 deliberate exclusions。

## 完成定义

一个 TODO 只有同时满足以下条件才允许勾选：

- 已记录现有实现审计、上游固定源码/测试证据和复用决策。
- 实现位于明确 owner 后，没有扩大 god file、产生平行事实源或跨越领域依赖边界。
- 上游契约行为、AgentPress 领域边界、相反语义和安全失败测试全部通过。
- PostgreSQL replay 与 live projection 得到相同业务状态。
- 真实 Pi runtime/目标模型报告记录完整版本 manifest 并通过预定阈值。
- 用户可见行为通过 Playwright 桌面/移动端交互、溢出和无重叠检查。
- `pnpm lint`、`pnpm typecheck`、受影响测试、构建和文件长度/依赖边界检查通过。
- 独立 Git commit 使用 `<type>: <简短中文说明>`，没有混入无关修改。
