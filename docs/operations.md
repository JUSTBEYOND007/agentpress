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

OTLP Collector、PostgreSQL/pgvector、Kafka、Redis、对象存储、Ingress Controller、TLS secret 和备份策略属于平台责任。迁移 Job 必须先成功，再滚动 API/Worker；生产环境应为 PostgreSQL 做 PITR，并为 Kafka topic 配置保留期、分区、DLQ 和告警。

验证清单：

```bash
kubectl kustomize infra/production/kubernetes >/dev/null
docker build -f infra/production/Dockerfile --target api -t agentpress-api:local .
pnpm check
```

当前仓库没有公网生产部署、内容审核、备案或业务连续性承诺。
