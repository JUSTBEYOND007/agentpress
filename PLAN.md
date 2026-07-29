# AgentPress：Pi Agent 驱动的长文创作平台

## Summary

- 从空仓库构建全栈 TypeScript monorepo，前后端独立部署，首版仅支持桌面浅色 Web。
- 核心是 Pi 驱动的高级 Agent：多轮会话、联网研究、内置 MCP、Mention、Skill、多 Agent 委派、可见记忆、RAG、状态追踪、工具审批和文章修改。
- 工程实施以 Agent Runtime 为第一主线；编辑器、知识库和发布系统都是 Agent 的上下文来源、工具目标或结果展示面，而不是与 Agent 平级争夺首版重心。
- 私有工作区采用多级文件夹 + 文章；公开发布生成不可变版本，进入全站 24 小时/7 天热榜并支持登录用户赞踩。
- 面试黄金路径优先展示 Agent 编排、工具调用、状态恢复与权限边界；本地完整运行，并提供火山引擎生产 IaC，但不实际部署公网环境。

## Architecture

- 使用 Node `>=22.19`、pnpm、Turborepo；应用拆为 Next.js Web、NestJS API、NestJS Agent Worker、NestJS 异步索引/媒体 Worker，共享领域、契约、编辑器 schema 和基础设施适配包，各应用独立构建、部署和扩缩容。
- Next.js App Router + React 19 负责页面、路由和渲染缓存；热榜与公开文章使用 SSR，编辑器和 Agent 工作台使用 Client Components。Tiptap `3.29.2` + ProseMirror 负责编辑器，assistant-ui `0.15.1` 通过 `ExternalStoreRuntime` 对接自有 Agent SSE 协议。
- NestJS 使用 Fastify Adapter、TypeBox/Ajv 和 OpenAPI 提供独立 REST/SSE API；Drizzle `0.45.2` 管理 PostgreSQL 16 与 pgvector。NestJS 仅负责依赖组合、入口和进程生命周期，Domain 保持纯 TypeScript。
- Next.js 不使用 Server Actions 承载业务写入，不直接访问数据库；所有查询、命令、鉴权、文章、Agent、RAG、发布和热榜逻辑统一经过 NestJS API。
- PostgreSQL 是唯一业务事实源；Redis 只负责限流、缓存、单写者/Worker 租约、取消标记和 SSE 广播；Kafka 只承载持久异步命令与领域事件。
- Kafka 采用 transactional outbox、consumer inbox 和至少一次投递；使用当前维护的 Confluent JavaScript client，生产兼容火山 Kafka 2.8.2。
- 本地 Docker Compose 启动 PostgreSQL/pgvector、Redis、Apache Kafka KRaft、MinIO、Logto、文档解析服务和可观测性组件。
- 生产 IaC 使用 Helm + OpenTofu，目标为北京地域多 AZ 的 VKE 1.34、RDS PG16、Redis 7、Kafka 2.8.2、TOS/CDN；设计基线约 1 万 MAU、1000 并发客户端、100 个并发 Agent Run，RPO 5 分钟、RTO 30 分钟。
- 建立 `CONTEXT-MAP.md`，划分 Authoring、Agent Runtime、Knowledge、Publishing 四个上下文；ADR 记录 Pi 适配边界、无 Yjs 的 revision 协议、Postgres/Kafka/Redis 职责和模块化核心 + 独立 Worker。

## Product And Editor

- 截图级复刻 Notion 三栏桌面布局并替换为 AgentPress 品牌：左侧文件夹/文章/会话/内置 Agent，中间文章编辑器，右侧 Agent 会话与运行树；不做移动端、深色模式和 Notion 数据库。
- 热榜 SSR 结果使用短时缓存，客户端接管赞踩和局部刷新；公开文章按当前 `Edition` SSR，重新发布或撤回后由后端事件触发缓存失效，同时保持默认 `noindex`。
- Tiptap 支持标题、段落、列表、任务项、引用、代码、表格、图片、分隔线、目录、拖拽、气泡工具栏、斜杠命令和稳定 block ID。
- 自动保存发送带 `updateId`、`baseRevision` 的 ProseMirror step batch；服务端提交后才显示“已保存”，未确认步骤存入 IndexedDB。
- 同一文章只允许一个标签页持有写租约；离线后租约被接管时，将未同步内容保存为恢复副本，绝不丢稿或覆盖主稿。
- 自动修订保留 30 天；手动版本、发布版本、Agent 自动写入前及强制覆盖前的恢复点永久保留；删除进入 30 天回收站。
- 基于 `@handlewithcare/prosemirror-suggest-changes@0.1.8` 的审计后仓内 fork 实现正文红删绿增、图片/结构块 diff、逐项或全部接受/拒绝，并保留来源 commit 与 NOTICE。
- 用户可为各内置 Specialist 的修改类 Artifact 配置“提案”或“自动写入”，默认提案；无论来源为何，实际应用都由 Main Agent 发起。过期提案允许覆盖，但必须展示将被覆盖内容、二次确认并先创建永久恢复点。
- 图片节点只保存 `assetId`、尺寸、alt、说明与版权来源；上传、AI 生成和 Wikimedia Commons 等明确许可素材统一进入 MinIO/TOS，方舟临时图片 URL 必须立即转存。
- 发布创建不可变 `Edition`，公开 URL 与赞踩归属稳定 `Publication`；重新发布保留互动，撤回则下线。仅提供公开发布，不做私密分享、评论、分类频道或搜索引擎收录。

## Agent And Knowledge

- 锁定 `@earendil-works/pi-agent-core@0.82.1` 和 `pi-ai`，置于 `PiRuntimeAdapter` 后；Pi 负责 Agent loop、流式输出和 tool use，领域/API 不暴露 Pi 类型。
- Agent 实现采用 copy-first 策略，详细来源与边界见 `docs/references/pi-ecosystem.md`：官方 Pi 直接依赖；Oh My Pi 的 typed subagent、hash-anchor、提案、checkpoint 与 tool harness 选择性复制改造；InkOS 的上下文治理和写作-审阅-修订/恢复管线在满足 AGPL 义务时复制改造；LLM Space 的 trace/replay/eval、pi-mcp-adapter 的生命周期与输出防护、pi-web-access 的 SSRF/抽取/来源校验选择性复制改造。
- 禁止把上游 Pi fork、TUI/桌面假设、本地文件 session、浏览器 Cookie、旧 Pi 类型或上游持久化模型带入产品核心；所有复制代码必须位于 AgentPress adapter/port 后，PostgreSQL 状态机和产品契约始终是事实源。
- `docs/agent-runtime-spec.md` 是 Agent 行为的实现规格；产品自行持久化 Conversation、Message Branch、Agent Run、Execution Plan/Revision、Agent Task、Context Pack、Task Result、Tool Call、Approval、Checkpoint、Usage 和事件序列。
- 每个 `Root Request` 只创建一个由 Main Agent 拥有的 `Agent Run`；运行中的 Steering Instruction 归属当前 Run，Follow-up 在当前 Run 结束后成为新的 Root Request。`@Specialist` 只形成明确的委派约束，不绕过 Main Agent。Researcher、Writer、Editor、Fact Checker、Illustrator 不拥有独立会话或长期记忆，只接收不可变 `Task Brief` 并返回结构化 `Artifact`、`Evidence` 和 `Usage`。
- 不涉及委派、检索、外部工具或文章修改的请求创建 `Direct Run`；其余请求必须创建 `Planned Run`，先持久化并展示由依赖有序 `Agent Task` 组成的 `Execution Plan`。新证据或失败改变后续工作时创建不可变 `Plan Revision`，不得静默改写旧计划；计划本身默认无需审批。
- Main Agent 为每个 Agent Task 构造最小权限、不可变的 `Context Pack`，只包含 Task Brief、明确选择的 revision/block/Mention、必要 Evidence、已接受 Memory、Skill、工具 allowlist、输出 schema 和预算。Specialist 不继承完整 Conversation，不直接修改文章，只返回含状态、Artifact、Evidence、Usage 和错误的 `Task Result`；修改类 Artifact 由 Main Agent 统一治理。
- Specialist 之间不直接通信或委派；Main Agent 是唯一调度者，单次运行最多 12 个 Agent Task、并发 4 个、运行 30 分钟、每任务 20 轮，幂等操作最多重试 2 次。
- Agent Task 明确区分 Required/Optional 并声明 Acceptance Criteria；Optional 失败允许形成显式降级结果，Required 失败必须恢复、等待用户或终止，最终回答必须披露失败、跳过、fallback 和未核验内容。
- 每个 Conversation branch 同时只运行一个 Agent Run；运行中消息明确成为下一安全边界生效的 Steering Instruction，或排队为新 Run 的 Follow-up。转向会创建 Plan Revision，不修改正在执行的 Specialist Context Pack。
- 工具注册表固定版本、输入输出 schema、风险、副作用、幂等、成本和审计规则；有效权限取平台、工作区、Agent、Skill、Task 与额度策略的交集。审批绑定精确参数和副作用，外部结果不确定时进入 `outcome_unknown`，禁止自动重试。
- 首版 MCP 只开放平台内置的 Web Research、Workspace Knowledge、Licensed Media 三个 Server，使用官方 MCP SDK `1.30`，不允许用户配置远程或 stdio Server。
- Skill 是可版本化的声明式 Markdown 指令、参数 schema 和工具 allowlist；用户可创建私有 Skill，但不能上传代码。`@mention` 支持文章、块、文件、内置 Agent 和 Skill，并在运行开始时绑定具体 revision/hash。
- 记忆分为会话摘要、工作区事实、用户写作偏好；Main Agent 只能创建用户可见的候选记忆，Specialist 不能直接写长期记忆，只能读取 Context Pack 中被选中的已接受记忆。
- RAG 对私有文章、PDF、DOCX、Markdown、TXT、网页快照和记忆做 PostgreSQL FTS + pgvector 混合检索；块级切分、ACL 过滤、内容 hash 去重，当前文章直接注入最新 revision。
- 每次模型调用保存 Context Manifest，记录实际装配的策略、任务、Mention、文章 revision、记忆、Evidence、Skill 版本及截断情况；外部网页、文件、MCP 和工具输出始终视为不可信数据，不能改变权限或工具策略。
- PostgreSQL 是 Agent 状态和 Checkpoint 的事实源，Pi Agent 实例只在 `PiRuntimeAdapter` 内按需重建；provider stream 不做字节级续传，Worker 崩溃后从稳定消息、Task Result 和已结算 Tool Call 继续，只有已证明幂等的操作允许重放。
- 火山方舟适配器默认配置当前 Doubao Seed Pro/Turbo、1024 维 Embedding、Seed Rerank 和 Seedream 图片模型，所有模型 ID 环境化以应对下线迁移。
- 联网研究使用豆包搜索 Custom API + 受控公开网页/PDF 抓取；每条事实保存 URL、标题、发布时间、抓取时间和证据片段，禁止访问内网、登录页面、付费墙或执行表单。

## Public Interfaces

- `AutosaveBatch { updateId, writerLeaseId, baseRevision, schemaVersion, steps[] }` 返回 `AutosaveAck { revision, contentHash, savedAt }`；重复 `updateId` 必须返回相同结果。
- `EditProposal` 使用 `articleId + baseRevision + blockId + expectedHash` 和结构化 insert/replace/delete/move/update-attrs 操作，禁止模型输出裸 ProseMirror position。
- `MentionRef` 固定 `entityType/entityId/revisionOrHash/label`；`RunEvent` 固定递增 `seq`、run/task、事件类型、状态和时间戳。
- REST 覆盖文件夹、文章、版本、提案、会话、运行、Skill、记忆、知识源、发布、赞踩、热榜、导出与管理员额度；Agent 流采用支持 `Last-Event-ID` 的 SSE。
- Kafka 事件统一包含 `eventId/schemaVersion/workspaceId/correlationId/causationId/aggregateId`；正文、token delta、autosave ACK 和在线状态不得进入 Kafka。
- 热榜由 Kafka 聚合点赞、点踩和去重阅读：基础分 `4*赞-5*踩+0.2*sqrt(阅读)`，分别按 18 小时和 96 小时半衰期衰减，平分时新文章优先。

## Verification And Delivery

- 顺序实施：Agent 领域文档与事件契约 → Pi 适配器、Run/Plan/Task 状态机和确定性测试 Runtime → 工具注册/审批/恢复 → 多 Agent/Context Pack/Steering → Agent UI → MCP/RAG/记忆/图片 → 编辑器 diff/自动保存 → 发布/热榜/导出 → IaC 与故障演练。
- 在首次复制上游实现前创建 `THIRD_PARTY_NOTICES.md`；每个复制单元记录仓库、不可变 commit、上游路径、本地路径、许可证、修改说明，并保留源文件版权/许可证头。先迁移上游测试，再补 AgentPress 适配器契约、状态恢复、安全与回归测试；无来源记录或无测试的复制代码不得合入。
- 上游版本升级按独立迁移处理，逐一执行 Pi 事件映射、MCP conformance、SSRF/抽取、编辑器 stale patch、Run replay 和 Agent eval 套件；禁止使用浮动 branch 或在一次变更中同时升级多个复用来源。
- 单元测试优先覆盖 Agent 状态机、计划修订、上下文装配、工具权限、未知副作用、额度和恢复；随后覆盖排名、revision 和 patch。契约测试锁住 Pi、方舟、MCP、编辑器 fork 与 OpenAPI 边界。
- Testcontainers 集成测试覆盖 PostgreSQL、Kafka、Redis、MinIO、outbox/inbox、重复事件、Worker 租约和索引最终一致性。
- Playwright 验收完整 Agent 架构演示、多轮分支、并行子 Agent、审批、RAG 引用、图片、diff、刷新恢复、离线恢复副本、发布与赞踩。
- Agent Eval Suite 至少包含 40 个版本化场景；未授权写入和 Unknown Outcome 自动重试必须为零，真实模型的路由/委派正确率与 Task Result schema 有效率不得低于 90%。
- 故障测试覆盖 Kafka/Redis/数据库不可用、SSE 重连、provider 429/超时、Worker 崩溃、重复工具结果、过期提案强制覆盖和对象存储失败。
- 使用视觉回归核对参考截图，axe 检查键盘与 WCAG AA；对 100k 字文章、长会话和目标并发运行性能报告，但按用户选择不设置硬性能门禁。
- README 提供真实火山 Key 驱动的一键本地演示脚本、架构图、故障演练、设计取舍和第三方来源；运行时不提供 fake AI provider，测试仍使用确定性 fake。

## Assumptions

- 首版为简体中文、个人工作区 SaaS 数据模型、公开昵称主页；团队角色与实时多人协作延后，且首版明确不使用 Yjs。
- 面试项目以可审计源码形式交付，可以履行 AGPL 组件的源码、许可证和修改声明义务；若未来改为闭源商业分发或网络服务，必须在采用 InkOS 衍生代码前重新完成许可证评估，必要时仅保留行为规格并独立实现。
- 身份使用自托管 Logto；本地可用标准账号，生产配置手机号 OTP 与微信 PC 扫码，业务系统只保存 Logto `sub`。
- 不接支付；管理员配置月度统一积分，模型、搜索和图片用量换算为积分并保留原始明细，额度耗尽只阻止新 Agent 任务。
- 不实现内容审核、支付、评论、私密分享、关注、自定义 Agent、自定义 MCP、移动端、暗色主题或公开 SEO。
- 由于未实现内容审核、备案和生成内容合规流程，公开发布与热榜只属于本地演示功能；即使提供生产 IaC，也不能据此认定可直接在中国大陆公开上线。
