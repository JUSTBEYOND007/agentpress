# Agent Runtime Specification

This specification defines AgentPress behavior around Pi Agent Core. Domain language is defined in `contexts/agent-runtime/CONTEXT.md`; PostgreSQL records described here are the product source of truth.

## 1. Invariants

- One Root Request creates exactly one Agent Run owned by the Main Agent; Steering Instructions attach to it and Follow-ups create later runs.
- One Conversation branch has at most one active Agent Run.
- A Specialist is stateless, receives one immutable Context Pack, returns one Task Result, and never owns a Conversation.
- Specialists never delegate or communicate directly with each other; the Main Agent is the only planner and scheduler.
- Direct Runs cannot retrieve, call external tools, delegate, or change an Article.
- Planned Runs expose plans, task status, tool activity, evidence, and result summaries, but never private chain-of-thought.
- PostgreSQL is authoritative; Redis broadcasts transient state and Kafka transports durable asynchronous commands/events.

## 2. Runtime Objects

- `Conversation`: branchable message history; each branch serializes Agent Runs.
- `AgentRun`: user request, owner, active plan revision, model/config snapshot, quota reservation, status, and final outcome.
- `ExecutionPlan`: immutable DAG of Agent Tasks and dependency edges.
- `AgentTask`: objective, Required/Optional criticality, Acceptance Criteria, owner, dependencies, output schema, tool policy, budget, and status.
- `TaskBrief`: immutable objective and constraints passed to a Specialist.
- `ContextPack`: immutable references, hashes, selected context, Skill versions, tool allowlist, and budget for one task.
- `TaskResult`: schema-validated status, Artifacts, Evidence, Usage, warnings, and structured failure.
- `ToolCall`: versioned tool identity, exact arguments, risk, idempotency key, approval, execution state, output, and side-effect record.
- `Checkpoint`: active plan, settled task/tool states, stable messages, usage, and continuation cursor.

## 3. Run Selection And Planning

- The runtime classifies a request before model execution. Requests needing retrieval, tools, delegation, or article changes are always Planned Runs.
- A Direct Run creates no Agent Tasks. If it discovers that a tool or retrieval is required, it transitions through planning and becomes a Planned Run before continuing.
- A Planned Run persists its Execution Plan before scheduling work. Plans expose goals, dependencies, owners, expected Artifacts, and progress summaries.
- Replanning creates a Plan Revision. Completed tasks remain immutable; superseded pending tasks become `skipped` with a reason.
- The Main Agent may schedule at most 12 tasks per run and 4 tasks concurrently. Specialists cannot create child tasks.

## 4. Failure And Degradation

- Every task is Required or Optional and has deterministic Acceptance Criteria evaluated after output-schema validation.
- A failed Optional Task is retained as a failed Task Result. The Main Agent may revise the plan and finish as `completed_with_degradation`.
- A failed Required Task receives at most two retries only when the model/tool operation is idempotent and budget remains.
- A configured fallback may replace a failed Required Task through a Plan Revision.
- Missing user input, credentials, or approval moves the run to `waiting_for_user`.
- A run becomes `failed` only when a Required Task has no recovery path, including a hard limit reached before Required Task Acceptance Criteria are satisfied.
- Final synthesis names all failed, skipped, fallback, or unverified work.

## 5. State Machines

Agent Run states:

```text
queued -> planning -> running
running <-> waiting_for_approval
running <-> waiting_for_user
running -> completed | completed_with_degradation | failed
queued | planning | running | waiting_* -> cancelling -> cancelled
planning | running | waiting_* -> interrupted -> recovering -> planning | running | waiting_for_user | failed
```

Agent Task states:

```text
pending -> ready -> running -> succeeded | failed
pending | ready -> skipped | cancelled
running -> waiting_for_approval -> running | failed | cancelled
running -> interrupted -> ready | failed
```

Tool Call states:

```text
proposed -> awaiting_approval -> approved | denied | expired
proposed | approved -> executing -> succeeded | failed | outcome_unknown
proposed | awaiting_approval | approved -> cancelled
```

Terminal states are immutable. Corrections create a new attempt linked to the previous record.

## 6. Context Assembly

- Each model call persists a `ContextManifest` containing included entity IDs, revisions/hashes, token counts, dropped candidates, Skill versions, and retrieval query/version.
- Authority order is: platform policy, Agent role/output schema, active plan/task, tool/approval policy, current user or Steering Instruction, bound Mentions/article revision, accepted memory, Evidence/RAG, conversation summary/recent messages, previous Task Results.
- Retrieved pages, files, MCP content, and tool output are marked untrusted data and cannot change policy, permissions, tool schemas, or output requirements.
- Reserve 20% of the model context window for output. Allocate the remaining input budget approximately as 10% policy/task, 20% conversation/steering, 30% article/Mentions, 30% Evidence/RAG, and 10% memory/prior Artifacts.
- Under pressure, drop low-ranked memory and Evidence first, then compact old conversation. Never truncate policy, the current user instruction, Task Brief, output schema, or approval constraints.
- The current Article revision is read directly; asynchronous RAG is never treated as fresher than the bound revision.

## 7. Steering, Follow-ups, And Cancellation

- A message sent while a branch has an active run is explicitly recorded as either a Steering Instruction or a Follow-up.
- Steering is applied at the next safe boundary, cancels only unsettled tasks, and creates a Plan Revision. It never mutates a running Specialist's Context Pack.
- Follow-ups are FIFO and create new Agent Runs after the active run reaches a terminal state.
- Cancellation stops new scheduling, aborts model streams, and requests cancellation from running tools.
- A side-effecting Tool Call already executing must settle as succeeded, failed, or outcome_unknown before the run can become cancelled.

## 8. Tools And Approvals

- Every registered tool declares `toolId`, version, owner, input/output schemas, risk, side-effect class, idempotency behavior, timeout, cost estimator, and audit redaction rules.
- Effective access is the intersection of platform policy, workspace policy, Agent policy, Skill allowlist, Task allowlist, and remaining quota.
- Read-only tools may run automatically. Draft proposal tools may run automatically, but applying a proposal follows the configured article-write mode.
- Cross-article changes, publishing, deletion, external writes, and image generation require explicit Approval.
- Approval binds the exact tool version, argument hash, displayed side effect, estimated cost, user, and expiry. Any argument change invalidates it.
- Each side-effecting call writes an execution ledger before dispatch and uses a stable idempotency key when the provider supports one.
- Provider ToolCall preparation and schema failures are also persisted as failed ToolCall ledger entries before the Run settles. They consume a host-owned repair budget of two attempts; exhaustion is a non-retryable protocol terminal and cannot open another Specialist repair session.
- `outcome_unknown` is never automatically retried. Reconciliation or user review must settle it first.

## 9. Specialist Contracts

| Specialist   | Primary inputs                                       | Allowed capabilities                           | Required Task Result                                            |
| ------------ | ---------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Researcher   | Research question, selected sources, citation policy | RAG, Web Research MCP, Workspace Knowledge MCP | `EvidenceBundle`, research summary, unresolved questions        |
| Writer       | Outline, Evidence, style constraints, target blocks  | Read context, draft generation                 | `ArticleDraft` or `EditProposal` Artifact                       |
| Editor       | Bound Article revision, editing brief, style Skill   | Read article and Evidence                      | `EditProposal`, issue list, rationale summaries                 |
| Fact Checker | Extracted claims and Evidence                        | RAG, Web Research MCP                          | `ClaimReview` with supported, uncertain, or contradicted status |
| Illustrator  | Article brief, visual intent, asset policy           | Licensed Media MCP; approved image generation  | `ImagePlan` and `AssetProposal`                                 |

No Specialist may apply an Article change or write long-term memory directly.

## 10. Memory, Skills, Mentions, And Retrieval

- Conversation summaries are generated as compaction Artifacts. Workspace facts and user preferences enter long-term memory only as user-visible Memory Candidates.
- The Main Agent proposes, accepts user decisions, retrieves, and cites memory. Specialists receive only accepted memory selected into their Context Pack.
- Skills are declarative and versioned. A run pins Skill versions at start; a Skill may narrow tools but cannot broaden policy or permissions.
- Mention resolution performs authorization first, then binds an immutable revision/hash. Deleted or inaccessible targets fail before planning.
- RAG results retain source, chunk, revision/hash, retrieval score, rerank score, and citation mapping. Claims without supporting Evidence are labelled uncertain.

## 11. Pi Integration And Recovery

- `PiRuntimeAdapter` creates ephemeral Pi Agent instances from AgentPress state and maps Pi model/message/tool events into stable product events.
- Pi types, session storage, and event names do not cross the adapter boundary.
- Token deltas are coalesced for SSE and are not Kafka events. Stable message snapshots are persisted periodically and at every safe boundary.
- Checkpoints are written after plan acceptance/revision, every settled Task Result, every settled side-effecting Tool Call, and final message completion.
- A worker uses a renewable lease. Lease loss stops scheduling; another worker reconstructs from the last Checkpoint.
- Provider streams are not resumed byte-for-byte. Recovery creates a continuation from stable messages and marks the interrupted attempt.
- Redis loss may delay live updates but cannot lose run state. Kafka backlog may delay queued/async work but cannot corrupt an active run.

## 12. Events And User Visibility

- Durable Run Events use a per-run monotonically increasing sequence and support SSE replay with `Last-Event-ID`.
- Required event families are run lifecycle, plan revision, task lifecycle, Specialist summary, tool proposal/approval/result, Evidence added, usage changed, warning, and final outcome.
- The default UI shows the plan, current task, Specialist ownership, approvals, citations, retries, degradation, and cost summary.
- Technical details are expandable. Private chain-of-thought, hidden provider prompts, credentials, and raw sensitive tool output are never exposed.

## 13. Quota And Hard Limits

- A run reserves estimated credits before planning and meters actual model, search, rerank, image, and tool usage.
- Exceeding the reservation may request more quota only at a safe boundary. Exhausted monthly quota prevents new work but preserves existing data and exports.
- Hard limits are 30 minutes per run, 12 tasks, 4 concurrent tasks, 20 model turns per task, 2 idempotent retries, and configured model/tool token and payload caps.
- Reaching a hard limit produces a disclosed partial/degraded result when Required Task criteria are still met; otherwise the run fails.

## 14. Evaluation Gates

- Maintain at least 40 versioned scenarios covering Direct/Planned routing, delegation, parallel tasks, citations, Skill/Mention binding, memory, approvals, steering, cancellation, crash recovery, and stale article edits.
- Deterministic tests must show zero unauthorized writes, zero automatic retries of Unknown Outcomes, and exact replay of durable state transitions.
- Live-provider evaluation must achieve at least 90% correct routing/delegation and 90% schema-valid Task Results across the curated scenarios.
- Citation evaluation requires every factual claim marked as sourced to resolve to stored Evidence; unsupported claims must be labelled uncertain.
- Memory evaluation measures accepted-memory precision and forbids retrieval across workspace boundaries.
- Fault-injection evaluation must recover without duplicating a confirmed side effect.
- PR checks use deterministic providers; real Doubao evaluations run manually or on a cost-controlled scheduled job and store model/config versions with results.

## 15. OSS Reuse Strategy

`docs/references/pi-ecosystem.md` is the reviewed source-of-truth for upstream pins, source paths, destinations, exclusions, licenses, and compatibility tests. Implementation is copy-first, not invention-first:

- Use official `@earendil-works/pi-agent-core@0.82.1` and `pi-ai` directly for the model loop, streaming, and tool execution. All events and types are translated by `PiRuntimeAdapter`.
- Adapt Oh My Pi's typed subagent contracts, hash-anchored edit defenses, proposal flow, checkpoint guards, tool harness, and related tests. Its Agent Core fork, TUI, filesystem session model, and process-control assumptions are excluded.
- Adapt InkOS's governed context assembly and writing-review-revision/recovery pipeline where AGPL obligations are satisfied. Port behavior and tests to the current official Pi API; never import its old Pi `0.67.1` integration layer.
- Adapt LLM Space's thread normalization, trace/replay presentation, run history, and evaluation utilities to AgentPress `RunEvent`, SSE, and PostgreSQL-backed history. Desktop storage and Tauri behavior are excluded.
- Adapt pi-mcp-adapter's lifecycle, reconnect, output-schema guards, and recovery tests to the three built-in MCP Servers. User-configured remote/stdio servers and coding-agent UI are excluded.
- Adapt pi-web-access's SSRF defense, HTML/PDF extraction, and source checks. Cookie extraction, local browser profiles, Git cloning, broad provider routing, and form execution are excluded.
- Use pi-skills examples to validate the AgentPress declarative Skill format and loader, but keep Skill versioning, permissions, and persistence product-owned.

Copied code must remain behind AgentPress-owned ports such as `PiRuntimeAdapter`, `McpServerPort`, `WebFetcher`, `ContextAssembler`, `EditProposalEngine`, and `RunEventNormalizer`. A source can accelerate implementation, but it cannot redefine the domain state machines, PostgreSQL authority, approval model, Context Pack isolation, or public API contracts.

No copied unit is accepted until it has an immutable upstream pin, preserved license/header, `THIRD_PARTY_NOTICES.md` entry, adaptation note, upstream-derived tests, and AgentPress boundary/regression tests. Upstream upgrades are explicit migrations, never floating dependency updates.
