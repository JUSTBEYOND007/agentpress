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
      `DirectRunService` 已降至 497 行；创建、分支、消息 codec、交互命令、恢复、结算和消费者投影
      分别由独立 service/adapter 拥有。`@agentpress/agent-application` lint、typecheck、68 个离线测试
      和 build 通过；Web projection 已拆为 246/320 行，91 个 Web 测试和 `pnpm check:file-lengths`
      通过。需要 PostgreSQL 的 49 个集成测试仍必须在后续数据库门禁中运行。
- [ ] 新增 Agent-facing TypeScript/TSX 文件控制在 500 行以内；目标是单一领域职责，而不是通过
      `utils.ts`、`helpers.ts` 或重新导出文件规避行数检查。
      Context 来源装载已从 `RunContextService` 拆到独立 `run-context-sources.ts`，主服务降至 481 行；
      仓库级门禁仍需处理 `pi-runtime-adapter.ts`、`tool-call-service.ts`、`worker-lifecycle.ts` 和
      `schema-compatibility.ts` 等既有超限 owner，不能以白名单掩盖。
- [ ] 一个模块只能拥有一种状态转换；跨模块协调通过显式 Port、Command、Event 或 typed result，
      禁止共享可变上下文对象和隐式回调链。
- [ ] Domain 不依赖 Pi、InkOS、HTTP、Kafka、React 或数据库类型；这些类型只存在于对应 Adapter。
- [ ] Web renderer 按 `plan/activity/approval/evidence/artifact/article-change/recovery/usage` 分 owner，
      不把所有 RunPart 分支重新集中到单个消息组件。
- [ ] 为文件长度、循环依赖、domain import boundary 和公共导出面增加 CI 检查；触碰已超限文件时必须
      先减少职责和净行数，不允许以“后续再拆分”放行。

架构门禁实施顺序（2026-08-07 只读审计）：

- [ ] 先拆分核心 Agent 超限 owner：`pi-runtime-adapter.ts` 954 行、`tool-call-service.ts` 760 行、
      `worker-lifecycle.ts` 629 行、`schema-compatibility.ts` 605 行；文章变更链同时处理
      `proposal-service.ts` 791 行。按 protocol conversion、execution、settlement、lifecycle、provider
      compatibility 等真实职责拆分，不创建笼统 helpers。
- [ ] 将现有 Web walker 提升为根级文件长度命令，为 Agent-facing TS/TSX 建立 500 行硬门禁；普通 Web
      源码的 1000 行规则独立保留。不得对白名单文件、文件名或目录名做例外来隐藏新增职责。
- [ ] 固定并复用 `dependency-cruiser@18.1.1`（MIT）检查源码循环、Workspace deep import 和 Domain
      边界；不自行实现 import parser 或图算法。当前只读审计未发现 Workspace package 环、deep import，
      且 `@agentpress/domain` 无外部依赖，但尚无自动守护。
- [ ] 固定并复用 `publint@0.3.23`（MIT）验证 20 个 package 的 `exports/main/types/files` 和构建产物；
      若公共 API 需要防止意外增长，再使用 `@microsoft/api-extractor@7.58.12`（MIT）生成可审查的 API
      report，不用手写 barrel diff，也不用 Knip 代替 API 合同。
- [ ] 新增根 `check:architecture` 聚合上述门禁，并接入根 `pnpm check`；在 CI 中只保留这个统一入口，
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
- [ ] 相反语义测试至少覆盖：写作后问候不会续写、仅讨论修改不会改文、明确继续写可以创建提案、
      旧确认不能授权新 turn、Skill 不能扩大工具权限、恢复不能重复副作用。
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
- [ ] PostgreSQL 集成测试覆盖部分写入、重复事件、乱序到达、旧 worker 晚到结果、恢复中再次取消。

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
      Brief 已存在；本轮新增角色 Artifact policy，越权 Artifact 在 Evidence/TaskResult 持久化前拒绝。
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
- [ ] 真实模型验收至少覆盖“研究 -> 写作 -> 审阅 -> 修订 -> 提案”和“审阅认为无需修改”两个相反场景。

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

- [ ] 将 InkOS chapter state 映射为 AgentPress Article Revision、Context Pack、Evidence、Artifact Version、
      TaskResult、Checkpoint 和 settlement，不引入本地 truth file 事实源。
- [ ] settlement 重试与生成重试分离；只有确定 replay-safe 的结算步骤才允许自动重试。
- [ ] 恢复时冻结此前已经验证的事实和 Artifact，只重新计算损坏或未结算部分。
- [ ] 恢复后的候选结果重新执行 Schema、权限、Evidence 和 stale revision 校验，不能因“来自恢复”而跳过。
- [ ] 无法完整恢复时返回 typed `completed_with_degradation`，列出保留内容、缺失内容、未核验项和下一步。
- [ ] `outcome_unknown` 不得转成普通失败或自动重试；必须保持独立状态并等待人工核对。
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
- [ ] 使用 `pnpm eval:skill` 的固定数据集验证准确选择、选择 none、禁用项和恶意 description。

## P1：Web Research 与 Evidence

InkOS 证据起点：

- `packages/core/src/utils/web-search.ts`
- `packages/core/src/agents/researcher.ts`
- `packages/core/src/agent/agent-tools.ts` 中的 `research_web`
- `packages/core/src/__tests__/researcher.test.ts`

InkOS 使用 Tavily、简单 HTML 清洗和本地 Markdown 报告。AgentPress 不复制这些基础设施；优先复用
现有 `packages/web-research`、SSRF guard、内置 `web_research` MCP、Evidence/Artifact persistence 和
Tool output guard。

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
- [ ] 测试覆盖无凭据、零结果、重复 URL、redirect-to-private、超大响应、非文本、部分 fetch 失败、
      互相冲突来源、恶意网页指令和全部失败的 degraded report。
- [ ] 真实目标模型验收来源引用准确率、未知项保留、冲突表达和“无可靠来源时拒绝硬结论”。

## P1：MCP 边界

InkOS `v1.7.2` 没有 MCP 子系统，因此不得把 MCP 实现归因于 InkOS，也不得为了“对齐 InkOS”新造
MCP manager。

- [x] 继续直接使用官方 MCP TypeScript SDK，并复用现有 `packages/mcp-runtime`、Oh My Pi reconnect
      行为和 `pi-mcp-adapter` output guard；真实缺口先进入 `docs/oh-my-pi-reuse-todo.md`。
- [x] 首版仍只注册 `web_research`、`workspace_knowledge`、`licensed_media` 三个宿主内置 Server。
- [x] MCP Tool 必须通过同一 PersistentToolBridge、ToolCallService、capability、approval 和 settlement；
      不为 Multi-Agent 或 Skill 创建旁路。
- [x] UI 显示用户目标和结果摘要，不默认显示 JSON-RPC、Server transport 和原始 JSON；技术详情可审计。

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
