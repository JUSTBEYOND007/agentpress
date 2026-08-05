# Pi Ecosystem Reuse Matrix

Verified on 2026-08-05. AgentPress follows a reuse-first policy: use a maintained package directly when its public API fits; otherwise copy the smallest auditable module and its tests, adapt it behind an AgentPress-owned interface, and preserve provenance. Reimplementation is allowed only when no suitable implementation exists or when an upstream implementation violates the product's runtime, security, or persistence boundaries.

## Adoption Rules

1. Pin every direct dependency to an exact package version and lockfile integrity.
2. Pin every copied module to an immutable upstream commit, not a moving branch.
3. Add the upstream repository, commit, source path, license, and material changes to `THIRD_PARTY_NOTICES.md`.
4. Keep the upstream copyright/license header in every substantially copied file. Add an AgentPress adaptation note rather than replacing the original header.
5. Copy the relevant upstream tests first, then add adapter contract tests and AgentPress regression cases.
6. Place copied implementation behind an AgentPress interface. Upstream Pi types, file-based sessions, TUI state, and desktop assumptions cannot cross into domain or API packages.
7. Upgrade one source at a time. Re-run its contract suite, Agent Runtime state-machine suite, recovery tests, and affected eval scenarios before changing the pin.

Schema boundary decision: AgentPress keeps TypeBox as the single domain-contract authority. The
`packages/agent-runtime/src/schema-compatibility.ts` adapter creates a provider wire copy and
records dereference/normalization/degradation events. Decoded Specialist, Plan, Tool, MCP, Memory
Candidate, and Judge values share the no-coercion validator in `packages/schema-runtime`, which
directly uses pinned `typebox@1.1.38`, accepts both current Pi schemas and AgentPress's legacy
TypeBox-built domain schemas, and rejects unknown formats with structured paths. Zod remains
limited to the official MCP SDK adapter in `packages/mcp-runtime`; it is not exposed through
AgentPress contracts.

Prompt audit decision: AgentPress keeps prompt composition history in the existing PostgreSQL
`prompt_revisions` fact rather than adopting Oh My Pi's file/session prompt state. Each revision
records a versioned snapshot of template and variable-schema versions plus ordered block hashes;
the Run Context Pack continues to pin that immutable revision. Snapshot hashes detect composition
drift but do not grant capabilities, drive runtime state, or count as model-behavior evidence.

Eval dashboard boundary decision: the product API never exposes global eval identities. An
experiment may be attached to `eval_experiments.workspace_id`; report, Trial Trace, and regression
queries require both authenticated workspace membership and a matching persisted workspace owner.
Legacy or CLI experiments without an owner remain available to offline evaluation code but fail
closed at the product API. The web dashboard consumes `ExperimentStore` reports directly, so result
and process metrics, costs, failure categories, arm comparisons, and trends are not recomputed in
the browser. Trace remains diagnostic-only and is loaded separately from its redacted PostgreSQL
fact.

Eval trace capture decision: AgentPress does not trust a worker-supplied narrative as the complete
execution trace. Once the bound Agent Run is terminal, Trial settlement projects RunEvent,
Task/TaskResult, ToolCall/Approval, Evidence, Action/Edit Proposal, Batch, and operation-decision
facts directly from PostgreSQL and writes the redacted snapshot in the same settlement transaction.
Large or sensitive bodies such as tool arguments/output, evidence excerpts, and edit operations are
represented by existing or computed hashes plus status, version, count, and timing metadata. The
projection recursively redacts sensitive keys and common token shapes; a stale claim or nonterminal
Run cannot publish a diagnostic trace.

Specialist lifecycle decision: Oh My Pi's in-memory `AgentLifecycleManager` binds every park/revive
and late finalizer to the exact `AgentRef` that started it. AgentPress adapts that stale-owner
invariant at the durable boundary instead of copying sessions or timers: Task settlement is fenced
by the PostgreSQL `running` state and exact attempt number. A cancelled, recovered, or retried Task
therefore rejects a late worker result before writing TaskResult, Artifact, Checkpoint, or RunEvent.
Non-read-only Specialist ToolCalls additionally persist the Task attempt, an argument-signature
ordinal, and a host-generated logical-operation key. A replacement attempt rebuilds its ordinal
cursor from PostgreSQL: completed same-argument operations remain distinct, while an executing or
`outcome_unknown` operation pins that signature and fails closed for every new provider call ID.
Tool settlement uses a status compare-and-set so a late worker response cannot overwrite that
recovery fact. A key stored by AgentPress is not treated as proof that an external provider committed
the key atomically with its side effect; only read-only calls are automatically replayed after an
unscoped Run worker loss. Specialist provider thinking remains in its private persisted transcript;
the closed `task_complete` contract and Main synthesis projection pass only the public summary,
warnings/failure, Evidence, and Artifact summaries. PostgreSQL behavior tests assert the private
thinking marker is absent from TaskResult, the Main turn, and the Main transcript.
The source behavior is pinned at Oh My Pi commit `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`,
`packages/coding-agent/src/registry/agent-lifecycle.ts` and
`packages/coding-agent/test/registry/agent-lifecycle.test.ts`.

Provider dialect behavior is covered by `packages/agent-runtime/test/provider-schema-fixtures.test.ts`,
adapted from Oh My Pi's schema strict-mode/provider tests at immutable commit
`f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`. AgentPress keeps only boundary transformations needed
for its TypeBox contracts; the full Oh My Pi schema subsystem was not vendored because the pinned
Pi runtime already owns generic schema conversion and AgentPress also needs PostgreSQL-backed
facts and degradation audit events.

MCP reconnect behavior uses the official MCP SDK transport and adapts only the conservative
connection-error/single-retry and reconnect-storm contracts from Oh My Pi commit
`f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`. The local Gateway retries no model-visible tool step:
it remains inside one PostgreSQL-backed AgentPress ToolCall, retries only the three read-only
built-ins, preserves cancellation, and records a single settlement. OAuth, Smithery, stdio and
user-configured remote servers remain excluded.

Memory recall adapts Oh My Pi/Mnemopi's temporal, importance, diversity, validity and consolidation
behavior without copying its SQLite/episodic stores. AgentPress ranks only PostgreSQL accepted rows
after workspace/user/validity filtering, pins the selected IDs and retrieval version into the Run
Context Pack, and treats all memory text as untrusted. Consolidation produces a visible pending row
with immutable `source_memory_ids`; source rows become superseded only after user acceptance.
Mnemopi's English regex query-intent, episodic graph, entity/triple store and automatic memory writes
are rejected because they duplicate the fact model or bypass AgentPress approval boundaries.

8. Security-sensitive code such as URL validation, MCP lifecycle management, and edit application requires local review even when copied unchanged.

Compaction boundary decision: `packages/agent-context` directly imports the pure `shouldCompact`
threshold from official `@earendil-works/pi-agent-core@0.82.1` (upstream commit
`b4f293684bba718d59cc1157679bcf6157b3a7f5`,
`packages/agent/src/harness/compaction/compaction.ts`) and checks it against the pinned upstream
threshold behavior. AgentPress does not adopt Pi's file-backed SessionManager or CompactionEntry as
the fact source: manual and automatic compaction remain AgentPress commands that append versioned
PostgreSQL `ConversationCompaction` facts, and context projection reads only the branch-matched
effective successful version.

Mid-turn and overflow decision: AgentPress reuses official Pi's
`prepareNextTurnWithContext` hook so maintenance runs only after a complete ToolCall turn. The
runtime adapter projects the active Pi context into an AgentPress-owned snapshot; the application
maps that snapshot back to persisted `agent_transcript_entries` and appends an
`agent_session_compactions` version before returning a typed summary message to Pi. A provider
overflow is retained in the transcript, removed only from the active retry context, and retried at
most once after a compaction that proves a smaller serialized context. Failed/no-op compaction keeps
the original provider failure. Oh My Pi's remote compaction, JSONL SessionManager, snapcompact,
mnemopi, Bun/native and handoff reset paths were rejected because they either introduce a second
runtime/fact source or cannot preserve AgentPress PostgreSQL and ToolCall settlement boundaries.

Summary evaluation decision: `packages/agent-evals/src/compaction-scenarios.ts` owns the versioned
`agentpress-compaction-v1` dataset and deterministic scorer for fact retention, user intent,
unfinished actions, citations, branch isolation, and stale-state handling. The offline contract
suite and `compaction-online-cli.ts` consume the same cases instead of maintaining separate
fixtures. The scorer fails both missing protected facts and forbidden sibling-branch references;
the online run additionally compares task answers before and after compaction. Target-model results
remain an explicit external gate and are not inferred from the offline golden summaries.

## Reuse Matrix

| Source and pin                                                                                                                                                      | License       | Current decision                                                                           | Reviewed upstream paths                                                                                                                                                                                                                                    | Current local destination or boundary                                                                                                                                | Verification                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`earendil-works/pi`](https://github.com/earendil-works/pi), npm `@earendil-works/pi-agent-core@0.82.1`, tag `v0.82.1` (`b4f293684bba718d59cc1157679bcf6157b3a7f5`) | MIT           | Direct dependency; no source copied                                                        | Published `pi-agent-core` and `pi-ai` packages                                                                                                                                                                                                             | `packages/agent-runtime/src/pi-runtime-adapter.ts`, `packages/agent-runtime/src/current-turn.ts`, and `packages/agent-context/src/conversation-compaction-policy.ts` | Model/tool event mapping, abort behavior, streaming, current-turn protocol, compaction threshold, schema handling, and provider fixture contracts                          |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), `v17.1.8` (`f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`)                                                   | MIT           | Selected behavior/tests adapted; official Pi runtime retained                              | Schema, tool protocol/recovery, Task lifecycle, MCP reconnect, Mnemopi recall, Hashline, ToolChoiceQueue, and compaction paths recorded in `THIRD_PARTY_NOTICES.md`                                                                                        | Exact implementation and test paths are recorded per behavior unit in `THIRD_PARTY_NOTICES.md`                                                                       | Provider fixtures, tool/recovery invariants, Specialist boundaries, MCP reconnect, Memory recall, hash anchoring, durable tool choice, and PostgreSQL compaction contracts |
| [`Narcooo/inkos`](https://github.com/Narcooo/inkos), `v1.7.2` (`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`)                                                          | AGPL-3.0-only | Behavior and test reference only; do not copy source under the current distribution        | `packages/core/src/utils/context-assembly.ts`, `governed-context.ts`, `context-filter.ts`, `packages/core/src/pipeline/chapter-review-cycle.ts`, `chapter-state-recovery.ts`, `packages/core/src/interaction/action-envelope.ts`, plus corresponding tests | No copied destination; AgentPress-owned contracts and PostgreSQL adapters implement selected behavior independently                                                  | Verify behavior through AgentPress contract/integration tests; any future source reuse requires an explicit AGPL distribution decision                                     |
| [`deer-flow/llm-space`](https://github.com/deer-flow/llm-space), `v4.0.1` (`4a34cef4c8517eaf2371123e65dc7fb3373b7ebf`)                                              | MIT           | Candidate/reference only; no source or behavior adopted                                    | `packages/core/src/parsers/normalize-thread.ts`, `packages/core/src/thread/`, `apps/desktop/src/components/trace-panel/`, `thread-playground/run-trace-view.tsx`, `run-evaluation-utils.ts` and tests                                                      | None                                                                                                                                                                 | A future adoption must first copy behavior tests, remove Tauri/local-file assumptions, and record exact local paths in this matrix and `THIRD_PARTY_NOTICES.md`            |
| [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), `v2.15.0` (`e588296e28b36a22b081d40fcfba76f418d6f84e`)                                 | MIT           | Lifecycle and output-guard behavior/tests adapted; package rejected as a direct dependency | `server-manager.ts`, `mcp-output-guard.ts`, `__tests__/server-manager-reconnect.test.ts`, `__tests__/init-failure-state.test.ts`, `__tests__/mcp-output-guard.test.ts`                                                                                     | `packages/mcp-runtime/src/server-manager.ts`, `packages/mcp-runtime/src/output-guard.ts`, and corresponding tests                                                    | Official MCP SDK `1.30` conformance, lazy lifecycle, cancellation, output schema, hostile output, and deterministic recovery                                               |
| [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access), `v0.15.0` (`b537183632d555d1b2e61cb8f6bdf585766f2380`)                                   | MIT           | SSRF protection behavior/tests adapted; package rejected as a direct dependency            | `ssrf-protection.ts`, `test/ssrf-protection.test.mjs`                                                                                                                                                                                                      | `packages/web-research/src/ssrf-guard.ts`, `packages/web-research/test/ssrf-guard.test.ts`                                                                           | DNS rebinding and redirect checks, private/reserved IP denial, redirect count, content type, and payload limits                                                            |
| [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills), commit `90bb51cae36515a648515b633a81c0c6efc8c74d`                                                    | MIT           | Format/examples used as behavior reference; no executable source copied                    | Repository `SKILL.md` examples and README format/discovery conventions                                                                                                                                                                                     | `packages/agent-context/src/skill.ts`, `packages/agent-context/test/context.test.ts`, and `packages/agent-application/src/skill-preselection.ts`                     | Frontmatter diagnostics, precedence conflicts, static-resource integrity, untrusted projection, tool allowlist narrowing, prompt injection, and exact-revision selection   |

The executable, test-first adoption backlog for Oh My Pi is maintained in
[`docs/oh-my-pi-reuse-todo.md`](../oh-my-pi-reuse-todo.md). It is intentionally broader than the
current reuse row: every item remains a TODO until dependency reuse or copied behavior has passed the
license, adapter-boundary, PostgreSQL-authority, contract-test, and real-model gates recorded there.

Skill conformance now has an AgentPress-owned diagnostic boundary in
`packages/agent-context/src/skill.ts`: `validateSkillConformance` checks the standard `name`, parent
directory, description/compatibility lengths, frontmatter and instructions, while retaining Oh My
Pi's compatibility for unknown frontmatter fields and persisted `id` records. The companion
`discoverSkillsWithWarnings` reports malformed documents and precedence conflicts without hiding
them. `RunContextService` projects Skill instructions and static resources as
`trust="untrusted"`; permissions remain owned by the host Tool Registry, Run Skill Binding and
approval facts. Contract and prompt-injection fixtures are in
`packages/agent-context/test/context.test.ts`; real-model selection accuracy and disabled-skill
call-rate remain external evaluation gates.

The target-model Skill gate is exposed as `packages/agent-evals/src/skill-selection-online-cli.ts`
(`pnpm eval:skill`). It reuses the host-owned `PiSkillPreselector`, pins the five-case dataset
version, records exact-match and forbidden-selection metrics, and never treats a model-selected
identity as a permission grant. The command is intentionally separate from `eval:pr`; it requires
explicit online-model execution and a cost budget before its result can satisfy the real-model gate.

### MetaHarness behavior reference and independent adaptation

At `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`, MetaHarness declares benchmark-owned metric
definitions in `packages/metaharness/src/benchmarks.ts`, normalizes native traces into a common
shape, and compares arms using decided trials in `packages/metaharness/src/experiments.ts`.
The contracts are exercised by `packages/metaharness/test/benchmarks.test.ts` and
`packages/metaharness/test/experiments.test.ts`, including weighted metrics, in-flight cost
projection, and arm comparison behavior. AgentPress adopted those pure behaviors in
`packages/agent-evals/src/experiment-report.ts` and
`packages/agent-evals/test/experiment-report.test.ts`, while deliberately rejecting the upstream
filesystem/SQLite store: PostgreSQL `evalExperiments`, `evalArms`, `evalTrials`, and `evalRunTraces`
remain the only source of truth. The reviewed source is MIT licensed under the same Oh My Pi
copyright notice. No upstream source file or test was copied; the local report contract and tests
were implemented independently, so this is recorded as a behavior reference rather than vendored
code.

For the Tool protocol boundary, the pinned official Pi source at
`packages/agent/src/agent-loop.ts` (commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`) explicitly
converts `stopReason === "length"` ToolCalls into error ToolResults and never executes them;
the same source documents that `continue()` requires a final `user` or `toolResult` message.
AgentPress keeps that runtime behavior and adds `validateRuntimeHistory` in
`packages/agent-runtime/src/pi-runtime-adapter.ts` for PostgreSQL transcript recovery, where
missing, duplicate, mismatched, or non-object ToolCall arguments fail closed before provider I/O.

Oh My Pi's ToolChoiceQueue was verified at commit `f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`
in `packages/coding-agent/src/session/tool-choice-queue.ts` with contracts in
`packages/coding-agent/test/tool-choice-queue.test.ts`. AgentPress adopted the pure one-yield
queue and reject/requeue semantics in `packages/agent-runtime/src/tool-choice-queue.ts`, and
passes one host-owned choice through the official Pi provider stream adapter. The queue's durable
state is adapted to AgentPress rather than copying Oh My Pi's process-local callback ownership:
`packages/database/src/tool-choice-queue-store.ts` and `run_tool_choices` persist FIFO ordering,
single in-flight ownership, claim tokens, recovery counts, and terminal settlement. A shared Run
row lock orders queue claims against `run_directives`: pending steering suppresses the next choice,
while follow-up remains deferred and does not suppress the active Run. Only Main sessions consume
the queue; recovery requeues an in-flight item and invalidates the old token, and stale workers fail
closed. PostgreSQL and Direct Run integration tests cover concurrent enqueue, opposite directive
semantics, Specialist isolation, recovery, cancellation, and actual ToolCall-based settlement.

Oh My Pi's Vibe task lifecycle was verified at the same fixed commit in
`packages/coding-agent/src/vibe/runtime.ts` with behavior tests in
`packages/coding-agent/test/vibe/vibe-runtime.test.ts`: `yield` produces a structured Specialist
result, while `wait` returns the first settled session together with the sessions still running and
an explicit timeout outcome. AgentPress adapts this as PostgreSQL `TaskResult` settlement and the
read-only `AgentTaskWaitService`; it preserves requested Task order, waits for any matching attempt,
returns `settled`/`stillRunning`/`timedOut`, and propagates cancellation. It deliberately rejects the
upstream process-local session registry and timers. A succeeded or failed Task without a TaskResult
for the exact current attempt fails closed instead of being inferred from Prompt or transient state.
Run cancellation is similarly adapted as a PostgreSQL transaction: `cancelAgentRunTasks` changes
all non-terminal Tasks and releases active leases before the Run can settle, so a late worker cannot
turn a cancelled Task into a success. PostgreSQL integration tests now cover Task and ToolCall
attempt fencing, Unknown Outcome recovery, late settlement, and distinct repeated operations. Real
Kafka acceptance is fixed in `apps/agent-worker/test/task-recovery.integration.test.ts`: a consumer
claims attempt 1 and stops, lease recovery emits a new command, attempt 2 settles once when the same
recovery payload is delivered twice, and a command arriving after cancellation cannot revive the
Task or create a TaskResult. The production `task-command-handler.ts` owns payload parsing and inbox
facts while the existing PostgreSQL claim/settlement boundaries continue to own idempotency.
Expired detached leases are recovered by the production worker through
`requeueExpiredAgentTasks`: the Task transition to `interrupted` and its replacement
`task.execute` outbox message share one PostgreSQL transaction. Repeated scans cannot create a
second command for the same expired attempt, and the immutable Context Pack is reused by the next
claim instead of rebuilding model-visible state.

For Eval, AgentPress keeps Harbor's isolation boundary as a persisted descriptor and adds a
PostgreSQL Trial lease: `claimNextTrial` uses `FOR UPDATE SKIP LOCKED`, `settleTrial` requires the
exact claim token, and `failExpiredTrials` marks a lost attempt failed before `retryTrial` creates a
new Trial identity. This prevents a polluted attempt from reusing its object prefix or Kafka group;
container/schema/network enforcement remains an infrastructure acceptance gate.

## Primary Pi Business Reference

**Primary reference: [`Narcooo/inkos`](https://github.com/Narcooo/inkos) at release `v1.7.2`, commit `c7851b94ada27f2810b903e96d8fec6f33e5d9bc`.** This is the default upstream to inspect before changing AgentPress conversation-to-writing behavior, long-form writing orchestration, review, recovery, or session restoration. Other repositories in this document remain secondary references for narrower infrastructure concerns.

The selection is evidence-based rather than a popularity choice:

- Its product domain is the closest match: a shipped story and long-form content creation application, not a coding-agent shell or framework example.
- The pinned release publishes `@actalk/inkos-core@1.7.2`, has 38 GitHub releases, 291 test files in the release tree, and passed its release CI on Ubuntu and Windows across Node.js 20, 22, and 24, followed by package verification.
- The repository is active, unarchived, and had 8,612 stars and 1,622 forks when reviewed on 2026-08-02. These figures are supporting signals only; source and test evidence below is the adoption basis.
- Its `AGPL-3.0-only` license matches AgentPress's repository license. Copied code still requires immutable provenance, preserved notices, and an entry in `THIRD_PARTY_NOTICES.md`.
- Electric is the stronger secondary reference for durable event timelines and Pi adapters, but its agent subsystem is less mature as a product surface and is not a long-form writing application. It does not replace InkOS as the single business reference.

### Adoption map

| AgentPress concern                     | InkOS source and tests at the pinned commit                                                                                                                                                                                                     | Decision and adaptation boundary                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User intent and mutation authorization | `packages/core/src/interaction/action-envelope.ts`, `packages/core/src/agent/agent-session.ts`; `packages/core/src/__tests__/interaction-models.test.ts`, `agent-session.test.ts`, `instruction-adherence-boundary.test.ts`                     | Copy the structured `actionSource` + `requestedIntent` + validated `actionPayload` contract and host-side tool-table gating. Extend it so every AgentPress article mutation requires a matching current-turn capability; do not rely on natural-language keywords or prompt obedience. |
| Durable conversation restoration       | `packages/core/src/interaction/session-transcript-schema.ts`, `session-transcript.ts`, `session-transcript-restore.ts`; `packages/core/src/__tests__/session-transcript.test.ts`, `session-transcript-restore.test.ts`, `agent-session.test.ts` | Adapt committed-request filtering, tool-call/result repair, restore boundaries, failed-request exclusion, and cache invalidation. Store and project the facts from PostgreSQL `RunEvent` records rather than adopting InkOS JSONL/files as the fact source.                            |
| Review and revision loop               | `packages/core/src/pipeline/chapter-review-cycle.ts`; `packages/core/src/__tests__/chapter-review-cycle.test.ts`                                                                                                                                | Copy the behavior and tests for deterministic checks on every round, bounded revision, audit parse-failure fail-closed behavior, score comparison, and best-snapshot selection. Replace fiction-specific scoring and length rules with AgentPress article/evidence policy.             |
| State recovery and degraded output     | `packages/core/src/pipeline/chapter-state-recovery.ts`; `packages/core/src/__tests__/chapter-state-recovery.test.ts`                                                                                                                            | Copy the isolated settlement retry, revalidation, explicit degraded state, and freezing of previously valid facts. Map chapter truth files to AgentPress article versions, Context Packs, citations, and PostgreSQL checkpoints.                                                       |
| Context governance                     | `packages/core/src/utils/context-assembly.ts`, `governed-context.ts`, `context-filter.ts` and their tests                                                                                                                                       | Reuse selection, budgeting, and validation behavior behind `packages/agent-context/`. Preserve typed provenance and immutable Context Packs; do not copy the upstream conversion that presents injected book context as a new user message.                                            |

### Deliberate exclusions

- Do not copy InkOS's `@mariozechner/pi-agent-core@0.67.1` or `@mariozechner/pi-ai@0.67.1` integration. AgentPress remains on `@earendil-works/pi-agent-core@0.82.1` and ports only isolated business behavior behind its runtime adapter.
- Do not copy `isWriteNextInstruction`, `isExplicitWriteChapterCommand`, or any keyword matcher as the primary router. Keywords may normalize an already authorized UI command, but cannot grant mutation authority.
- Do not copy the active-book free-text tool table unchanged. At the pinned release it still exposes `sub_agent`, cover, truth-file, chapter patch/replace, and import tools to an ordinary book chat turn. AgentPress must gate article mutation tools by current-turn structured capability so a greeting cannot continue or rewrite an article.
- Do not copy file-based project/session persistence, TUI/desktop assumptions, or InkOS domain entities into AgentPress. PostgreSQL Conversations, Runs, Tasks, Tool Calls, Events, Checkpoints, article versions, and Edit Proposals remain authoritative.
- Do not copy `context-transform.ts` behavior that injects business context with user-message provenance. Projected context must remain distinguishable from the user's current request.

InkOS is mature enough to be the best available implementation reference by release discipline, test breadth, and business fit. It is still a relatively young project, so this designation is not a claim of multi-year operational history and does not waive AgentPress contract tests or real-model evaluation.

### Implemented InkOS behavior baseline

Implemented on 2026-08-02 without copying InkOS source code:

- `packages/agent-application/src/agent-turn-profile.ts` now derives a deterministic turn kind and exact Main control-tool table from the typed action envelope and frozen context manifest. A host-confirmed article edit bypasses Main planning and becomes one persisted editor task.
- `packages/agent-application/src/agent-session-runner.ts` owns Pi session creation, actual provider/model identity, transcript sequencing, steering, event projection, and settlement. PostgreSQL remains authoritative.
- `packages/agent-application/src/agent-transcript-projector.ts` restores completed attempts only, limits natural dialogue to 12 messages and tool state to 8 summaries, strips historical thinking/tool protocol, and adds an explicit historical-intent boundary.
- Conversation titles are generated deterministically by the host rather than through a synchronous model tool. The web composer no longer binds the active article by default.
- Successful article proposals and confirmed production results are terminal outcomes and do not force a redundant Main synthesis call.
- Online evals distinguish free-text proposals from confirmed mutation actions, require a successful terminal Run, isolate themselves from the command outbox, and support both Ark and the configured OpenAI-compatible Agent provider.

Verification at this baseline: Agent runtime/application/eval unit and type checks pass; 28 PostgreSQL application integration tests pass against the repository infrastructure. A real-model routing run correctly failed its gate because the configured Ark account returned `403 AccountOverdueError`; real target-model acceptance remains blocked until a working `AGENT_MODEL_*` or Ark credential is available and must not be represented as passed.

## Pi Business Architecture References

Surveyed on 2026-08-02. These repositories use Pi Agent Core inside working products rather than only exposing framework examples. They are architecture and test references until a concrete change promotes one into the reuse matrix above; promotion still requires a license audit and `THIRD_PARTY_NOTICES.md` entry when code is copied.

| Source and reviewed commit                                                                                                                    | License                                                                   | Verified business pattern                                                                                                                                                                                                             | Relevant source and test paths                                                                                                                                                                                               | AgentPress implication                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`electric-sql/electric`](https://github.com/electric-sql/electric), `c45e8b3a5eb00cf75869fdb2cb4c6bb953530a6a`                               | Apache-2.0                                                                | Durable state protocol and timeline projection around an ephemeral Pi Agent; event writes, tool calls, wake inputs, compaction and model errors are translated at an adapter boundary                                                 | `packages/agents-runtime/src/pi-adapter.ts`, `timeline-context.ts`, `outbound-bridge.ts`; `packages/agents-runtime/test/timeline-context.test.ts`, `pi-adapter.test.ts`, `record-run.test.ts`, `wake-session.test.ts`        | Prefer persisted timeline-to-message projection and adapter contracts over reconstructing intent with ad hoc prompt concatenation. Treat user inbox messages, wakes, runs and tool results as distinct durable facts.   |
| [`albinotonnina/echos`](https://github.com/albinotonnina/echos), `a71ee76c504528da26ebb68f4505289e3a87f626`                                   | MIT                                                                       | Knowledge and writing product using a typed custom Pi message plus `convertToLlm` to attach business context to the next user turn while keeping it distinguishable in agent history; tool-specific rules live with tool descriptions | `packages/core/src/agent/messages.ts`, `context-manager.ts`, `create-agent-tools.ts`, `system-prompt.ts`; `packages/core/src/agent/system-prompt.test.ts` and tool tests                                                     | Model context and user intent need distinct typed origins. Cross-cutting policy belongs in a small tested prompt; tool routing and mutation rules belong at tool/policy boundaries.                                     |
| [`understudy-ai/understudy`](https://github.com/understudy-ai/understudy), `820cac1a16eccbddb9fb5a433dba32cd55ce6778`                         | MIT                                                                       | Product runtime composes `beforePromptBuild`, `beforePrompt`, `beforeTool`, `afterTool`, `beforeReply` and `afterReply` policies around Pi tools and messages, with short-circuiting and ordered transformations                      | `packages/core/src/runtime/policy-pipeline.ts`, `policy-registry.ts`, `runtime/policies/`; `packages/core/src/__tests__/policy-pipeline.test.ts`, `guard-assistant-reply-policy.test.ts`, `route-retry-guard-policy.test.ts` | Put deterministic guards and transformations in a composable runtime policy layer instead of growing a monolithic executor or relying on prompt obedience.                                                              |
| [`steel-experiments/durable-researcher`](https://github.com/steel-experiments/durable-researcher), `6b5c912c19b5e6ed2f15a8d6e8ff840ac1451840` | No repository license detected; behavior reference only, do not copy code | Long-running Pi research is exposed as an idempotent asynchronous business Run with Postgres checkpoints, event projection, pause/resume/cancel/finalize transitions, bounded pulses and structured evidence                          | `src/service/research-service.ts`, `research-runs.ts`, `research-events.ts`, `message-projector.ts`, `campaign.ts`; `tests/research-service.test.ts`, `message-projector.test.ts`, `campaign.test.ts`                        | Preserve business Run ownership, idempotency and terminal-state guards outside Pi sessions. Rebuild derived research state through one projector shared by live handling and replay.                                    |
| [`badlogic/sitegeist`](https://github.com/badlogic/sitegeist), `104788c68e624a9705a9ee90f1d0b0176ad28747`                                     | AGPL-3.0                                                                  | Browser business events use custom agent message roles and a message transformer; UI-only messages are filtered, navigation context is translated deliberately, and tool-call/result adjacency is repaired before the model call      | `src/messages/custom-messages.ts`, `src/messages/message-transformer.ts`, `src/storage/stores/sessions-store.ts`, `src/tools/`                                                                                               | Context-producing system events must not masquerade as fresh user intent. Normalize message ordering and provenance before invoking Pi. Use as reference unless AGPL distribution requirements are explicitly accepted. |

## Current AgentPress Architecture Audit

Audited on 2026-08-02 against the business references above.

### Sound foundations

- The model loop uses exact `@earendil-works/pi-agent-core@0.82.1` and `@earendil-works/pi-ai@0.82.1` dependencies behind `PiRuntimeAdapter` instead of maintaining a second Agent Core.
- PostgreSQL Conversations, Runs, Tasks, Tool Calls, Events and Checkpoints remain the business source of truth. Pi sessions are reconstructed execution state rather than authoritative product state.
- Copied security, MCP lifecycle and edit anchoring code has immutable provenance and local verification recorded in `THIRD_PARTY_NOTICES.md`.
- Runtime adapter tests cover streaming, tool execution, cancellation, continuation and policy hooks; the online eval harness can run the real Pi runtime and target model without silently falling back to a faux backend.

### Gaps to close before further Agent behavior expansion

1. **Current-turn attribution is still a provisional, locally invented prompt protocol.** `packages/agent-application/src/current-turn-contract.ts` serializes the current request and frozen context into one `RuntimeRequest.prompt`. Its unit test asserts policy text rather than model behavior. Replace or refactor this contract around InkOS's structured action envelope and host-side tool gating, then use the typed custom-message/`convertToLlm` boundaries in EchOS and Sitegeist to preserve context provenance. The replacement must pass both greeting-after-writing and explicit-continuation scenarios through the real target model before the current contract is removed.
2. **Planning and execution are concentrated in one bespoke coordinator.** `packages/agent-application/src/planned-run-executor.ts` currently owns routing, plan submission, DAG persistence, Specialist execution, synthesis, recovery, policy hooks and transcript recording in roughly 1,700 lines. Further changes must first map these responsibilities to maintained upstream patterns: Electric for timeline projection/adapters, Understudy for composable runtime policies, and Durable Researcher for business Run lifecycle and replay projection. Do not grow this class with additional prompt clauses or state branches.
3. **Most deterministic tests stop below the semantic model boundary.** Application and runtime suites rely heavily on Pi's faux backend, while online model evals are a separate manual command requiring database and provider credentials. Agent behavior changes need a small mandatory real-model scenario set with persisted observations, prompt/model revision capture and explicit variance thresholds; faux tests remain necessary for state-machine determinism but are not sufficient for routing claims.
4. **The prior reuse matrix was component-oriented rather than product-oriented.** It covered the official runtime, MCP, web access, hash anchoring, writing and observability, but did not require comparison with complete Pi-based business products before inventing orchestration behavior. The `Agent Architecture Evidence Gate` in `AGENTS.md` and the business reference table above now close the documentation gap; future changes still need to enforce it in review and CI.

This audit does not authorize copying unlicensed or AGPL code into a differently licensed distribution. It identifies behavior and test references; each concrete reuse decision still follows the adoption rules and license boundaries above.

Tag hashes above are the checked-out source commits used for review. Where Git exposes a separate annotated-tag object, the checked-out commit is the provenance pin.

## Explicitly Excluded

- Do not depend on `@oh-my-pi/*` Agent Core alongside official `@earendil-works/pi-*`; two runtime type systems and event models would make recovery nondeterministic.
- Do not copy Pi coding-agent TUI, command palette, terminal process control, browser-cookie extraction, Git repository cloning, or desktop local-file persistence.
- Do not let an upstream session transcript become the source of truth. PostgreSQL AgentPress records and Checkpoints remain authoritative.
- Do not copy InkOS source under the current distribution, including its `@mariozechner/pi-*@0.67.1`
  integration layer. Its writing/context behavior is reference material for independent AgentPress
  contracts on the pinned official Pi runtime.
- Do not expose arbitrary remote or stdio MCP configuration in the first release. Only the three built-in MCP Servers in the Agent specification are available.
- Do not apply Oh My Pi's line-oriented patch format directly to Tiptap documents. Preserve its hash-anchor and stale-input defenses while emitting AgentPress `EditProposal` operations over stable block IDs.
- Do not import provider lists, credential discovery, browser profiles, or local environment scanning from web-access packages.

## Planned Provenance Record

Each copied unit must produce an entry shaped like:

```text
Component: MCP output guard
Upstream: https://github.com/nicobailon/pi-mcp-adapter
Commit: e588296e28b36a22b081d40fcfba76f418d6f84e
Source paths: mcp-output-guard.ts, __tests__/mcp-output-guard.test.ts
Local paths: packages/mcp-runtime/src/output-guard.ts, packages/mcp-runtime/test/output-guard.test.ts
License: MIT
Changes: coding-agent/TUI lifecycle removed; TypeBox schemas and AgentPress ToolCall limits added.
Verification: upstream-derived tests + AgentPress hostile-output and recovery cases.
```

The pull request that introduces copied code must update this matrix if the actual upstream path, local destination, pin, or decision differs.
