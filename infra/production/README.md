# Production Shape

这里的 Dockerfile 和 Kustomize 是可审计的生产形状样例，不是已部署环境。它们假定外部平台提供 PostgreSQL/pgvector、Kafka、Redis、S3 兼容对象存储、Logto、OTLP Collector、Ingress Controller、TLS 和备份。

```bash
docker build -f infra/production/Dockerfile --target web -t agentpress-web:local .
docker build -f infra/production/Dockerfile --target api -t agentpress-api:local .
kubectl kustomize infra/production/kubernetes
```

发布前替换 Kustomize 中的镜像仓库/tag，创建 `agentpress-secrets`，先运行迁移 Job，再滚动 Web、API 和两个 Worker。详见 [docs/operations.md](../../docs/operations.md)。
