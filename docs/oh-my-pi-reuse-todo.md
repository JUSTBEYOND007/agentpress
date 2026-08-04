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
- [ ] 只有直接依赖和复制适配都不成立时才允许自研；自研前记录候选模块及逐项拒绝理由。
- [x] 每次只引入一个行为单元，完成契约测试、领域边界测试、相反语义回归和真实 Pi/目标模型验收后提交。
- [ ] 不直接依赖 `@oh-my-pi/pi-agent-core`、`@oh-my-pi/pi-ai`、`snapcompact` 或 `mnemopi`；后两者
      仍传递依赖 Oh My Pi Runtime/native/Bun。优先复制最小纯逻辑及其测试，或移植行为到现有依赖。

## 明确排除

- [ ] 不引入第二套 Pi Agent Core、消息类型、Provider Catalog 或事件状态机。
- [ ] 不采用 Oh My Pi JSONL、本地 SQLite、Redis Session 或 SQL Session 表作为 AgentPress 事实源。
- [ ] 不复制 TUI、命令面板、终端控制、Git/Worktree、代码文件操作或本机凭据发现。
- [ ] 不开放任意用户配置的 stdio/remote MCP Server；首版仍限三个内置 MCP Server。
- [ ] 不让模型自动写入长期 Memory、Skill、文章正文或外部系统；必须经过 AgentPress proposal/approval/settlement。
- [ ] 不复制关键词式 Memory 分类作为权威判断，不把 Prompt 当权限、终态、幂等或恢复状态机。
- [ ] 不把 Oh My Pi 的 `eval` 代码执行工具误认为 Agent 评估平台。

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
- [ ] 复制并适配 Oh My Pi 的 `CompactionEntry`、branch summary、keep boundary 行为测试。
- [ ] 实现 token budget 驱动的自动压缩、手动压缩和 mid-turn 压缩，保留明确的 reserve provenance。
- [x] 复制 tool protection 行为：未结算 Tool Call、审批、Evidence、Article Revision、EditProposal、
      Memory Candidate、Task Result 和成本事实不得被普通 Summary 消除或改写。
- [x] 复制增量 Summary 行为：新 Summary 必须在旧 Summary 基础上更新，并记录继承来源。
- [x] 为 Conversation Branch 独立生成 branch summary，不污染兄弟分支（当前已完成 branch-scoped
      存储与读取隔离，尚缺 fork 时的继承/重建策略）。
- [x] 将读取/修改过的文章、Evidence、Artifact、Skill 版本和 Tool Call 列表写入压缩 preserve data。
      `collectConversationCompactionPreserveData` 只保存 PostgreSQL 事实引用，并覆盖 Run、ToolCall、审批、Evidence、Artifact/Version、TaskResult、Proposal/Batch、Article Revision、Memory、Skill、Model 与成本关联。
- [x] 压缩失败、超时、空输出或 Schema 失败时保留原始 timeline，并产生结构化可恢复错误。
      失败尝试 append-only 保存，`getEffectiveConversationCompaction` 只投影最近成功版本；timeout、cancelled、schema/provider failure 均不制造 Summary。
- [ ] 复制 context-window overflow、截断输出、remote compaction 失败和 fallback 的相反场景测试。
- [ ] 建立 AgentPress Summary 测试集，至少覆盖事实保留、用户意图、未完成动作、引用、分支隔离和陈旧状态。
- [ ] 使用真实 Pi runtime/目标模型验证多轮压缩前后任务完成率和事实保留率，而非只断言 Prompt 文本。

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
- [ ] 对缺失行为优先向官方 Pi 适配层补契约测试；只有官方 API 无法覆盖时才复制纯 Schema 逻辑。
- [x] 建立统一 Schema 管线：TypeBox（权威契约）-> JSON Schema -> dereference -> normalize -> provider adaptation
      -> wire schema -> result validation。
      Zod 仅保留在官方 MCP SDK 必须使用它的边界适配器中，不扩展为第二套领域契约。
- [ ] 复制 OpenAI strict、Anthropic、Google、Ollama、MCP 等方言的兼容 fixture 和失败用例。
- [x] 覆盖 `$ref`、`oneOf/anyOf`、nullable optional、`additionalProperties`、`const/enum`、tuple 和递归 Schema。
      证据：`packages/agent-runtime/test/schema-compatibility.test.ts`，覆盖 closed object、union、nullable、literal、tuple 和递归 `$defs`。
- [x] 定义 `strict` 与 `permissive` 两种结果策略；严格模式失败必须成为结构化失败，不得静默使用原文本。
      strict 返回带路径的失败；permissive 返回显式 `degraded` 和 failures，不做 coercion 或静默修复。`plan_submit`、`task_complete` 与 LLM Judge 已在宿主边界使用 strict 校验。
- [ ] 给 Specialist `TaskResult`、Execution Plan、Tool 参数/结果、MCP 输出、Memory Candidate 和 LLM Judge
      输出统一接入该验证层。
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

- [ ] 审计 `PiRuntimeAdapter` 已有 streaming、tool call、abort、continue 和 replay 行为并建立差距表。
- [ ] 复制 partial JSON Tool Call、无结果 Tool Call、重复 Tool Result 和并行 Tool Call 的协议测试。
- [x] 实现确定性的 Tool Call Loop Guard，区分模型重试、协议失败和业务工具失败。
- [ ] 为 Tool Choice Queue 建立持久化语义，避免 steering/follow-up 与强制工具选择互相覆盖。
- [x] 标记 replay-safe、idempotent、side-effecting 和 outcome-unknown 工具；恢复策略由标记决定。
- [x] Tool 输出超过预算时外置为 Artifact，只把受限摘要和引用放回模型上下文。
      内置 MCP 工具超过 256KB 时将脱敏完整值写入 PostgreSQL `ToolOutput` Artifact/ArtifactVersion，
      工具结果仅返回 artifact/version URI、字节数和最多 1000 字符摘要；无 writer 时继续 fail closed。
- [ ] 复制 Provider 切换、aborted thinking、unexpected stop、empty stop 和工具后续轮的恢复测试。
- [ ] 每个工具执行继续通过 AgentPress `ToolCallService`、权限、审批和 settlement，不让 Pi 状态直接结算业务。
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
- [ ] 复制递归深度限制、自调用阻止、spawn policy 和 provider concurrency 测试。
- [ ] 实现持久化 Agent Registry，状态来源为 PostgreSQL Task/RunEvent，不采用进程内 registry 作为事实源。
- [ ] 支持有界并行 Specialist、依赖 DAG、yield、等待、取消、失败和 degraded Task Result。
- [ ] 支持 detached Specialist 的恢复和结果投递，但不得在恢复时重复副作用。
      已落地 `agent.task.commands`、transactional outbox、PostgreSQL 原子 Task claim、按 attempt
      持久化 lease、immutable Context Pack 恢复、TaskResult/Checkpoint/RunEvent 同事务结算，以及
      `run.execute` outbox 唤醒。仍需在真实 PostgreSQL/Kafka 环境跑 worker 丢失、重复 command、
      cancel 和外部写幂等端到端测试后才可勾选。
- [ ] 将 kill/revive 适配为 AgentPress cancel/retry/recover 状态转换，并要求 checkpoint 和幂等证明。
- [ ] Specialist 只拿最小 Context Pack；Main 只接收结构化结果、Evidence 和公开摘要，不接收私有推理。
- [ ] 不复制 Worktree、Git patch、Bash subprocess 和本地 artifacts 目录；映射为 Article Revision、
      EditProposal、Artifact 和 PostgreSQL Checkpoint。
- [ ] 复制并扩展相反语义测试：并行不越权、子 Agent 不继承未授权工具、取消不变成功、重试不重复写入。
- [ ] 使用真实 Pi runtime/目标模型验证路由、委派、并行合并和 Specialist Schema 有效率。

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

- [ ] 先对照现有 `packages/mcp-runtime` 和已适配的 `pi-mcp-adapter`，形成缺口清单；已有行为不得重写。
- [x] 评估直接使用官方 MCP TypeScript SDK 的 Streamable HTTP transport；只有产品契约缺口才复制 Oh My Pi 行为。
- [x] 补齐 POST JSON-RPC、JSON/SSE response、GET SSE listener 和 `Mcp-Session-Id` 契约测试。
- [x] 补齐 prompts、resources、resource templates、notifications 和 subscriptions 的受限内置服务器行为。
      三个内置 Server 只暴露固定 search guidance、policy 与 search capability 资源；未知资源/订阅 fail closed。
      Client Gateway 直接复用官方 SDK，并注册 resource/prompt/tool list notification schemas。证据：
      `packages/mcp-runtime/src/in-memory-built-ins.ts`、`client-gateway.ts` 及对应测试。
- [ ] 复制超时、取消、断线、单次重试、重连去重和 reconnect-storm circuit breaker 测试。
- [x] 保持 MCP Tool 稳定排序，避免 Prompt cache 因异步连接顺序失效。
- [ ] 复用现有 output guard，补 Schema normalization、secret redaction、hostile/oversized output 和 Artifact 外置。
      Schema、secret redaction、oversized Artifact 外置已完成；仍需 hostile instruction 的上下文归因与
      真实 Streamable HTTP fixture 后再勾选。
- [ ] 首版不复制 OAuth/Smithery/stdio/任意 remote config；若内置 Server 未来需要 OAuth，另行安全评审。
- [ ] 所有 MCP 调用必须先持久化 AgentPress ToolCall，并经过 capability/approval/settlement。
- [ ] 使用真实 Streamable HTTP fixture 验证重连、取消、server restart 和不重复 ToolCall。

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

- [ ] 先对照 `packages/agent-context/src/memory.ts`、`memory_candidates` 和 PostgreSQL 检索实现，记录缺口。
- [x] 短期 Memory 采用 Conversation Summary、最近消息、当前 Run facts 和 Task Results，不另建并行事实源。
      `packages/agent-context/src/context-assembler.ts` 只接收 Context Candidate/已接受 Memory，
      Summary/Run facts/Task Results 由上游 Context Pack 装配，不建立第二事实源。
- [x] 定义长期 Memory 类型：fact、preference、decision、commitment、goal、event、instruction、learning、
      error、artifact，并映射到现有 Memory Candidate 状态机。
- [x] 复制并适配 vector + FTS + temporal decay + importance 的混合召回与排序测试。
- [ ] 评估 MMR、query intent、episodic graph、entity/triple 和 consolidation 的独立纯逻辑复用价值。
- [x] Memory extraction 只能生成用户可见 Candidate；接受后才可检索，Specialist 不能直接写长期 Memory。
- [x] 不复制关键词模式作为权威分类；用结构化模型输出加确定性 Schema 校验，并保留人工覆盖。
      Memory Candidate 通过结构化字段和 PostgreSQL 状态决策，检索不使用关键词分类授权。
- [x] 增加 workspace/user 隔离、source Evidence、confidence、validity、supersedes、删除和导出契约。
      删除写入 `deleted` tombstone 并清除 subject/value/source/evidence，导出默认排除 tombstone；API 只允许当前 workspace 成员操作自己的 Memory。
- [x] Consolidation 不得覆盖原始候选或 provenance；新事实通过 supersedes 链替代旧事实。
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
- [ ] 文章当前 revision 继续直接读取，不允许异步 RAG 结果覆盖更新的文章事实。
- [x] 建立检索离线集：FAQ 命中、知识库召回、冲突来源、过期文档、无答案和跨 workspace 隔离。
      固定数据集版本 `2026-08-04.v1` 位于
      `packages/knowledge-retrieval/test/fixtures/retrieval-eval-fixture.ts`，由 Recall@K、MRR、NDCG
      与 no-answer accuracy 统一评分；真实 embedding/rerank provider 验收仍由下一项单独跟踪。
      已提供 `evaluateRetrieval` 与 `scoreCitationResolution` 确定性指标和基础 fixture；完整业务离线集仍待补齐。
- [ ] 使用真实 embedding/rerank provider 验证 Recall@K、MRR/NDCG、引用解析率和无答案精度。

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

- [ ] 先对照现有 `skill_revisions`、`run_skill_bindings` 和 `packages/agent-context/src/skill.ts`，形成缺口清单。
- [x] 复制 Agent Skills `SKILL.md` frontmatter、标准目录发现、嵌套目录和冲突优先级 fixture。
- [x] 支持用户显式绑定和模型自主选择两条路径，并将 Run 使用的 Skill revision 固定到 Context Pack。
      模型选择通过官方 Pi Runtime 的 terminating structured tool 完成；宿主校验 exact revision、hidden/disable、重复、跨 workspace 和数量边界，
      并记录 `skill.selection.completed` 事件。真实目标模型准确率验收仍在评估 TODO 中。
- [x] 支持 `disable-model-invocation`、隐藏项、描述清洗和静态相对资源。
- [x] 复制路径穿越、symlink、hardlink、文件类型、大小、重复 ID 和恶意 description 测试。
- [x] Skill 只能缩小工具 allowlist，不能扩张平台、workspace、Agent 或 Task 权限。
- [x] Skill instructions 和 resource 必须标记为不可信数据，不得覆盖 system policy、tool schema 或 approval。
- [ ] 首版不复制 managed/autolearn Skill 自动写入；未来如采用，必须走 proposal、diff、审批、版本和回滚。
- [ ] 不自动执行 Skill 脚本；若未来增加执行能力，必须通过已注册工具和独立沙箱授权。
- [ ] 建立 Skill conformance 和 prompt-injection 测试集，并用真实模型验证选择准确率与禁用项不被调用。

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
- [ ] 复用 Harbor 的容器化任务思想，建立隔离数据库/schema、对象存储前缀、Kafka topic/group 和网络策略。
- [ ] 支持固定测试集、并发、attempts、pass@k、resume、cancel 和失败试次重跑，不复用已污染业务数据。
- [ ] 保存完整但脱敏的 RunEvent/ToolCall/Task/Evidence/Proposal/Settlement trace，供过程评分和故障分析。
- [ ] 结果指标覆盖任务成功、Schema 有效率、引用正确性、文章质量、编辑最小性和无答案准确率。
- [x] 过程指标覆盖路由、委派、工具选择、参数、审批、重试、循环、恢复、重复副作用、token、成本和延迟。
- [ ] 复制 benchmark-native metric definition、统一 trace normalization 和 arm comparison 行为。
- [x] 增加独立 LLM Judge：固定 rubric、结构化输出、blind comparison、位置随机化和 judge 模型/版本记录。
- [x] 增加 Judge 校准集、人工金标、与确定性指标的冲突报告，以及多次 Judge 方差阈值。
      `packages/agent-evals/src/judge-calibration.ts` 提供人工金标准确率/MAE、重复 Judge 一致率/方差和安全/确定性冲突报告；Judge 输出由宿主再次做结构化校验。
- [ ] Oh My Pi `trace-report` 仅用于生成叙事故障分析，不作为正式 Judge 分数；正式评分必须可复现和可审计。
- [ ] Dashboard 至少展示结果/过程双层指标、Trace、失败分类、成本、模型差异和回归趋势。
- [ ] PR 使用 deterministic/faux provider 验证状态机；真实 Pi/目标模型评估按成本控制手动或定时运行。

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
- [ ] Tool-specific guidance 放入 Tool contract/policy，不把完整工具规则重复堆进 System Prompt。
- [ ] 建立 Prompt snapshot 仅用于变更审计；行为验收必须通过真实模型场景和状态事实。
- [ ] 不复制 Oh My Pi 的 Bun/Bazel/Rust/native/TUI 工程框架；继续沿用 AgentPress pnpm/Turbo/NestJS/Next.js。
- [ ] 评估其模块边界而非目录照搬：compaction、schema、task、memory、MCP 和 eval 各自保持独立 owner。

首选本地落点：`packages/agent-runtime/`、`packages/agent-application/`、`packages/database/`。

## 推荐实施顺序

- [ ] 里程碑 1：Compaction contract、PostgreSQL facts、projection 和确定性测试。
- [ ] 里程碑 2：Schema normalization 差距补齐与 Specialist 严格输出。
- [ ] 里程碑 3：Tool loop/replay safety 和恢复协议。
- [ ] 里程碑 4：Typed Specialist Task、并行、yield、cancel/recover。
- [ ] 里程碑 5：MCP Streamable HTTP 差距补齐。
- [ ] 里程碑 6：Accepted Memory 混合召回与 consolidation。
- [ ] 里程碑 7：Skill conformance、安全资源加载和版本绑定。
- [ ] 里程碑 8：Sandbox eval、过程/结果双层指标和 LLM Judge。
- [ ] 里程碑 9：RAG/FAQ 检索评测和跨 workspace 安全门禁。

每个里程碑是独立可验收的大功能，完成对应测试和检查后按仓库规则立即创建一条
`<type>: <简短中文说明>` Git commit，不与无关修改混合。

## 完成定义

- [ ] 所有采用项都有固定上游路径、commit、license、本地路径和修改说明。
- [ ] 能直接依赖的模块已直接依赖；不能直接依赖的模块已有书面原因。
- [ ] 所有复制适配项都先复制行为测试，并补 AgentPress 领域边界与相反语义测试。
- [ ] PostgreSQL 仍是 Conversation、Run、Task、ToolCall、Event、Checkpoint、Memory、Skill 和 Eval 事实源。
- [ ] 未引入第二套 Pi Runtime、文件事实源、任意 MCP、Prompt 权限或自动长期写入。
- [ ] 真实 Pi runtime/目标模型验收结果包含模型、Prompt、Skill、工具和配置版本。
- [ ] `THIRD_PARTY_NOTICES.md` 与 `docs/references/pi-ecosystem.md` 已随实际采用范围更新。
- [ ] lint、typecheck、unit、integration、build、相关浏览器测试和在线 eval 全部通过。
