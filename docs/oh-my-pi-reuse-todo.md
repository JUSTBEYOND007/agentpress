# Oh My Pi Reuse TODO

本文把 Oh My Pi 中适合 AgentPress 的能力拆成可执行 TODO。目标不是移植一个 Coding Agent，
而是在保持 AgentPress 领域模型、PostgreSQL 事实源、安全边界和官方 Pi Runtime 的前提下，
最大限度复用已经被实现和测试的成熟行为。

## 固定上游与许可

- 上游：[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi)
- 版本：`v17.1.8`
- Commit：`f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
- License：MIT
- 审查日期：2026-08-04
- AgentPress Runtime：继续使用 `@earendil-works/pi-agent-core@0.82.1` 和
  `@earendil-works/pi-ai@0.82.1`

## 强制复用顺序

- [x] 每个实现项先检查 AgentPress 当前依赖和仓库实现，记录“已有 / 可扩展 / 缺失”。
- [x] 检查上游模块能否作为独立依赖直接使用；只有依赖 Oh My Pi 自有 Runtime、Bun/native、
      本地文件或 Coding Agent 类型时，才进入复制适配。
- [x] 无法直接依赖时，先复制对应行为测试和 fixture，再复制最小实现；不得只仿照 API 或 Prompt。
- [x] 复制实现必须放在 AgentPress 自有 Port/Adapter 后，不能让 `@oh-my-pi/*` 类型跨入领域层。
- [x] 复制前固定上游 commit，保留版权和许可证头，并在 `THIRD_PARTY_NOTICES.md` 记录上游路径、
      本地路径、修改内容和验证结果。
- [x] 只有直接依赖和复制适配都不成立时才允许自研；自研前记录候选模块及逐项拒绝理由。
      `docs/references/pi-ecosystem.md` 的 Dependency Versus Adaptation Decisions 记录了官方 Pi、Oh My Pi、MCP、Web Access、Skill、AGPL 与候选参考的直接依赖/复制/拒绝边界；当前没有未记录的自研替代项。
- [ ] 每次只引入一个行为单元，完成契约测试、领域边界测试、相反语义回归和真实 Pi/目标模型验收后提交。
      独立提交和离线测试纪律已经执行；真实目标模型验收仍受本清单各 online gate 约束，不能提前勾选。
- [x] 不直接依赖 `@oh-my-pi/pi-agent-core`、`@oh-my-pi/pi-ai`、`snapcompact` 或 `mnemopi`；后两者
      仍传递依赖 Oh My Pi Runtime/native/Bun。优先复制最小纯逻辑及其测试，或移植行为到现有依赖。

## 明确排除

- [x] 不引入第二套 Pi Agent Core、消息类型、Provider Catalog 或事件状态机。
- [x] 不采用 Oh My Pi JSONL、本地 SQLite、Redis Session 或 SQL Session 表作为 AgentPress 事实源。
- [x] 不复制 TUI、命令面板、终端控制、Git/Worktree、代码文件操作或本机凭据发现。
- [x] 不开放任意用户配置的 stdio/remote MCP Server；首版仍限三个内置 MCP Server。
- [x] 不让模型自动写入长期 Memory、Skill、文章正文或外部系统；必须经过 AgentPress proposal/approval/settlement。
- [x] 不复制关键词式 Memory 分类作为权威判断，不把 Prompt 当权限、终态、幂等或恢复状态机。
- [x] 不把 Oh My Pi 的 `eval` 代码执行工具误认为 Agent 评估平台。

      依赖图只包含固定 `@earendil-works/pi-*` Runtime；Conversation/Run/Task/Tool/Memory/Skill/Eval
      均投影自 PostgreSQL。MCP Registry 只有 `web_research`、`workspace_knowledge`、`licensed_media`
      三个宿主内置 server；长期写入统一经过 proposal/approval/settlement，评估平台独立位于
      `packages/agent-evals`，没有复用 Oh My Pi 的代码执行工具。

## P0：Session、Summary 与上下文压缩

上游源码：

- `packages/agent/src/compaction/`
- `packages/coding-agent/src/session/session-entries.ts`
- `packages/coding-agent/src/session/session-context.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`
- `packages/coding-agent/src/session/turn-recovery.ts`
- `packages/coding-agent/src/session/checkpoint-entries.ts`
- `packages/coding-agent/src/session/session-migrations.ts`

上游测试起点：

- `packages/agent/test/compaction-*.test.ts`
- `packages/agent/test/tool-protection.test.ts`
- `packages/agent/test/snapcompact-frames.test.ts`
- `packages/coding-agent/test/agent-session-compaction.test.ts`
- `packages/coding-agent/test/compaction-lifecycle.test.ts`
- `packages/coding-agent/test/compaction-serialization.test.ts`
- `packages/coding-agent/test/agent-session-branching.test.ts`
- `packages/coding-agent/test/agent-session-retry-recovery.test.ts`

TODO：

- [x] 在 PostgreSQL 中定义版本化 `ConversationCompaction`/Artifact 契约：`summary`、`shortSummary`、
      `firstKeptMessageId/Sequence`、`tokensBefore`、`preserveData`、模型/Prompt 版本和来源消息范围。
- [x] 将压缩记录作为 append-only 事实保存，不覆盖旧消息；上下文投影使用“有效 Summary + 最近原始消息”。
- [x] 复制并适配 Oh My Pi 的 `CompactionEntry`、branch summary、keep boundary 行为测试。
      Conversation 与当前 Agent Session 分别使用 append-only PostgreSQL compaction；branch fork
      重绑消息边界，session cut 只允许 user/application 或完整 ToolCall/ToolResult 批次，未配对协议 fail closed。
- [x] 实现 token budget 驱动的自动压缩、手动压缩和 mid-turn 压缩，保留明确的 reserve provenance。
      automatic settlement、手动 HTTP command 与官方 Pi `prepareNextTurnWithContext` mid-turn 均已接入；
      阈值直接复用官方 Pi `shouldCompact`，小窗口按可用预算封顶 retained tail，所有成功/失败尝试记录 reserve provenance。
- [x] 复制 tool protection 行为：未结算 Tool Call、审批、Evidence、Article Revision、EditProposal、
      Memory Candidate、Task Result 和成本事实不得被普通 Summary 消除或改写。
- [x] 复制增量 Summary 行为：新 Summary 必须在旧 Summary 基础上更新，并记录继承来源。
- [x] 为 Conversation Branch 独立生成 branch summary，不污染兄弟分支；fork 时将父分支有效 Summary
      重绑到复制后的 child message IDs/sequences，不引用父分支消息。
- [x] 将读取/修改过的文章、Evidence、Artifact、Skill 版本和 Tool Call 列表写入压缩 preserve data。
      `collectConversationCompactionPreserveData` 只保存 PostgreSQL 事实引用，并覆盖 Run、ToolCall、审批、Evidence、Artifact/Version、TaskResult、Proposal/Batch、Article Revision、Memory、Skill、Model 与成本关联。
- [x] 压缩失败、超时、空输出或 Schema 失败时保留原始 timeline，并产生结构化可恢复错误。
      失败尝试 append-only 保存，`getEffectiveConversationCompaction` 只投影最近成功版本；timeout、cancelled、schema/provider failure 均不制造 Summary。
- [x] 复制 context-window overflow、截断输出、remote compaction 失败和 fallback 的相反场景测试。
      覆盖 preflight overflow、provider 显式 overflow、只重试一次、压缩无缩减/失败时保留原错误，
      以及 length 截断 ToolCall 不执行。首版明确不采用 remote compaction；transport-neutral compactor
      failure 用例验证其失败不能覆盖 transcript 或触发无界 retry。
- [x] 建立 AgentPress Summary 测试集，至少覆盖事实保留、用户意图、未完成动作、引用、分支隔离和陈旧状态。
      `agentpress-compaction-v1` 在 `packages/agent-evals/src/compaction-scenarios.ts` 固定六类要求与
      四个场景；离线 scorer 和真实模型在线 CLI 共用同一数据集。契约测试同时拒绝遗漏受保护事实与
      `BRANCH-B-SECRET-922` 兄弟分支泄漏，避免只验证正向 golden summary。
- [x] 使用真实 Pi runtime/目标模型验证多轮压缩前后任务完成率和事实保留率，而非只断言 Prompt 文本。
      备用 OpenAI-compatible `gpt-5.6-luna` 完整运行 `agentpress-compaction-v1` 四案；报告
      `.agentpress/evals/2026-08-05T15-01-31-311Z-gpt-5.6-luna-compaction.json` 记录
      Prompt `agentpress.conversation-compaction@2`、`factRetention=1`、压缩前后 task parity 通过且
      `gatesPassed=true`。completion tool 现在确定性拒绝遗漏 host-owned protected reference 的摘要；
      评测器同时覆盖等价否定措辞与相反的 approved 状态，避免 Prompt 文本断言或单一正则误判。

首选本地落点：`packages/agent-context/`、`packages/agent-application/`、
`packages/database/`、`packages/agent-evals/`。

## P0：结构化输出与 Provider Schema 兼容

上游源码：

- `packages/ai/src/utils/schema/`
- `packages/coding-agent/src/tools/output-schema-validator.ts`
- `packages/coding-agent/src/task/structured-subagent.ts`

上游测试起点：

- `packages/ai/test/schema-*.test.ts`
- `packages/ai/test/openai-tool-strict-mode.test.ts`
- `packages/ai/test/google-tool-schema.test.ts`
- `packages/ai/test/anthropic-tool-schema.test.ts`
- `packages/coding-agent/test/tools/output-schema-validator.test.ts`
- `packages/coding-agent/test/structured-subagent-*.test.ts`

TODO：

- [x] 审计官方 `pi-ai@0.82.1` 已有 Schema 能力，列出相对 Oh My Pi 的真实缺口，避免复制已成熟实现。
- [x] 对缺失行为优先向官方 Pi 适配层补契约测试；只有官方 API 无法覆盖时才复制纯 Schema 逻辑。
      Provider 方言与严格输出缺口均在 `packages/agent-runtime/test/provider-schema-fixtures.test.ts`
      和 `schema-compatibility.test.ts` 先固定为适配层契约；未复制 Oh My Pi 完整 Schema subsystem。
- [x] 建立统一 Schema 管线：TypeBox（权威契约）-> JSON Schema -> dereference -> normalize -> provider adaptation
      -> wire schema -> result validation。
      Zod 仅保留在官方 MCP SDK 必须使用它的边界适配器中，不扩展为第二套领域契约。
- [x] 建立 OpenAI strict、Anthropic、Google、Ollama、MCP 等方言的兼容 fixture 和失败用例。
      `packages/agent-runtime/test/provider-schema-fixtures.test.ts` 基于固定 Oh My Pi
      `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` 与官方 Pi `b4f293684bba718d59cc1157679bcf6157b3a7f5`
      的行为测试起点，适配逻辑保留在 AgentPress provider boundary，不引入第二套领域 Schema。
- [x] 覆盖 `$ref`、`oneOf/anyOf`、nullable optional、`additionalProperties`、`const/enum`、tuple 和递归 Schema。
      证据：`packages/agent-runtime/test/schema-compatibility.test.ts`，覆盖 closed object、union、nullable、literal、tuple 和递归 `$defs`。
- [x] 定义 `strict` 与 `permissive` 两种结果策略；严格模式失败必须成为结构化失败，不得静默使用原文本。
      strict 返回带路径的失败；permissive 返回显式 `degraded` 和 failures，不做 coercion 或静默修复。`plan_submit`、`task_complete` 与 LLM Judge 已在宿主边界使用 strict 校验。
- [x] 给 Specialist `TaskResult`、Execution Plan、Tool 参数/结果、MCP 输出、Memory Candidate 和 LLM Judge
      输出统一接入该验证层。
      `packages/schema-runtime` 直接复用 `typebox@1.1.38` 的无 coercion 校验器，同时接受 Pi 当前
      TypeBox 与 AgentPress 领域 TypeBox Schema；Plan、TaskResult 和 Judge 通过 Agent Runtime
      re-export 接入，Tool/MCP 直接复用同一层。`memory.propose` 已用明确 Candidate 输出 Schema
      替代 `Type.Any()`；未知 format、无效 Tool/MCP/Memory 输出均 fail closed 并保留字段路径。
- [x] 记录每次 Schema 降级及原因，避免 provider fail-open 在观测层不可见。
- [ ] 真实目标模型验收 Schema 有效率、修复重试次数和 provider 间一致性。

首选本地落点：`packages/agent-runtime/`、`packages/contracts/`、`packages/tool-runtime/`。

## P0：ReAct、Function Calling 与工具协议

上游源码：

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/replay-policy.ts`
- `packages/ai/src/utils/tool-call-loop-guard.ts`
- `packages/coding-agent/src/session/tool-choice-queue.ts`
- `packages/coding-agent/src/session/turn-recovery.ts`
- `packages/coding-agent/src/session/turn-persistence.ts`
- `packages/coding-agent/src/session/stream-guards.ts`
- `packages/coding-agent/src/tools/output-meta.ts`

上游测试起点：

- `packages/agent/test/prompt-tools-loop.test.ts`
- `packages/agent/test/proxy-toolcall-partial-json.test.ts`
- `packages/ai/test/tool-call-loop-guard.test.ts`
- `packages/ai/test/tool-call-without-result.test.ts`
- `packages/ai/test/duplicate-tool-results.test.ts`
- `packages/coding-agent/test/agent-session-tool-call-loop-guard.test.ts`
- `packages/coding-agent/test/agent-session-event-order.test.ts`
- `packages/coding-agent/test/agent-session-retry-recovery.test.ts`

TODO：

- [x] 审计 `PiRuntimeAdapter` 已有 streaming、tool call、abort、continue 和 replay 行为并建立差距表。
      已覆盖 `packages/agent-runtime/test/pi-runtime-adapter.test.ts`；剩余差距是需要真实目标 provider
      wire/credential 的在线验收，不由 faux runtime 代替。
- [x] 复制 partial JSON Tool Call、无结果 Tool Call、重复 Tool Result 和并行 Tool Call 的协议测试。
      官方 Pi fixture 已覆盖持久化 Tool Result continuation，并新增两个 parallel ToolCall 恰好各执行一次；
      `packages/agent-runtime/test/pi-runtime-adapter.test.ts` 现用官方 `stopReason=length`
      行为验证 partial JSON 不执行并生成错误 ToolResult，同时对持久化 history 的 missing/mismatched/
      duplicate ToolResult fail closed；并行调用仍由 Pi runtime fixture 验证。
- [x] 实现确定性的 Tool Call Loop Guard，区分模型重试、协议失败和业务工具失败。
- [x] 为 Tool Choice Queue 建立持久化语义，避免 steering/follow-up 与强制工具选择互相覆盖。
      `run_tool_choices` 以 Run 内 FIFO sequence、单一 in-flight、claim token、恢复次数和终态记录
      队列事实；与 `run_directives` 共用 Run 行锁，使 pending steering 原子抑制下一次强制选择，
      follow-up 不抑制当前 Run。只有 Main Agent 可 claim，Pi adapter 只在首个 provider request 注入；
      结算按实际 ToolCall 校验 named/required/none，Run recovery 原子重排并使旧 token 失效，所有
      Run 终态取消残留项。真实 PostgreSQL 覆盖并发 enqueue、FIFO、单 claim、相反 directive
      语义、恢复重领、旧 worker 拒绝和取消；五 Specialist DAG 验证 Specialist 不消费 Main 选择。
- [x] 标记 replay-safe、idempotent、side-effecting 和 outcome-unknown 工具；恢复策略由标记决定。
- [x] Tool 输出超过预算时外置为 Artifact，只把受限摘要和引用放回模型上下文。
      内置 MCP 工具超过 256KB 时将脱敏完整值写入 PostgreSQL `ToolOutput` Artifact/ArtifactVersion，
      工具结果仅返回 artifact/version URI、字节数和最多 1000 字符摘要；无 writer 时继续 fail closed。
- [x] 复制 Provider 切换、aborted thinking、unexpected stop、empty stop 和工具后续轮的恢复测试。
      `packages/agent-runtime/test/pi-runtime-adapter.test.ts` 覆盖 provider metadata 切换、aborted
      thinking、empty stop，以及已持久化 ToolResult 后 continuation；真实目标 provider 的 wire 验收仍单独保留。
- [x] 每个工具执行继续通过 AgentPress `ToolCallService`、权限、审批和 settlement，不让 Pi 状态直接结算业务。
      `PersistentToolBridge` 只向 Pi 暴露经 capability 过滤的 Tool，执行路径固定为
      `propose -> waitUntilExecutable -> execute`；业务 Tool 注册于 `ToolRegistry`，Pi ToolResult 不能直接
      写业务终态。`tool-call.integration.test.ts` 覆盖只读结算、审批、恢复和重复副作用隔离。
- [ ] 真实模型验证工具选择、参数正确率、循环次数、重复副作用为零和终态一致性。

首选本地落点：`packages/agent-runtime/`、`packages/agent-application/`、`packages/tool-runtime/`。

## P0：Multi-Agent Task Runtime

上游源码：

- `packages/coding-agent/src/task/structured-subagent.ts`
- `packages/coding-agent/src/task/types.ts`
- `packages/coding-agent/src/task/spawn-policy.ts`
- `packages/coding-agent/src/task/provider-concurrency.ts`
- `packages/coding-agent/src/task/parallel.ts`
- `packages/coding-agent/src/task/persisted-revive.ts`
- `packages/coding-agent/src/task/yield-assembly.ts`
- `packages/coding-agent/src/registry/agent-registry.ts`

上游测试起点：

- `packages/coding-agent/test/structured-subagent-*.test.ts`
- `packages/coding-agent/test/task-*.test.ts`
- `packages/coding-agent/test/agent-session-eager-task.test.ts`
- `packages/coding-agent/test/issue-2750-subagent-runtime-fallback.test.ts`
- `packages/coding-agent/test/issue-985-subagent-auth-fallback.test.ts`
- `packages/coding-agent/test/job-tool-agent-roster.test.ts`

TODO：

- [x] 定义 AgentPress `SpecialistTaskRequest`：identity、assignment、Context Pack、allowed tools、
      output schema、parent task、depth、timeout、budget、detached 和 owner。
- [x] 复制 caller/agent/session 三层 output schema 优先级与 strict/permissive 验证行为。
      固定上游 `f446b8a` 的 caller-presence > agent > session 与 mode 继承行为已适配到
      `specialist-task-contract.ts`；caller 两种模式均预检，继承 schema 仅 strict fail closed，
      Planned Specialist 将 source/mode 固定进 `toolPolicy`。对应契约测试覆盖无 schema 场景。
- [x] 复制递归深度限制、自调用阻止、spawn policy 和 provider concurrency 测试。
      `packages/agent-application/test/contracts.test.ts` 覆盖最大深度、自调用拒绝、父级 allowlist、
      合法嵌套和 provider ceiling；固定策略仍由 `specialist-task-contract.ts` 在 host 侧执行。
      已先接入 AgentPress host-side 基础策略：嵌套请求要求 parent owner、禁止同 owner 自调用、支持 allowed owner policy，DAG 波次取 Specialist 与 provider 上限最小值；动态 nested spawn 路由和固定上游完整测试集仍待实现。
- [x] 实现持久化 Agent Registry，状态来源为 PostgreSQL Task/RunEvent，不采用进程内 registry 作为事实源。
      `AgentRegistryService` 从 `agent_runs`、`agent_tasks` 与有序 `run_events` 重建 Main/Specialist
      条目，投影稳定 ID、owner、status、attempt 和最近事件；`DirectRunService.getProjection` 将其作为
      只读 `agents` 返回给 Web。无 Run 事实时服务返回空列表，没有进程内 fallback。
- [x] 支持有界并行 Specialist、依赖 DAG、yield、等待、取消、失败和 degraded Task Result。
      `task_complete` 已作为结构化 yield 持久化 TaskResult；`AgentTaskWaitService` 只读 PostgreSQL
      Task/TaskResult，按请求顺序等待任一 exact-attempt 结果并返回 `settled`、`stillRunning`、
      `timedOut`，支持有界 timeout 与 AbortSignal 取消传播；DAG 波次、required/optional failure、
      degraded 综合和原子 cancel 均有确定性测试与 PostgreSQL 集成覆盖。
- [x] 支持 detached Specialist 的恢复和结果投递，但不得在恢复时重复副作用。
      已落地 `agent.task.commands`、transactional outbox、PostgreSQL 原子 Task claim、按 attempt
      持久化 lease、immutable Context Pack 恢复、TaskResult/Checkpoint/RunEvent 同事务结算，以及
      `run.execute` outbox 唤醒。`task_results.summary` 现在与 status/artifacts/usage/warnings/failure
      一起持久化；detached wait 会读取最新已决 attempt 的完整成功或失败结果并投递给 Main 综合，
      worker 周期扫描会在同一事务内回收过期 lease 并写入新的 `task.execute` outbox。隔离 PostgreSQL
      已覆盖只重投一次、第二 attempt claim 和 Main 结果投递。Specialist 非只读 ToolCall 现在持久化
      task attempt、参数签名内调用序号和宿主生成的稳定逻辑操作键；新 attempt 会从 PostgreSQL 重建
      序号游标，复用已知成功结果，并将执行中或 Unknown Outcome 的相同操作永久 fail closed。旧 worker
      的延迟 settlement 使用 ToolCall CAS fence，不能覆盖新 attempt 写入的 Unknown Outcome。相反语义
      回归同时证明正常路径中多个同参操作仍使用不同逻辑键。`apps/agent-worker/test/task-recovery.integration.test.ts`
      已在真实 Kafka/PostgreSQL 上验证 consumer 领取后失联、过期 lease 生成恢复 command、第二 attempt
      结果投递、同一恢复 command 重复投递只产生一个 TaskResult，以及 cancel 后迟到 command 不能复活 Task。
- [x] 将 kill/revive 适配为 AgentPress cancel/retry/recover 状态转换，并要求 checkpoint 和幂等证明。
      已将 Oh My Pi `agent-lifecycle.ts` 的 stale-ref finalizer 保护适配为 PostgreSQL attempt fence：
      `settleAgentTaskAttempt` 只有在 Task 仍为 `running` 且 attempt 完全匹配时才允许结算；取消、lease
      过期恢复或新 attempt 后的旧 worker 结果无法覆盖新状态。`requestCancellation` 现在在同一
      PostgreSQL 事务中调用 `cancelAgentRunTasks`，释放活跃 lease 并写 `task.cancelled`；取消后的
      late success 已通过数据库和 Planned Run 集成回归验证。ToolCall 的 retry/recover checkpoint、
      task attempt fence、稳定逻辑操作键、Unknown Outcome 钉住和 stale settlement CAS 已通过隔离
      PostgreSQL 集成证明；真实 Kafka worker 失联、重复 recovery command 与 cancel 后迟到 command
      也已通过生产 command handler 的端到端验收。
- [x] Specialist 只拿最小 Context Pack；Main 只接收结构化结果、Evidence 和公开摘要，不接收私有推理。
      已收紧 Specialist 模型可见 turn：仅传 task/验收条件/能力与上游公开摘要，清空父级 granted capabilities。
      PostgreSQL `context_packs` 不再保存完整 root request，只保留 detached 恢复所需的 current-turn 协议壳、
      Task 与宿主策略；正常、已审批 Tool continuation 和协议修复三条路径统一使用
      `specialistApplicationTurn`，不会重新继承 Main request、context 或 capability。`task_complete` 使用 closed
      Schema，TaskResult 与 Main synthesis envelope 只投影公开 summary、warnings/failure、Evidence 与 Artifact
      摘要。PostgreSQL 回归证明 provider thinking 只保留在 Specialist transcript，不进入 TaskResult、Main turn
      或 Main transcript；真实模型的路由、委派和合并质量仍由下方独立 online gate 验收。
- [x] 不复制 Worktree、Git patch、Bash subprocess 和本地 artifacts 目录；映射为 Article Revision、
      EditProposal、Artifact 和 PostgreSQL Checkpoint。
- [x] 复制并扩展相反语义测试：并行不越权、子 Agent 不继承未授权工具、取消不变成功、重试不重复写入。
      Specialist policy 测试覆盖 provider ceiling、spawn allowlist 和 capability 隔离；PostgreSQL attempt
      fence、原子 Task cancel 与过期 lease 单次重投测试覆盖 late success 和重复 TaskResult/Artifact 为零。
- [x] 使用真实 Pi runtime/目标模型验证路由、委派、并行合并和 Specialist Schema 有效率。
      真实 OpenAI-compatible Provider、Pi runtime `0.82.1`、`gpt-5.6-terra`（Main 与全部
      Specialist 均锁定同一模型）完整门禁已通过：
      `.agentpress/evals/2026-08-05T15-45-59-405Z-gpt-5.6-terra-delegation.json`
      覆盖 5 个路由/委派/直接修改/多角色合并场景，routing、delegation、Schema、citation、security
      全部为 1；`.agentpress/evals/2026-08-05T16-04-00-070Z-gpt-5.6-terra-parallelism.json`
      覆盖 3 个 fan-out/fan-in 场景，全部门禁为 1。并行有效性不是依据计划外观推断，而是从 PostgreSQL
      `run_events` 的 `task.started` 与 task 终态时间区间确定至少两项任务真实重叠；串行反例会使
      delegation gate 失败。验收同时修复了 Specialist protocol repair 丢失 immutable Task Brief、
      EditProposal provenance 被误填为 EvidenceRecord ID，以及 Main 生成非自包含 Task Brief 的协议缺陷。

首选本地落点：`packages/agent-application/`、`packages/domain/`、`packages/database/`。

## P1：MCP Streamable HTTP 与生命周期

上游源码：

- `packages/coding-agent/src/mcp/transports/http.ts`
- `packages/coding-agent/src/mcp/transports/sse.ts`
- `packages/coding-agent/src/mcp/client.ts`
- `packages/coding-agent/src/mcp/manager.ts`
- `packages/coding-agent/src/mcp/tool-bridge.ts`
- `packages/coding-agent/src/mcp/timeout.ts`
- `packages/coding-agent/src/mcp/oauth-*.ts`

上游测试起点：

- `packages/coding-agent/test/mcp-http-transport.test.ts`
- `packages/coding-agent/test/mcp-json-rpc.test.ts`
- `packages/coding-agent/test/mcp-reconnect.test.ts`
- `packages/coding-agent/test/mcp-reconnect-storm.test.ts`
- `packages/coding-agent/test/mcp-startup-no-block.test.ts`
- `packages/coding-agent/test/mcp-manager-oauth-refresh.test.ts`
- `packages/coding-agent/test/mcp-resource-templates-missing.test.ts`

TODO：

- [x] 先对照现有 `packages/mcp-runtime` 和已适配的 `pi-mcp-adapter`，形成缺口清单；已有行为不得重写。
      官方 MCP SDK 已覆盖 Streamable HTTP wire/session、JSON/SSE 和通知协议；现有 pi-mcp-adapter 适配已覆盖
      三个内置 Server、lazy/coalesced startup、稳定排序、output guard 与 degraded lifecycle。真实缺口仅为
      旧 client 条件淘汰、连接错误单次工具重试、首次 reconnect reset 的有界 probe，以及 restart fixture。
- [x] 评估直接使用官方 MCP TypeScript SDK 的 Streamable HTTP transport；只有产品契约缺口才复制 Oh My Pi 行为。
- [x] 补齐 POST JSON-RPC、JSON/SSE response、GET SSE listener 和 `Mcp-Session-Id` 契约测试。
- [x] 补齐 prompts、resources、resource templates、notifications 和 subscriptions 的受限内置服务器行为。
      三个内置 Server 只暴露固定 search guidance、policy 与 search capability 资源；未知资源/订阅 fail closed。
      Client Gateway 直接复用官方 SDK，并注册 resource/prompt/tool list notification schemas。证据：
      `packages/mcp-runtime/src/in-memory-built-ins.ts`、`client-gateway.ts` 及对应测试。
- [x] 复制超时、取消、断线、单次重试、重连去重和 reconnect-storm circuit breaker 测试。
      30 秒超时继续由 Tool Registry 合并 AbortSignal；Gateway 仅对明确连接/陈旧 session 错误重试一次，
      取消和非连接错误不重试。Manager 用 expected-client compare-and-evict 避免旧失败淘汰新连接，并以
      coalesced start、failure threshold 和 cooldown 限制 reconnect storm。
- [x] 保持 MCP Tool 稳定排序，避免 Prompt cache 因异步连接顺序失效。
- [x] 复用现有 output guard，补 Schema normalization、secret redaction、hostile/oversized output 和 Artifact 外置。
      MCP wire schema 走统一 provider adapter，输出先做 TypeBox 校验与 secret redaction；所有结果固定为
      `source=mcp, trust=untrusted`，hostile 指令不产生 capability；超预算完整值外置为 ToolOutput Artifact。
- [x] 首版不复制 OAuth/Smithery/stdio/任意 remote config；若内置 Server 未来需要 OAuth，另行安全评审。
      Production assembly 只注册 `BuiltInMcpServerId` 联合中的三个 Server，外部 HTTP 仅允许 HTTPS，
      localhost HTTP 仅供测试 fixture，URL 禁止携带凭据。
- [x] 所有 MCP 工具调用必须先持久化 AgentPress ToolCall，并经过 capability/approval/settlement。
      `createBuiltInToolRuntime` 只通过 `PersistentToolBridge -> ToolCallService -> ToolRegistry -> McpClientGateway`
      暴露模型工具；provider tool-call id 绑定幂等键，执行结果由 ToolCall settlement 和 RunEvent 持久化。
- [x] 使用真实 Streamable HTTP fixture 验证重连、取消、server restart 和不重复 ToolCall。
      `streamable-http.integration.test.ts` 使用官方 SDK 的真实 HTTP Server/Client transport，覆盖 JSON/SSE、
      session reuse、GET listener、在途取消、同端口 restart、单次恢复及服务端成功调用计数为一。

首选本地落点：`packages/mcp-runtime/`、`packages/tool-runtime/`。

## P1：短期与长期 Memory

上游源码：

- `packages/mnemopi/src/core/memory.ts`
- `packages/mnemopi/src/core/typed-memory.ts`
- `packages/mnemopi/src/core/beam/`
- `packages/mnemopi/src/core/embeddings.ts`
- `packages/mnemopi/src/core/episodic-graph.ts`
- `packages/mnemopi/src/core/extraction/`
- `packages/mnemopi/src/core/veracity-consolidation.ts`
- `packages/coding-agent/src/memory-backend/`

上游测试起点：

- `packages/mnemopi/test/memory-*.test.ts`
- `packages/mnemopi/test/typed-memory-aaak.test.ts`
- `packages/mnemopi/test/memory-banks.test.ts`
- `packages/mnemopi/test/identity-memory-parity.test.ts`
- `packages/coding-agent/test/agent-session-memory-backend.test.ts`
- `packages/coding-agent/test/internal-urls/memory-protocol.test.ts`

TODO：

- [x] 先对照 `packages/agent-context/src/memory.ts`、`memory_candidates` 和 PostgreSQL 检索实现，记录缺口。
      审计发现纯逻辑 `retrieveRelevantMemory` 未接入生产 Context Pack，真实查询此前无 query/validity/ranking，
      只截取 50 条 accepted rows；consolidation 也没有完整来源 ID。现已接入当前请求驱动的生产排序，
      PostgreSQL 先执行 workspace/user/status/validity 边界，并新增 `source_memory_ids` 事实链。
- [x] 短期 Memory 采用 Conversation Summary、最近消息、当前 Run facts 和 Task Results，不另建并行事实源。
      `packages/agent-context/src/context-assembler.ts` 只接收 Context Candidate/已接受 Memory，
      Summary/Run facts/Task Results 由上游 Context Pack 装配，不建立第二事实源。
- [x] 定义长期 Memory 类型：fact、preference、decision、commitment、goal、event、instruction、learning、
      error、artifact，并映射到现有 Memory Candidate 状态机。
- [x] 复制并适配 lexical relevance + confidence + temporal decay + importance + MMR 的混合召回与排序测试。
      `rankRelevantMemory` 返回可审计 score，生产 Context Pack 固定前 8 条并记录
      `accepted-memory.hybrid-v1`；semantic vector 不在没有真实 embedding 生命周期时伪造完成。
- [x] 评估 MMR、query intent、episodic graph、entity/triple 和 consolidation 的独立纯逻辑复用价值。
      采用 MMR 的多样性重排与 consolidation 的不可变来源链；拒绝 Mnemopi 英文关键词 query-intent，
      因为它对中文/多语言不可靠且不应成为权威分类。episodic graph/entity/triple 会复制 PostgreSQL
      Memory/Evidence 事实模型并引入自动提取写入，当前无独立采用价值。
- [x] Memory extraction 只能生成用户可见 Candidate；接受后才可检索，Specialist 不能直接写长期 Memory。
      接受状态只决定是否可召回，不提升内容信任级别；进入 Run Context Pack 的长期 Memory 固定为
      `trust="untrusted"`，与 Mention、Attachment、Evidence、Summary 和 Skill 数据保持一致。
- [x] 不复制关键词模式作为权威分类；用结构化模型输出加确定性 Schema 校验，并保留人工覆盖。
      Memory Candidate 通过结构化字段和 PostgreSQL 状态决策，检索不使用关键词分类授权。
- [x] 增加 workspace/user 隔离、source Evidence、confidence、validity、supersedes、删除和导出契约。
      删除写入 `deleted` tombstone 并清除 subject/value/source/evidence，导出默认排除 tombstone；API 只允许当前 workspace 成员操作自己的 Memory。
- [x] Consolidation 不得覆盖原始候选或 provenance；新事实通过 supersedes 链替代旧事实。
      用户显式选择 2-20 条自己的 accepted memory 后，只创建带 `source_memory_ids`、Evidence 并集和
      `supersedes_id` 的 pending candidate；再次接受后来源才转为 superseded，拒绝时来源保持 accepted。
- [x] 建立相反语义测试：拒绝的记忆不召回、跨 workspace 不召回、过期事实不作为当前事实、指令不变权限。
      `packages/agent-context/test/context.test.ts` 覆盖 rejected、跨 user、过期和 instruction-like
      memory；Context Pack 将记忆固定标记为 untrusted 且不产生 capability。
- [ ] 真实目标模型评估 accepted-memory precision、recall、污染率和跨租户泄漏为零。

首选本地落点：`packages/agent-context/`、`packages/knowledge-retrieval/`、`packages/database/`。

## P1：RAG、FAQ 与知识库

Oh My Pi 的 Mnemopi 是 Agent Memory 引擎，不是完整的多租户 FAQ/知识库产品；本节只复用检索算法，
不复制其本地 SQLite 数据模型。

TODO：

- [x] 对照现有 `packages/knowledge-retrieval` 的 PostgreSQL FTS、vector、embedding 和 rerank，禁止重复实现。
- [x] 评估复制 Mnemopi 的 MMR、polyphonic recall、query cache、query intent 和 temporal weighting 的纯逻辑测试。
- [x] 将可复用排序逻辑适配到现有 `KnowledgeDocument/KnowledgeChunk/Evidence` 契约。
- [x] FAQ 建立精确匹配、语义匹配和置信阈值；低置信结果必须回退知识库检索或标记未知。
- [x] 保留 source、chunk、revision/hash、retrieval score、rerank score 和 citation mapping。
- [x] 文章当前 revision 继续直接读取，不允许异步 RAG 结果覆盖更新的文章事实。
      `RunContextService.loadBoundArticleContent` 只按当前 Run 绑定的 `articleId + revisionId` 从
      PostgreSQL `article_revisions` 读取，并校验 workspace、revision 和 selection block hash；
      `ArticleKnowledgeIndexer` 仅写入带 `revisionHash` 的知识文档，不能覆盖 Article Context Pack。
      `direct-run.integration.test.ts` 已断言 Run 的 `mention_bindings` 固定到该 revision。
- [x] 建立检索离线集：FAQ 命中、知识库召回、冲突来源、过期文档、无答案和跨 workspace 隔离。
      固定数据集版本 `2026-08-04.v1` 位于
      `packages/knowledge-retrieval/test/fixtures/retrieval-eval-fixture.ts`，由 Recall@K、MRR、NDCG
      与 no-answer accuracy 统一评分；真实 embedding/rerank provider 验收仍由下一项单独跟踪。
      `packages/agent-evals/src/rag-provider-eval.ts` 进一步固定可供真实 provider 重跑的六类文档、query、
      active revision、workspace 和相关性金标；离线集与在线集共用 `evaluateRetrieval` 和 `scoreCitationResolution`。
- [ ] 使用真实 embedding/rerank provider 验证 Recall@K、MRR/NDCG、引用解析率和无答案精度。
      已新增 `pnpm eval:rag`，直接复用 `ArkEmbeddingProvider`、`ArkRerankProvider`、`evaluateRetrieval`
      和 `scoreCitationResolution`，对固定六类数据同时报告 Recall@K、MRR、NDCG、引用解析率、无答案精度、
      provider errors 与跨 workspace 命中数。候选文档在 rerank 调用前按 workspace 和 active revision
      fail closed 过滤；离线契约测试覆盖全指标通过与 provider 失败。2026-08-05 标准入口因本地未配置
      `ARK_RERANK_MODEL` 明确拒绝运行；配置真实 rerank endpoint 后仍需取得 `recallAtK >= 0.9`、
      `mrr >= 0.8`、`ndcg >= 0.85`、引用与无答案精度均为 1、errors/crossWorkspaceHits 均为 0 的报告。

首选本地落点：`packages/knowledge-retrieval/`、`packages/agent-context/`、`packages/agent-evals/`。

## P1：Agent Skills 开放标准

上游源码：

- `packages/coding-agent/src/capability/skill.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/autolearn/managed-skills.ts`

上游测试起点：

- `packages/coding-agent/test/discovery/monorepo-skills.test.ts`
- `packages/coding-agent/test/discovery/agents-monorepo-skills.test.ts`
- `packages/coding-agent/test/discovery/github-skills.test.ts`
- `packages/coding-agent/test/agent-session-tree-skill-injection.test.ts`
- `packages/coding-agent/test/autolearn-managed-skills.test.ts`
- `packages/coding-agent/test/fixtures/skills/`

TODO：

- [x] 对照现有 `skill_revisions`、`run_skill_bindings`、固定 Oh My Pi/`badlogic/pi-skills` 源码与测试，形成缺口清单：保留 `id` 兼容旧持久化记录，新增 Agent Skills `name`/目录/长度诊断；发现器报告损坏文档与同名冲突；Skill instructions/resource 进入 Context Pack 时统一为 untrusted。
- [x] 复制 Agent Skills `SKILL.md` frontmatter、标准目录发现、嵌套目录和冲突优先级 fixture。
- [x] 支持用户显式绑定和模型自主选择两条路径，并将 Run 使用的 Skill revision 固定到 Context Pack。
      模型选择通过官方 Pi Runtime 的 terminating structured tool 完成；宿主校验 exact revision、hidden/disable、重复、跨 workspace 和数量边界，
      并记录 `skill.selection.completed` 事件。真实目标模型准确率验收仍在评估 TODO 中。
- [x] 支持 `disable-model-invocation`、隐藏项、描述清洗和静态相对资源。
- [x] 复制路径穿越、symlink、hardlink、文件类型、大小、重复 ID 和恶意 description 测试。
- [x] Skill 只能缩小工具 allowlist，不能扩张平台、workspace、Agent 或 Task 权限。
- [x] Skill instructions 和 resource 必须标记为不可信数据，不得覆盖 system policy、tool schema 或 approval。
      `contextCandidate` 使用具名 `{ required, trusted }` 策略，避免布尔位置参数把数据误标为 trusted；
      Skill revision hash 同时覆盖 Markdown 和按声明顺序加载的静态 resources，读取时逐项复算 content hash、
      byte size 和聚合 hash，额外、缺失或被篡改的 resource 均 fail closed。
- [x] 首版不复制 managed/autolearn Skill 自动写入；当前只有显式的 PostgreSQL Skill revision/proposal 边界，未来如采用仍必须走 proposal、diff、审批、版本和回滚。
- [x] 不自动执行 Skill 脚本；Skill 只加载 Markdown 与声明的静态 regular-file resource，不执行脚本或隐式授予工具。
- [x] 建立 Skill conformance 和 prompt-injection 测试集，并用真实模型验证选择准确率与禁用项不被调用。
      已完成离线 conformance/prompt-injection 契约集：`validateSkillConformance`、损坏/冲突发现告警、Skill/resource `trust="untrusted"` 断言；
      新增 `pnpm eval:skill`，固定五案测试 exact selection、显式绑定去重、隐藏/禁用项和恶意 description，报告模型、数据集版本、逐案选择、
      exactMatchRate、forbiddenSelections 和 gatesPassed。入口自动读取根目录 `.env`，报告同时固定 provider、Prompt、Tool 和 Pi current-turn
      协议版本，并统一写入根目录 `.agentpress/evals`。Ark 欠费运行仍保留为 fail-closed 历史证据；随后使用备用
      OpenAI-compatible `gpt-5.6-luna` 完整运行五案，报告
      `.agentpress/evals/2026-08-05T15-02-24-190Z-gpt-5.6-luna-skill-selection.json` 取得
      `exactMatchRate=1`、`forbiddenSelections=0`、`errors=0`、`gatesPassed=true`。

首选本地落点：`packages/agent-context/`、`packages/database/`、`packages/agent-evals/`。

## P1：Agent 评估体系

上游源码：

- `packages/metaharness/src/store.ts`
- `packages/metaharness/src/benchmarks.ts`
- `packages/metaharness/src/experiments.ts`
- `packages/metaharness/src/runner.ts`
- `packages/metaharness/src/server.ts`
- `packages/metaharness/scripts/trace-report.ts`
- `packages/metaharness/adapters/edit/runner.ts`

上游测试起点：

- `packages/metaharness/test/benchmarks.test.ts`
- `packages/metaharness/test/experiments.test.ts`
- `packages/metaharness/test/manager.test.ts`
- `packages/metaharness/adapters/edit/runner.test.ts`

TODO：

- [x] 将 Experiment -> Arm -> Trial -> RunTrace 模型适配到 `packages/agent-evals`，记录模型、Prompt、Skill、
      Tool 和 Context policy 版本。
- [x] 复用 Harbor 的容器化任务思想，建立隔离数据库/schema、对象存储前缀、Kafka topic/group 和网络策略。
      已完成 AgentPress-owned `createEvalSandboxDescriptor`：schema、object prefix、topic/group
      均由 experiment/arm/trial 不可变身份派生，网络默认 deny-by-default 且只接受受限 allowlist；
      `createDockerEvalSandboxPlan` 只接受 digest 固定镜像，强制 network namespace=`none`、只读根文件系统、
      非 root、drop ALL capabilities、no-new-privileges、无宿主挂载和 CPU/内存/PID/timeout/tmpfs 上限。
      非空 egress allowlist 在没有已审计 proxy 时 fail closed，不退化为开放网络。
      `EvalSandboxResourceManager` 通过 Drizzle/PostgreSQL、KafkaJS 和 MinIO 的成熟客户端创建并清理
      Trial 专属 schema、topic 和对象前缀；`executeDockerEvalSandbox` 无 shell 执行固定计划，超时、
      AbortSignal 或输出越界时强制删除容器。`pnpm eval:sandbox` 已在 Docker Engine 29.2.0 与真实
      PostgreSQL/Kafka/MinIO 上验证非 root、只读根、noexec tmpfs、cap-drop、NoNewPrivs、network=none、
      资源身份注入、超时删除以及所有外部资源清理。
- [x] 支持固定测试集、并发、attempts、pass@k、resume、cancel 和失败试次重跑，不复用已污染业务数据。
      `ExperimentStore` 已支持固定 seed/attempts、pass@k、cancel、失败重跑和 pending resume；新增
      Eval Trial claim token/worker lease、`FOR UPDATE SKIP LOCKED` 并发领取与过期 worker fence。
      过期 Trial 先标记 `worker_lease_expired`，retry 创建新 trialId，因此得到新的 database schema、
      sandbox object prefix 和 Kafka group；Schema hash 绑定完整 experiment/arm/trial 身份，重试不再共享
      已污染 Schema。`runSandboxExperiment` 现在将 Trial claim、续租/过期恢复、资源租约、固定
      case/arm、Docker structured output、cancel、失败重试和 exact-claim settlement 串成有界并发循环；
      失败 attempt 和进程丢失的旧资源在 retry 前先按旧 descriptor 清理。离线 runner 测试覆盖并发
      claim/lease fence、结构化输出和恢复，`pnpm eval:sandbox` 真实 PostgreSQL/Kafka/MinIO/Docker
      测试覆盖 persisted Experiment、失败重试、fresh schema/topic/group/prefix 和 completed settlement。
- [x] 保存完整但脱敏的 RunEvent/ToolCall/Task/Evidence/Proposal/Settlement trace，供过程评分和故障分析。
      `loadPersistedRunTrace` 直接从 PostgreSQL 投影 RunEvent、AgentTask/TaskResult、ToolCall/Approval、
      Evidence、Action/Edit Proposal、Batch 与 operation decision；正文、Tool 参数/输出和编辑操作不复制，
      只保留 ID、状态、版本、计数、时间与稳定 hash。绑定真实 Run 的 Eval Trial 仅允许在 Agent Run
      终态后结算，并在同一 Trial settlement 事务内写 `eval_run_traces`，stale claim 不会留下 Trace。
      递归 key redaction 之外还清理 Bearer、常见 API key 和 query-style secret；真实 PostgreSQL
      集成测试覆盖全部事实类型、非终态拒绝、自动 capture 和敏感正文不落 Eval Trace。
- [x] 结果指标覆盖任务成功、Schema 有效率、引用正确性、文章质量、编辑最小性和无答案准确率。
      `packages/agent-evals/src/experiment-report.ts` 将这些结果指标与过程指标统一投影，并只使用已决 trial 计算聚合值。
- [x] 过程指标覆盖路由、委派、工具选择、参数、审批、重试、循环、恢复、重复副作用、token、成本和延迟。
- [x] 复制 benchmark-native metric definition、统一 trace normalization 和 arm comparison 行为。
      已核对 Oh My Pi 固定 commit `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` 的
      `packages/metaharness/src/benchmarks.ts`、`experiments.ts` 及
      `test/benchmarks.test.ts`、`test/experiments.test.ts`；AgentPress 适配为
      `readEvalMetricDefinitions`、`buildEvalExperimentReport`、`buildEvalRegressionTrend`，事实源仍为 PostgreSQL。
- [x] 增加独立 LLM Judge：固定 rubric、结构化输出、blind comparison、位置随机化和 judge 模型/版本记录。
- [x] 增加 Judge 校准集、人工金标、与确定性指标的冲突报告，以及多次 Judge 方差阈值。
      `packages/agent-evals/src/judge-calibration.ts` 提供人工金标准确率/MAE、重复 Judge 一致率/方差和安全/确定性冲突报告；Judge 输出由宿主再次做结构化校验。
- [x] Oh My Pi `trace-report` 仅用于生成叙事故障分析，不作为正式 Judge 分数；正式评分必须可复现和可审计。
      `buildEvalExperimentReport` 输出 `tracePolicy=diagnostic_only`；正式结果/过程聚合只读取 PostgreSQL
      Trial 的 `resultMetrics/processMetrics`，trace 仅投影为脱敏可用标记/hash。回归测试证明相同 Trial
      有无 trace 时正式指标完全一致。
- [x] Dashboard 至少展示结果/过程双层指标、Trace、失败分类、成本、模型差异和回归趋势。
      `EvalController` 仅在 workspace member 授权后返回 workspace-scoped 实验列表、聚合报告、
      Trial Trace 和回归趋势；`EvalDashboard` 直接复用 `ExperimentStore` 的正式聚合结果，展示
      结果/过程指标矩阵、成本、失败分类、arm 配置与指标差异、趋势和脱敏 Trace 抽屉。
      `eval_experiments.workspace_id` 是产品读取边界；无归属的历史/CLI 实验不会从 API 暴露。
      PostgreSQL 集成测试覆盖跨 workspace 报告、Trace 与趋势均 fail closed，Playwright 已验证
      1440px 桌面、Trial/Trace 交互和 390px 移动视口无横向溢出。
- [x] PR 使用 deterministic/faux provider 验证状态机；真实 Pi/目标模型评估按成本控制手动或定时运行。
      根脚本 `pnpm eval:pr` 串行运行 domain、tool-runtime、agent-runtime、agent-application、database
      与 agent-evals 的离线状态机契约。评估报告显式区分 `deterministic_pr/faux` 和
      `target_model`：faux 报告固定 `qualifiesAsTargetModelEvidence=false`，禁止伪装真实 provider，
      且出现外部模型成本即 gate 失败。真实模型仍只由独立 `pnpm eval:online` 手动/定时入口运行。

首选本地落点：`packages/agent-evals/`、`packages/observability/`、`packages/database/`。

## P2：Prompt 与项目框架

上游源码：

- `packages/coding-agent/src/prompts/`
- `packages/utils/src/prompt.ts`
- `packages/coding-agent/src/task/prompt-policy.ts`
- `packages/coding-agent/src/session/session-tools.ts`

TODO：

- [x] 复用 Markdown Prompt 模板、变量渲染和小块组合模式，不复制 Coding Agent 巨型 System Prompt。
      `packages/agent-context/src/prompt.ts` 提供 fail-closed 变量渲染和确定性 block composer，主规划 Prompt 已接入。
- [x] 将角色/领域语义保留在 Prompt，将权限、路由、终态、恢复、幂等和 Schema 放在确定性代码中。
      主规划 Prompt 只描述路由语义；能力、Tool、计划和终态仍由 AgentPress policy/state machine 校验。
- [x] Prompt revision 继续持久化并绑定 Context Pack；Run 历史不得使用当前 Prompt 冒充历史版本。
- [x] Tool-specific guidance 放入 Tool contract/policy，不把完整工具规则重复堆进 System Prompt。
      `packages/tool-runtime` 以带稳定 ID 的 `ToolGuidance` 保存操作建议并确定性渲染；
      `PersistentToolBridge` 只把它附加到对应 Pi Runtime tool description。文章锚点/review mode 与 MCP
      untrusted-evidence 规则已从通用 Prompt/长描述下沉到各自工具契约。Capability、成员、Skill、
      ActionEnvelope、approval 和 settlement 仍由确定性代码判定，guidance 不参与授权。
- [x] 建立 Prompt snapshot 仅用于变更审计；行为验收必须通过真实模型场景和状态事实。
      `prompt_revisions` 新增 PostgreSQL `snapshot`/`snapshot_hash` 事实，记录 schema、template、
      variable-schema 版本、rendered content hash 与有序 block ID/hash；旧 revision 由 migration
      确定性回填。相同 `promptId + version` 的内容、composition hash 或结构任一漂移都会 fail closed。
      Snapshot 不进入 capability、approval、状态机或评分逻辑，也不作为模型行为通过的证据；真实模型
      行为仍由本清单各 online eval 门禁验收。
- [x] 不复制 Oh My Pi 的 Bun/Bazel/Rust/native/TUI 工程框架；继续沿用 AgentPress pnpm/Turbo/NestJS/Next.js。
- [x] 评估其模块边界而非目录照搬：compaction、schema、task、memory、MCP 和 eval 各自保持独立 owner。
      owner 分别固定为 `agent-context`/`agent-runtime`/`agent-application`/`mcp-runtime`/`agent-evals`，
      共享契约通过 AgentPress package exports 暴露，不复制上游目录树。

首选本地落点：`packages/agent-runtime/`、`packages/agent-application/`、`packages/database/`。

## 推荐实施顺序

### 当前真实门禁证据（2026-08-05）

- 在线 orchestrator 已生成真实 Pi runtime 报告：
  `.agentpress/evals/2026-08-05T13-00-47-777Z-doubao-seed-2-1-pro-260628.json`。
  报告和每个 item 都包含 model、Prompt revision、Skill、工具、Context 和 runtime/provider 版本；
  但目标模型 Run 未完成，`gatesPassed=false`，因此不能替代真实行为通过证据。
- 多轮压缩已由备用 OpenAI-compatible `gpt-5.6-luna` 完整通过：
  `.agentpress/evals/2026-08-05T15-01-31-311Z-gpt-5.6-luna-compaction.json`，
  Prompt `agentpress.conversation-compaction@2`、`factRetention=1`、task parity 与总门禁均通过。
- Skill 已由备用 OpenAI-compatible `gpt-5.6-luna` 完整五案通过：
  `.agentpress/evals/2026-08-05T15-02-24-190Z-gpt-5.6-luna-skill-selection.json`，
  `exactMatchRate=1`、禁用/隐藏/恶意 description 选择为零且 `gatesPassed=true`。
- RAG 真实 provider 门禁保持 fail-closed：`.env` 未配置 `ARK_RERANK_MODEL`，且 Ark `/models`
  查询没有可用 rerank endpoint，故未伪造 Recall/MRR/NDCG 结果。

- [x] 里程碑 1：Compaction contract、PostgreSQL facts、projection 和确定性测试。
- [x] 里程碑 2：Schema normalization 差距补齐与 Specialist 严格输出。
- [x] 里程碑 3：Tool loop/replay safety 和恢复协议。
- [x] 里程碑 4：Typed Specialist Task、并行、yield、cancel/recover。
- [x] 里程碑 5：MCP Streamable HTTP 差距补齐。
- [x] 里程碑 6：Accepted Memory 混合召回与 consolidation。
- [x] 里程碑 7：Skill conformance、安全资源加载和版本绑定。
- [x] 里程碑 8：Sandbox eval、过程/结果双层指标和 LLM Judge。
- [ ] 里程碑 9：RAG/FAQ 检索评测和跨 workspace 安全门禁。

每个里程碑是独立可验收的大功能，完成对应测试和检查后按仓库规则立即创建一条
`<type>: <简短中文说明>` Git commit，不与无关修改混合。

## 完成定义

- [x] 所有采用项都有固定上游路径、commit、license、本地路径和修改说明。
      `THIRD_PARTY_NOTICES.md` 已逐行为单元记录官方 Pi、Oh My Pi、pi-mcp-adapter、pi-web-access、Skill reference、InkOS reference 和 MetaHarness reference 的固定来源、许可证、Local path、改动与验证；未来候选项明确标为 reference-only。
- [x] 能直接依赖的模块已直接依赖；不能直接依赖的模块已有书面原因。
      官方 `@earendil-works/pi-*` 与 MCP SDK 直接依赖；Oh My Pi、pi-mcp-adapter、pi-web-access 的运行时/桌面/事实源边界拒绝理由，以及 AGPL/未授权来源的 reference-only 决策均已记录。
- [x] 所有复制适配项都先复制行为测试，并补 AgentPress 领域边界与相反语义测试。
      每个已采用行为单元均在 `THIRD_PARTY_NOTICES.md` 列出 upstream test 起点、local test、适配边界和验证结果；对应 AgentPress 测试覆盖 fail-closed、权限隔离、恢复、取消、重复副作用和跨 workspace 相反语义。
- [x] PostgreSQL 仍是 Conversation、Run、Task、ToolCall、Event、Checkpoint、Memory、Skill 和 Eval 事实源。
- [x] 未引入第二套 Pi Runtime、文件事实源、任意 MCP、Prompt 权限或自动长期写入。
- [ ] 真实 Pi runtime/目标模型验收结果包含模型、Prompt、Skill、工具和配置版本。
- [x] `THIRD_PARTY_NOTICES.md` 与 `docs/references/pi-ecosystem.md` 已随实际采用范围更新。
- [ ] lint、typecheck、unit、integration、build、相关浏览器测试和在线 eval 全部通过。
