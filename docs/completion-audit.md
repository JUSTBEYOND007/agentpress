# AgentPress 完成证据矩阵

本文件将 `PLAN.md` 的承诺映射到可复核证据。只有同时具备产品入口、持久化/执行路径、自动测试和运行验证的能力才标记为完成；仅有类型、表结构、测试 Fake 或设计文档不算完成。

| 能力                           | 产品入口                 | 持久化/执行                                                | 自动测试                   | 运行验证                          | 状态       |
| ------------------------------ | ------------------------ | ---------------------------------------------------------- | -------------------------- | --------------------------------- | ---------- |
| Logto PKCE 与工作区隔离        | Web 登录、受保护 API     | Logto JWKS、workspace membership                           | API auth tests             | 真实账号登录/刷新                 | 完成       |
| 文章创建与 Tiptap 编辑         | Web 工作台               | PostgreSQL revision、Redis 写租约、IndexedDB pending queue | editor unit/integration    | 创建、编辑、跨 TTL 续租、刷新恢复 | 完成       |
| 多轮会话恢复                   | assistant-ui thread      | PostgreSQL stable messages                                 | API controller tests       | 待真实 Agent 凭据复核内容恢复     | 部分完成   |
| Pi Direct/Planned Run          | Agent composer           | Pi adapter、Kafka command、PostgreSQL state                | runtime/application tests  | 缺少 Ark 凭据                     | 待在线验证 |
| 多 Agent、Steering、Follow-up  | Run inspector/composer   | Plan/Task/Directive/Checkpoint                             | application tests          | 缺少 Ark 凭据                     | 待在线验证 |
| 工具审批与文章 diff            | Agent workbench          | Tool ledger、Approval、EditProposal                        | tool/editor tests          | 缺少 Ark 凭据                     | 待在线验证 |
| MCP、联网研究、RAG             | Pi tools                 | MCP manager、SSRF guard、pgvector/FTS                      | package/integration tests  | 缺少 Ark 凭据                     | 待在线验证 |
| Mention、Skill、记忆           | Agent context controls   | pinned revision/hash、Skill binding、memory candidate      | context/API/DB integration | Skill 创建刷新、候选接受写库      | 完成       |
| 图文生成                       | Pi image tool            | Ark image、MinIO provenance                                | media tests                | 缺少 Ark 凭据                     | 待在线验证 |
| 不可变发布与热榜 SSR           | 发布弹窗、公开页、热榜   | Edition、Kafka ranking projection                          | publication integration    | 发布及两个 SSR 路由 200           | 完成       |
| 多级文件夹、回收站、版本、导出 | 内容树、回收站、版本弹窗 | PostgreSQL 目录/软删除/修订、Markdown/HTML/JSON 导出       | API/Web tests              | 登录后黄金路径与下载验证          | 完成       |
| 完整编辑器工具                 | 工具栏、命令菜单、目录   | 前后端共享 Tiptap schema、自动保存                         | 高级节点 step replay       | 表格/任务插入后刷新恢复           | 完成       |
| 公开页赞踩、阅读、撤回         | 公开页、发布记录弹窗     | reaction/view/outbox、幂等撤回                             | API/DB integration         | 赞同/阅读/撤回后 SSR 404          | 完成       |
| 在线 Agent Eval                | `pnpm eval:online`       | Pi Ark Runtime、预算/并发、JSON/JSONL 报告                 | 48 场景、严格 schema       | 缺少 Ark 凭据，命令拒绝 Fake 回退 | 待在线验证 |
| 可观测性、IaC、性能与故障演练  | 运维命令                 | OTel、Kubernetes manifests                                 | quality gate               | 部分本机报告                      | 部分完成   |

后续提交必须同步更新本矩阵，并在 `docs/operations.md` 记录可重复验证命令。
