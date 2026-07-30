# AgentPress

AgentPress 是一个由 Pi Agent 驱动的长文创作工作台：左侧内容树、中间 Tiptap 编辑器、右侧基于 `assistant-ui@0.15.1` 的 Agent 工作台。首要交付是可运行、可恢复、可评测的高级 Agent，而不是把平台功能堆在 Agent 之前。

当前交付是可完整本地部署的产品实现，不使用演示数据或 Fake Runtime 代替生产能力，但不宣称已经公网生产部署。首版只支持简体中文、桌面浅色模式和个人工作区；移动端、多人实时协作、评论、支付、内容审核、公开 SEO、自定义 Agent 与自定义 MCP 不属于首版范围。

## 快速开始

环境要求：Node `>=22.19`、pnpm `10.10.0`、Docker Compose v2。

```bash
pnpm install
pnpm infra:up
pnpm local:prepare
pnpm dev
```

首次启动后在 Logto Console 创建 Single Page App，登记 `http://localhost:3000`（或实际 Web 端口）为 Redirect URI、Post sign-out redirect URI 和 CORS origin；再创建 API Resource `http://localhost:4000/api`。将 App ID 与 Resource 分别写入 `NEXT_PUBLIC_LOGTO_APP_ID` 和 `NEXT_PUBLIC_LOGTO_API_RESOURCE`，API 使用同一个 Resource 作为 `LOGTO_API_RESOURCE`。浏览器通过 Authorization Code + PKCE 登录，API 使用 Logto JWKS 校验 access token，不接受客户端提交的用户 ID。

打开 [http://localhost:3000](http://localhost:3000)，API 健康检查为 [http://localhost:4000/v1/health](http://localhost:4000/v1/health)。`local:prepare` 会在不存在时从 `.env.example` 创建 `.env`、启动本地依赖并执行迁移。真实 Agent Run、RAG 和图片生成需要填写 `ARK_API_KEY`、`ARK_MODEL_PRO`、`ARK_EMBEDDING_MODEL` 与 `ARK_IMAGE_MODEL`；没有真实方舟 Key 时 Agent composer 会明确禁用，不会用 Fake Runtime 或伪向量冒充真实执行。

常用命令：

```bash
pnpm check                 # 格式、lint、类型、测试、构建
pnpm benchmark:editor      # 100k 字 Tiptap 插入/序列化/堆内存
pnpm benchmark:agent       # 100 Run + 1000 SSE 客户端
CONFIRM_LOCAL_FAULT_DRILL=1 node scripts/fault-drill.mjs redis
CONFIRM_LOCAL_FAULT_DRILL=1 node scripts/fault-drill.mjs kafka
pnpm infra:down
```

## 架构

Monorepo 使用 pnpm + Turborepo + 严格 TypeScript。Web 是 Next.js App Router/React 19；公开文章与热榜走 SSR，编辑器和 Agent 工作台走 Client Components。API 是 NestJS + Fastify；Agent Worker 和异步索引/媒体 Worker 独立部署。PostgreSQL/pgvector 是业务与 Agent 状态唯一事实源，Kafka 承载 transactional outbox/inbox 的持久异步事件，Redis 只承担租约、限流、缓存、取消标记和 SSE 广播，MinIO 保存图片对象，Logto 提供身份边界。

Pi `@earendil-works/pi-agent-core@0.82.1` 是唯一 Agent Core，隐藏在 `PiRuntimeAdapter` 后。一次 Root Request 由 Main Agent 拥有一个 Run；复杂请求持久化 Execution Plan，按最小权限 Context Pack 并行调度 Researcher、Writer、Editor、Fact Checker、Illustrator。工具调用有固定版本、schema、精确参数审批和执行账本；不确定副作用进入 `outcome_unknown`，不会自动重试。Agent、计划、任务、上下文、记忆、Evidence、Checkpoint、SSE 事件和用量都落 PostgreSQL，Worker 崩溃后从稳定事实恢复。

编辑器使用 Tiptap/ProseMirror，保存 `updateId + baseRevision + writerLeaseId` 的 step batch，服务端 ACK 前的步骤存 IndexedDB。文章修改使用稳定 `blockId + expectedHash` 提案，预览显示红删绿增，支持逐项/全部接受拒绝和过期检测。发布生成不可变 Edition；Kafka 聚合赞踩与去重阅读形成 24 小时/7 天热榜。

## 复用与来源

本项目遵循“能复用就复用，不重复造轮子”：通用 Agent 对话使用成熟 `assistant-ui`，编辑器使用 Tiptap，Pi MCP 生命周期和输出防护、Pi Web SSRF 防护、Oh My Pi hash-anchor 等均按不可变 commit 复制或适配，并放在 AgentPress adapter 后。每个来源、许可证、上游路径、本地路径和修改内容记录在 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与 [docs/references/pi-ecosystem.md](./docs/references/pi-ecosystem.md)。

## 交付证据

- 100,000 字中文编辑器基准：约 300,085 bytes 文档，插入 `0.57 ms`，序列化 `0.17 ms`，Node 堆 `13.92 MB`。
- 本地 Agent API/SSE 基准：100 个 Run、1000 个 SSE 客户端；Run 入队 p50/p95/p99 为 `262.74/355.13/355.57 ms`，SSE 建连 p50/p95/p99 为 `684.75/2138.26/2163.62 ms`。这是当前开发机实测，不是生产 SLO。
- `pnpm local:prepare` 已验证连续运行幂等；Redis/Kafka 停止、等待五秒、重新启动并通过 Compose healthcheck 的故障演练已验证。
- `kubectl kustomize infra/production/kubernetes` 可生成生产形状清单；Dockerfile 提供 web/API/两个 Worker 四个 target。生产部署仍需自行提供数据库、Kafka、Redis、对象存储、OTLP Collector、Ingress TLS 和 Secret。

## 文档入口

- [PLAN.md](./PLAN.md)：产品范围、里程碑和验收门禁。
- [docs/agent-runtime-spec.md](./docs/agent-runtime-spec.md)：Agent 状态、计划、工具、恢复和上下文契约。
- [docs/performance.md](./docs/performance.md)：基准方法、原始指标和解释。
- [docs/operations.md](./docs/operations.md)：本地部署、观测、故障恢复和生产清单。
- [infra/production/README.md](./infra/production/README.md)：容器与 Kubernetes 使用边界。

## 许可证与边界

根项目使用 AGPL-3.0-only；复制的上游代码保留其许可证和版权声明。InkOS 衍生代码只有在履行 AGPL 源码义务并重新完成商业分发评估后才能使用。生产 IaC 是设计交付，不代表已在公网或中国大陆部署；当前版本也不包含内容合规、备案、审核或运营保障。
