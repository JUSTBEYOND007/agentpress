# Third-Party Notices

AgentPress uses and adapts open-source software. Exact installed dependency versions are
recorded in `pnpm-lock.yaml`; reviewed Pi ecosystem sources and immutable pins are recorded in
`docs/references/pi-ecosystem.md`.

## Direct Dependencies

- `@earendil-works/pi-agent-core@0.82.1` and `@earendil-works/pi-ai@0.82.1` — MIT;
  upstream tag `v0.82.1`, commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Next.js and React — MIT
- NestJS and Fastify — MIT
- Drizzle ORM — Apache-2.0
- KafkaJS 2.2.4 — MIT; patched locally to clamp empty request-queue timers for Node 24 compatibility
- MinIO JavaScript client 8.0.6 — Apache-2.0; used directly for bounded evaluation-prefix lifecycle
- OpenTelemetry JS Node SDK, OTLP HTTP exporters, Node auto-instrumentations and semantic conventions — Apache-2.0
- ioredis — MIT
- Tiptap and ProseMirror — MIT
- assistant-ui — MIT
- Model Context Protocol TypeScript SDK — MIT
- YAML — ISC
- unpdf — MIT; used as a pinned dependency for bounded server-side PDF text extraction
- fast-xml-parser 4.5.7 — MIT; used directly to parse bounded Google News RSS responses

### Official Pi Runtime

- Upstream: `https://github.com/earendil-works/pi`
- Package: `@earendil-works/pi-agent-core@0.82.1`, `@earendil-works/pi-ai@0.82.1`
- Commit: `b4f293684bba718d59cc1157679bcf6157b3a7f5` (`v0.82.1`)
- Source: published `packages/agent/` and `packages/ai/` packages
- Local: `packages/agent-runtime/src/pi-runtime-adapter.ts`,
  `packages/agent-runtime/src/current-turn.ts`,
  `packages/agent-context/src/conversation-compaction-policy.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner
- Changes: no upstream source copied; the packages are direct dependencies behind AgentPress
  current-turn, provider, PostgreSQL transcript, and compaction adapters.
- Verification: streaming/event mapping, ToolCall protocol, abort, history validation, schema
  adaptation, current-turn conformance, mid-turn compaction, and provider fixtures.

OpenTelemetry packages are used directly from their published npm releases; no source files
are vendored. Versions are pinned in `pnpm-workspace.yaml` and resolved in `pnpm-lock.yaml`.

Docker Engine/CLI, PostgreSQL, KafkaJS and the MinIO client are composed directly by
`packages/agent-evals/src/docker-sandbox-runner.ts` and `sandbox-resources.ts`; no Harbor source is
copied. Harbor remains an architecture-only reference because its source license could not be
confirmed. The Docker acceptance fixture uses an immutable image digest and does not redistribute
the image.

## Agent Skills Conformance Reference

- Upstream: `https://github.com/badlogic/pi-skills`
- Commit: `90bb51cae36515a648515b633a81c0c6efc8c74d`
- Source: repository `SKILL.md` examples and `README.md` Skill format/discovery conventions
- Local: `packages/agent-context/src/skill.ts`, `packages/agent-context/test/context.test.ts`
- License: MIT, Copyright (c) 2024 Mario Zechner
- Changes: no executable source copied; added a small AgentPress-owned conformance diagnostic and
  warning adapter, retained old `id` compatibility, and added untrusted Skill/resource boundary
  tests. The upstream examples are used as fixtures/reference only.
- Verification: standard frontmatter diagnostics, precedence conflicts, static resource hashing,
  untrusted prompt projection, tool allowlist narrowing, and prompt-injection fixtures.

## Adapted Behavior And Source References

### Oh My Pi Provider Schema Behavior Fixtures

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/ai/src/utils/schema/`, `packages/ai/test/schema-strict-mode.test.ts`,
  `packages/ai/test/openai-tool-strict-mode.test.ts`,
  `packages/ai/test/google-tool-schema.test.ts`,
  `packages/ai/test/anthropic-tool-schema.test.ts`
- Local: `packages/agent-runtime/src/schema-compatibility.ts`,
  `packages/agent-runtime/test/schema-compatibility.test.ts`,
  `packages/agent-runtime/test/provider-schema-fixtures.test.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: re-expressed provider fixture behavior behind AgentPress's TypeBox-to-JSON-Schema adapter;
  retained no Oh My Pi runtime types and did not vendor its complete Schema subsystem.
- Verification: OpenAI strict optionality, Anthropic constraint descriptions, Google nullable/const,
  Ollama boolean/type arrays, MCP Zod enum cleanup, recursive refs, tuples, unions, and degradation facts.

### Oh My Pi Tool Protocol And Recovery Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/agent/src/agent-loop.ts`, `packages/agent/src/replay-policy.ts`,
  `packages/ai/src/utils/tool-call-loop-guard.ts`,
  `packages/coding-agent/src/session/turn-recovery.ts`,
  `packages/coding-agent/src/session/turn-persistence.ts`,
  `packages/agent/test/proxy-toolcall-partial-json.test.ts`,
  `packages/ai/test/tool-call-without-result.test.ts`,
  `packages/ai/test/duplicate-tool-results.test.ts`
- Local: `packages/agent-runtime/src/pi-runtime-adapter.ts`,
  `packages/agent-runtime/test/pi-runtime-adapter.test.ts`,
  `packages/tool-runtime/src/replay-policy.ts`, `packages/tool-runtime/test/replay-policy.test.ts`,
  `packages/agent-application/src/tool-call-service.ts`,
  `packages/agent-application/test/tool-call.integration.test.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: retained protocol guards and conservative recovery semantics; execution and settlement
  were rebuilt around official Pi, PostgreSQL ToolCall facts, approval, capability policy, task-attempt
  fencing, and host-generated logical operation keys.
- Verification: partial JSON never executes, malformed persisted histories fail closed, parallel calls
  settle once, approval continuation reuses facts, Unknown Outcome never retries, and stale Specialist
  settlement cannot overwrite recovery.

### Oh My Pi Specialist Task And Lifecycle Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/coding-agent/src/task/structured-subagent.ts`,
  `packages/coding-agent/src/task/spawn-policy.ts`, `packages/coding-agent/src/task/types.ts`,
  `packages/coding-agent/src/registry/agent-lifecycle.ts`,
  `packages/coding-agent/test/task/structured-subagent.test.ts`,
  `packages/coding-agent/test/task/spawn-policy.test.ts`,
  `packages/coding-agent/test/task/task-schema.test.ts`,
  `packages/coding-agent/test/registry/agent-lifecycle.test.ts`
- Local: `packages/agent-application/src/specialist-task-contract.ts`,
  `packages/agent-application/src/planned-run-executor.ts`,
  `apps/agent-worker/src/task-command-handler.ts`,
  `packages/agent-application/test/contracts.test.ts`,
  `packages/agent-application/test/direct-run.integration.test.ts`,
  `apps/agent-worker/test/task-recovery.integration.test.ts`,
  `packages/database/src/task-lease-store.ts`, `packages/database/test/postgres.integration.test.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: retained output-Schema precedence, bounded spawn/depth/concurrency and stale-owner behavior;
  removed subprocess, Worktree, local session and timer ownership; rebuilt lifecycle as PostgreSQL
  Task attempts, leases, Context Packs, TaskResults, checkpoints and transactional outbox commands.
- Verification: caller/agent/session Schema precedence, recursion and allowlist denial, bounded DAG,
  detached recovery, exact-attempt settlement, late-result fencing, private-thinking isolation and
  public-result projection, plus real Kafka worker disconnect/recovery, duplicate command and late
  cancellation delivery.

### Pi Web Access SSRF Protection

- Upstream: `https://github.com/nicobailon/pi-web-access`
- Commit: `b537183632d555d1b2e61cb8f6bdf585766f2380`
- Source: `ssrf-protection.ts`, `test/ssrf-protection.test.mjs`
- Local: `packages/web-research/src/ssrf-guard.ts`, `packages/web-research/test/ssrf-guard.test.ts`
- License: MIT, Copyright (c) 2025 Nico Bailon
- Changes: retained IP range, IPv4-mapped IPv6, DNS-answer and redirect defenses; removed desktop configuration and proxy exceptions; added injected DNS/fetch boundaries and AgentPress error contracts.
- Verification: literal/resolved private targets, mixed DNS, redirect-to-loopback, redirect limit, media type and payload limits.

### Pi MCP Adapter Lifecycle Tests

- Upstream: `https://github.com/nicobailon/pi-mcp-adapter`
- Commit: `e588296e28b36a22b081d40fcfba76f418d6f84e`
- Source: `server-manager.ts`, `mcp-output-guard.ts`, `__tests__/server-manager-reconnect.test.ts`, `__tests__/init-failure-state.test.ts`, `__tests__/mcp-output-guard.test.ts`
- Local: `packages/mcp-runtime/src/server-manager.ts`, `packages/mcp-runtime/src/output-guard.ts`, `packages/mcp-runtime/test/`
- License: MIT, Copyright (c) 2026 Nico Bailon
- Changes: reduced lifecycle to three in-process built-in servers; removed stdio, arbitrary remote configuration, OAuth and UI state; adapted guards to TypeBox and AgentPress Tool Registry.
- Verification: lazy coalesced startup, degraded recovery, deterministic close, schema mismatch, secret redaction and hostile output size.

### Oh My Pi MCP Reconnect Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
- Source: `packages/coding-agent/src/mcp/tool-bridge.ts`, `packages/coding-agent/src/mcp/manager.ts`, `packages/coding-agent/src/mcp/timeout.ts`, `packages/coding-agent/test/mcp-reconnect.test.ts`, `packages/coding-agent/test/mcp-reconnect-storm.test.ts`
- Local: `packages/mcp-runtime/src/client-gateway.ts`, `packages/mcp-runtime/src/server-manager.ts`, `packages/mcp-runtime/test/client-gateway.test.ts`, `packages/mcp-runtime/test/server-manager.test.ts`, `packages/mcp-runtime/test/streamable-http.integration.test.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: retained conservative connection-error classification, single tool-call retry, reconnect coalescing and storm circuit behavior; removed OAuth, Smithery, stdio, arbitrary server configuration and TUI lifecycle; integrated abort with AgentPress Tool Registry and compare-and-evict client generations.
- Verification: non-retriable errors, retry failure, abort-before-reconnect, concurrent stale-client failures, bounded reconnect probe, circuit cooldown and real Streamable HTTP restart with one successful server invocation.

### Oh My Pi Mnemopi Recall Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
- Source: `packages/mnemopi/src/core/beam/recall.ts`, `packages/mnemopi/src/core/polyphonic-recall.ts`, `packages/mnemopi/src/core/veracity-consolidation.ts`, `packages/mnemopi/test/weibull-mmr-intent.test.ts`, `packages/mnemopi/test/beam-consolidate-unit.test.ts`
- Local: `packages/agent-context/src/memory.ts`, `packages/agent-context/test/context.test.ts`, `packages/agent-application/src/run-context-service.ts`, `packages/agent-application/src/context-governance-service.ts`, `packages/database/src/memory-store.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: retained temporal/importance ranking, MMR diversity and immutable consolidation provenance; replaced SQLite/episodic/graph stores with workspace/user-scoped PostgreSQL candidates and explicit pending/accepted decisions; rejected keyword intent and automatic extraction writes.
- Verification: accepted-only retrieval, validity windows, user/workspace isolation, temporal ranking, diversity, pending consolidation, delayed supersession, tombstone provenance clearing and immutable Run Context binding.

### Oh My Pi Hashline Anchoring

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
- Source: `packages/hashline/src/format.ts`, `packages/hashline/src/snapshots.ts`, `packages/hashline/src/diff-preview.ts`, and corresponding tests
- Local: `packages/editor-patch/src/hash.ts`, `packages/editor-patch/src/proposal-engine.ts`, `packages/editor-patch/test/`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: replaced code-file line anchors and short xxHash tags with canonical Tiptap block JSON, stable block IDs, and SHA-256; retained snapshot preflight, stale-input rejection, atomic apply, and preview-first behavior.
- Verification: revision drift, block drift, atomic preflight, partial acceptance, structural inserts, ProseMirror step replay, and red-delete/green-insert diff output.

### Oh My Pi Tool Choice Queue Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/coding-agent/src/session/tool-choice-queue.ts`
- Tests: `packages/coding-agent/test/tool-choice-queue.test.ts`
- Local: `packages/agent-runtime/src/tool-choice-queue.ts`, `packages/agent-runtime/test/tool-choice-queue.test.ts`, `packages/database/src/tool-choice-queue-store.ts`, `packages/database/test/postgres.integration.test.ts`, `packages/agent-application/src/agent-session-runner.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: retained one-yield forced-choice ordering and steering/follow-up precedence; replaced process-local callback ownership with PostgreSQL FIFO facts, claim tokens, Main-session isolation, explicit recovery, terminal settlement, and the official Pi Runtime adapter.
- Verification: pure queue reject/requeue tests, provider first-request injection, actual ToolCall settlement, concurrent PostgreSQL enqueue/claim, opposite directive semantics, Specialist isolation, recovery token invalidation, and cancellation.

### Oh My Pi Conversation Compaction Behavior

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/agent/src/compaction/compaction.ts`, `packages/coding-agent/src/session/session-entries.ts`, `packages/coding-agent/src/session/session-context.ts`, `packages/coding-agent/src/session/session-maintenance.ts`
- Tests: `packages/agent/test/compaction-error-status.test.ts`, `packages/agent/test/tool-protection.test.ts`, `packages/coding-agent/test/compaction-serialization.test.ts`, `packages/coding-agent/test/compaction-lifecycle.test.ts`, `packages/coding-agent/test/agent-session-branching.test.ts`, `packages/coding-agent/test/agent-session-goal-midrun-compaction.test.ts`, `packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts`
- Local: `packages/database/src/conversation-compaction-store.ts`, `packages/database/src/agent-session-compaction-store.ts`, `packages/database/test/conversation-compaction.integration.test.ts`, `packages/agent-context/src/conversation-compaction-policy.ts`, `packages/agent-runtime/src/pi-runtime-adapter.ts`, `packages/agent-application/src/agent-session-compaction-service.ts`, `packages/agent-application/src/agent-session-runner.ts`, and corresponding tests
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: replaced JSONL session entries with branch- and Agent-Session-scoped append-only PostgreSQL facts; replaced entry IDs with stable message/transcript IDs and sequences; froze Conversation compaction in each Run Context Pack; reused official Pi `shouldCompact` and `prepareNextTurnWithContext`; retained incremental lineage, complete ToolCall/ToolResult cut boundaries, reserve provenance, one-shot overflow recovery, and failed-compaction records without replacing the last successful summary. Oh My Pi remote compaction, JSONL SessionManager, snapcompact and native/Bun paths were not adopted.
- Verification: schema/unit/type checks, branch isolation, incremental lineage, malformed or unresolved ToolCall fail-closed behavior, small-window keep-budget fallback, preflight overflow, provider-reported overflow retry-once, failed-compaction preservation, same-execute mid-turn continuation, and fresh PostgreSQL migration/integration tests.

### InkOS Structured Action Envelope Behavior Reference

- Upstream: `https://github.com/Narcooo/inkos`
- Commit: `c7851b94ada27f2810b903e96d8fec6f33e5d9bc` (`v1.7.2`)
- Source: `packages/core/src/interaction/action-envelope.ts`, `packages/core/src/agent/agent-session.ts`, `packages/core/src/__tests__/interaction-models.test.ts`, `packages/core/src/__tests__/agent-session.test.ts`
- Local: `packages/contracts/src/action-envelope.ts`, `packages/contracts/test/action-envelope.test.ts`, with host authorization adapters under `packages/agent-application/src/`
- License: AGPL-3.0-only, Copyright (c) 2026 InkOS contributors
- Changes: no InkOS source code or tests were copied because its AGPL-3.0-only license is not accepted
  for source reuse in the current distribution. AgentPress independently implemented a narrower
  TypeBox envelope from its own article-edit requirements after reviewing the typed-envelope behavior;
  PostgreSQL Root Request and Action Proposal facts own authorization and idempotency.
- Verification: free-text isolation, complete confirmed payloads, host-issued action sources, exact capability grants, invalid/unknown intent rejection, and confirmed-action idempotency.

### Oh My Pi MetaHarness Behavior Reference

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890` (`v17.1.8`)
- Source: `packages/metaharness/src/benchmarks.ts`,
  `packages/metaharness/src/experiments.ts`,
  `packages/metaharness/test/benchmarks.test.ts`,
  `packages/metaharness/test/experiments.test.ts`
- Local: `packages/agent-evals/src/experiment-report.ts`,
  `packages/agent-evals/test/experiment-report.test.ts`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: no upstream source or tests copied. AgentPress independently implemented the reviewed
  metric-definition, trace-normalization, decided-trial aggregation and arm-comparison behavior on
  PostgreSQL Eval facts; the upstream filesystem/SQLite store was rejected.
- Verification: weighted metric definitions, undecided-trial exclusion, cost projection, arm
  comparison, regression trend, result/process separation, and trace-diagnostic isolation.

## Dependency Versus Adaptation Decisions

- Official `@earendil-works/pi-*` is used directly because its maintained public runtime API fits the
  provider and Agent loop boundary. A second `@oh-my-pi/*` runtime is explicitly rejected.
- Oh My Pi is not a direct dependency because the candidate packages bind to its own Pi runtime,
  Bun/native modules, local JSONL/SQLite sessions, coding-agent tools and TUI state. Only fixed-commit
  pure behavior and tests listed above are adapted behind AgentPress interfaces.
- `pi-mcp-adapter` is not used directly because it exposes arbitrary remote/stdio/OAuth and desktop
  lifecycle surfaces. The bounded lifecycle/output behavior is adapted around the official MCP SDK
  and three host-owned in-process servers.
- `pi-web-access` is not used directly because its package includes desktop proxy/configuration and
  broader extraction behavior. Only the server-safe SSRF guard and tests are adapted; bounded HTML,
  RSS and PDF extraction stays in AgentPress-owned ports and pinned dependencies.
- `pi-skills` is a format/example reference rather than a runtime dependency; Skill persistence,
  permissions, resource integrity and model selection remain AgentPress-owned.
- InkOS and other AGPL sources are behavior references only. Unlicensed sources are likewise never
  copied. Electric, EchOS, Understudy, Durable Researcher, Sitegeist and Harbor remain architecture
  references unless a future change records a separate compatible-license adoption. MetaHarness is
  recorded above as an independently implemented behavior reference, not copied source.

## Visual Reference

`docs/references/ui/notion-agent-editor-reference.png` is a user-supplied visual reference. It is
used only to guide layout and interaction density; AgentPress does not redistribute Notion assets,
branding, account information, or article content in the product.
