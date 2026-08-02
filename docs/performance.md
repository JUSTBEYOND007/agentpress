# 性能报告

本文记录 2026-07-31 在本地开发机上的一次可复现实测。指标用于面试展示和回归比较，不是生产 SLO，也没有对网络、模型供应商或跨地域部署做结论。

## 编辑器

命令：

```bash
pnpm benchmark:editor
```

脚本使用 Tiptap StarterKit 的 ProseMirror schema，在一个空段落中插入 100,000 个中文字符，再序列化 JSON。实测结果：

```json
{
  "characterCount": 100000,
  "documentBytes": 300085,
  "insertMs": 0.58,
  "serializeMs": 0.16,
  "heapUsedMb": 13.63
}
```

该基准没有模拟浏览器布局、图片解码、网络自动保存或多个插件同时更新；需要将这些因素纳入浏览器性能预算后才能制定生产阈值。

## Agent API 与 SSE

基准先创建 100 个独立 Conversation/Branch，再并发调用 `POST /v1/conversations/:id/runs`，随后让 1,000 个客户端并发连接 `GET /v1/runs/:id/events`。运行前已启动 PostgreSQL、Redis、Kafka、MinIO 和 API；使用演示数据库，不调用真实模型。

```json
{
  "runCount": 100,
  "sseClients": 1000,
  "runEnqueueMs": {
    "p50": 144.75,
    "p95": 211.13,
    "p99": 212.98,
    "max": 212.98
  },
  "sseConnectMs": {
    "p50": 524.62,
    "p95": 1222.97,
    "p99": 2133.32,
    "max": 2144.36
  },
  "measuredAt": "2026-07-31T09:51:22.065Z"
}
```

运行命令：

```bash
set -a; source .env; set +a
BENCHMARK_BEARER_TOKEN="$YOUR_LOGTO_ACCESS_TOKEN" pnpm benchmark:agent
```

基准脚本明确要求一个短期 Logto access token，并沿用生产 API 的 JWT/工作区授权路径；不能通过关闭认证或伪造用户来获得性能数字。令牌只从环境变量读取，不写入输出。

限制：该脚本测量的是入队与 SSE 建连，不包含方舟 token 首字节、长连接持续时间、Kafka 重平衡或真实浏览器渲染。生产容量规划仍需按目标消息大小、模型延迟、数据库连接池、Kafka 分区数和 ingress timeout 重新压测。

## 关注点

- 长文章只在当前 revision 做必要注入，历史版本和 Evidence 通过 Context Pack 选择，避免无界上下文。
- Kafka 事件不承载 token delta、自动保存 ACK 或在线状态；Redis 广播只做瞬时协调，掉线后由 PostgreSQL + `Last-Event-ID` 重放。
- API、Agent Worker、异步 Worker 和 Web 可独立扩缩容；Kubernetes 基线提供 API HPA、PDB、readiness/liveness 和默认拒绝 ingress。
