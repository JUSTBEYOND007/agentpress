# AgentPress

AgentPress is a Pi Agent-driven long-form authoring workspace. The project is an interview-oriented
local demonstration with production-shaped service boundaries and infrastructure definitions.

## Prerequisites

- Node.js `>=22.19`
- pnpm `10.10.0`
- Docker with Compose v2

## Local Setup

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

The web workspace runs at `http://localhost:3000` and the API at
`http://localhost:4000/v1/health`.

## Workspace

- `apps/web`: Next.js workspace and public SSR surfaces
- `apps/api`: NestJS REST and SSE API
- `apps/agent-worker`: durable Agent Run execution
- `apps/async-worker`: indexing, media, and event consumers
- `packages/*`: domain, contracts, configuration, and shared infrastructure adapters

Product and runtime decisions live in `PLAN.md`, `contexts/`, and `docs/`.

## Current Status

The repository is under active implementation. Production deployment, content compliance, and
public Internet operation are not claimed.
