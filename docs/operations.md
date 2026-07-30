# 运行手册

## 本地演示

```bash
pnpm install
pnpm infra:up
pnpm demo:prepare
pnpm dev
```

停止：`pnpm infra:down`。`demo:prepare` 不覆盖已有 `.env`，只在缺失时复制 `.env.example`，随后等待 Compose healthcheck、运行迁移和幂等种子。演示固定 ID 便于前端连接同一文章、会话和分支。

真实 Agent Run 需要在 `.env` 中设置 `ARK_API_KEY` 和 `ARK_MODEL_PRO`；图片生成还需要 `ARK_IMAGE_MODEL`。Endpoint 默认为火山方舟兼容地址，可通过 `ARK_BASE_URL` 替换。Fake Runtime 只用于自动测试，不会被生产入口选择。

## 可观测性

默认 `.env.example` 使用 `OTEL_SDK_DISABLED=true`，因此本地没有网络 exporter 副作用。部署到 OTLP Collector 时设置：

```env
OTEL_SDK_DISABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability:4318
OTEL_SERVICE_VERSION=0.0.0
```

API、Agent Worker 和 Async Worker 启动前初始化 OpenTelemetry Node SDK，启用 Node 自动 instrumentation、OTLP HTTP traces/metrics，并附带 service name、version 和 deployment environment。关闭进程时会 flush SDK；应用日志仍由 pino 输出。

## 故障演练

以下脚本只允许操作当前 Compose 项目，并要求显式确认：

```bash
CONFIRM_LOCAL_FAULT_DRILL=1 node scripts/fault-drill.mjs redis
CONFIRM_LOCAL_FAULT_DRILL=1 node scripts/fault-drill.mjs kafka
docker compose ps
```

脚本停止组件五秒后重新启动，并等待该组件的 Compose healthcheck 通过。Redis 中的租约、缓存、取消标记和 SSE 广播是瞬时数据；真实状态必须从 PostgreSQL 恢复。Kafka 停机期间 outbox 保留未发布事件，恢复后 consumer 通过 inbox/eventId 幂等处理。未知副作用的 Tool Call 状态是 `outcome_unknown`，不得因 Worker 重启而自动重试。

数据库不可用时不应接受声称已保存的写入；自动保存客户端保留未确认 steps 到 IndexedDB，重新获得 writer lease 后以 base revision 做恢复或生成恢复副本。SSE 客户端使用 `Last-Event-ID` 请求 PostgreSQL 事件重放，不能把 Redis 广播当作历史事实。

## 生产 IaC

`infra/production/Dockerfile` 提供 `web`、`api`、`agent-worker`、`async-worker` 四个 target；Kustomize 清单包含 Deployment/Service、迁移 Job、Ingress、API HPA、Web/API PDB、readiness/liveness 和默认拒绝 ingress policy。清单是设计基线，不会自动创建外部依赖或公网 DNS/TLS。

部署前必须替换 `infra/production/kubernetes/kustomization.yaml` 中的镜像仓库和 tag，并创建 `agentpress-secrets`。至少需要：

- `DATABASE_URL`
- `REDIS_URL`
- `KAFKA_BROKERS`
- `S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`
- `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_MODEL_PRO`、`ARK_IMAGE_MODEL`
- `LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`
- `LOGTO_API_RESOURCE`（必须与 Logto API Resource identifier 完全一致）

Web 还需要构建时变量 `NEXT_PUBLIC_LOGTO_ENDPOINT`、`NEXT_PUBLIC_LOGTO_APP_ID` 和 `NEXT_PUBLIC_LOGTO_API_RESOURCE`。Logto SPA 必须登记实际 Web origin 为 Redirect URI、Post sign-out redirect URI 与 CORS origin。API 对除健康检查、公开文章、热榜、媒体读取和匿名阅读计数之外的路由统一执行 JWT 签名、issuer、audience 与过期时间校验。

OTLP Collector、PostgreSQL/pgvector、Kafka、Redis、对象存储、Ingress Controller、TLS secret 和备份策略属于平台责任。迁移 Job 必须先成功，再滚动 API/Worker；生产环境应为 PostgreSQL 做 PITR，并为 Kafka topic 配置保留期、分区、DLQ 和告警。

验证清单：

```bash
kubectl kustomize infra/production/kubernetes >/dev/null
docker build -f infra/production/Dockerfile --target api -t agentpress-api:local .
pnpm check
```

当前仓库没有公网生产部署、内容审核、备案或业务连续性承诺。

## 内容管理验收

应用数据库迁移并启动本地服务后，使用真实 Logto 测试账号完成以下路径：新建父目录与子目录、在指定目录创建文章、移动文章、查看版本、分别下载 Markdown/HTML/JSON、移入回收站并恢复。自动检查命令：

```bash
pnpm --filter @agentpress/database db:migrate
pnpm --filter @agentpress/api test
pnpm --filter @agentpress/web test
pnpm check
```

HTML 导出测试必须覆盖文本和属性转义、危险链接过滤；浏览器验收必须读取实际下载文件并确认标题存在，不能只检查按钮可见。

高级编辑器验收必须在真实登录后的新文章中插入任务清单和表格，等待“已保存”，刷新页面后再次断言 `taskList` 和 `table` 节点存在。共享 schema 的自动测试位于 `packages/editor-patch/test/autosave.test.ts`，新增客户端节点时必须先同步该 schema。

发布互动验收需创建全新 Edition，访问公开页后确认小时窗口内阅读只计一次，登录赞踩后确认事务返回的计数，再从文章发布记录撤回。撤回后直接请求 `/p/:slug` 必须立即返回 404；单篇公开文章使用 `no-store`，不得用 ISR 缓存延迟撤回生效。
