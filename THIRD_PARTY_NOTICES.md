# Third-Party Notices

AgentPress uses and adapts open-source software. Exact installed dependency versions are
recorded in `pnpm-lock.yaml`; reviewed Pi ecosystem sources and immutable pins are recorded in
`docs/references/pi-ecosystem.md`.

## Direct Dependencies

- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` — MIT
- Next.js and React — MIT
- NestJS and Fastify — MIT
- Drizzle ORM — Apache-2.0
- KafkaJS 2.2.4 — MIT; patched locally to clamp empty request-queue timers for Node 24 compatibility
- OpenTelemetry JS Node SDK, OTLP HTTP exporters, Node auto-instrumentations and semantic conventions — Apache-2.0
- ioredis — MIT
- Tiptap and ProseMirror — MIT
- assistant-ui — MIT
- Model Context Protocol TypeScript SDK — MIT
- YAML — ISC
- unpdf — MIT; used as a pinned dependency for bounded server-side PDF text extraction
- fast-xml-parser 4.5.7 — MIT; used directly to parse bounded Google News RSS responses

OpenTelemetry packages are used directly from their published npm releases; no source files
are vendored. Versions are pinned in `pnpm-workspace.yaml` and resolved in `pnpm-lock.yaml`.

## Vendored Or Adapted Sources

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

### InkOS Structured Action Envelope

- Upstream: `https://github.com/Narcooo/inkos`
- Commit: `c7851b94ada27f2810b903e96d8fec6f33e5d9bc` (`v1.7.2`)
- Source: `packages/core/src/interaction/action-envelope.ts`, `packages/core/src/agent/agent-session.ts`, `packages/core/src/__tests__/interaction-models.test.ts`, `packages/core/src/__tests__/agent-session.test.ts`
- Local: `packages/contracts/src/action-envelope.ts`, `packages/contracts/test/action-envelope.test.ts`, with host authorization adapters under `packages/agent-application/src/`
- License: AGPL-3.0-only, Copyright (c) 2026 InkOS contributors
- Changes: reduced the fiction workflow intent union to AgentPress article editing; adapted Zod validation to the repository's TypeBox contracts; replaced file/session ownership with PostgreSQL Root Request and Action Proposal facts; tightened free-text turns so they cannot carry confirmed capabilities.
- Verification: free-text isolation, complete confirmed payloads, host-issued action sources, exact capability grants, invalid/unknown intent rejection, and confirmed-action idempotency.

## Visual Reference

`docs/references/ui/notion-agent-editor-reference.png` is a user-supplied visual reference. It is
used only to guide layout and interaction density; AgentPress does not redistribute Notion assets,
branding, account information, or article content in the product.
