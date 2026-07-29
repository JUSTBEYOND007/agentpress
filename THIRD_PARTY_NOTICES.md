# Third-Party Notices

AgentPress uses and adapts open-source software. Exact installed dependency versions are
recorded in `pnpm-lock.yaml`; reviewed Pi ecosystem sources and immutable pins are recorded in
`docs/references/pi-ecosystem.md`.

## Direct Dependencies

- `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` — MIT
- Next.js and React — MIT
- NestJS and Fastify — MIT
- Drizzle ORM — Apache-2.0
- Confluent Kafka JavaScript client — Apache-2.0
- ioredis — MIT
- Tiptap and ProseMirror — MIT
- assistant-ui — MIT
- Model Context Protocol TypeScript SDK — MIT
- YAML — ISC

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

### Oh My Pi Hashline Anchoring

- Upstream: `https://github.com/can1357/oh-my-pi`
- Commit: `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
- Source: `packages/hashline/src/format.ts`, `packages/hashline/src/snapshots.ts`, `packages/hashline/src/diff-preview.ts`, and corresponding tests
- Local: `packages/editor-patch/src/hash.ts`, `packages/editor-patch/src/proposal-engine.ts`, `packages/editor-patch/test/`
- License: MIT, Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük
- Changes: replaced code-file line anchors and short xxHash tags with canonical Tiptap block JSON, stable block IDs, and SHA-256; retained snapshot preflight, stale-input rejection, atomic apply, and preview-first behavior.
- Verification: revision drift, block drift, atomic preflight, partial acceptance, structural inserts, ProseMirror step replay, and red-delete/green-insert diff output.

## Visual Reference

`docs/references/ui/notion-agent-editor-reference.png` is a user-supplied visual reference. It is
used only to guide layout and interaction density; AgentPress does not redistribute Notion assets,
branding, account information, or article content in the product.
