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

InkOS Action Envelope/tool-table decision: at fixed commit
`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`,
`packages/core/src/interaction/action-envelope.ts` defines typed `actionSource`,
`requestedIntent`, `actionPayload`, and requested Skill IDs. The authorization behavior is in
`packages/core/src/agent/agent-session.ts:createModeTools`; matching button/slash confirmations
replace the ordinary tool table with the single intent-specific production tool. Exact tool-table
contracts are in `packages/core/src/__tests__/agent-session.test.ts` (including confirmed book,
short-run, cover, and play cases). The Prompt-only checks in
`packages/core/src/__tests__/instruction-adherence-boundary.test.ts` are not treated as
authorization evidence.

AgentPress adopts that exact-table behavior without copying AGPL source. Its deliberately smaller
Action Envelope supports only `free_text` and server-built `button/article_edit`; InkOS slash,
quick-action, and fiction-specific intents are rejected because AgentPress has no corresponding
host surfaces. InkOS `requestedSkills` maps to immutable PostgreSQL Run Skill Bindings rather than
becoming an action capability. `AgentTurnProfile` intersects confirmed grants with the host Tool
Registry, workspace role, frozen article binding, and every pinned Skill allowlist.
`PlannedRunExecutor` maps a confirmed article turn deterministically to one bounded Editor Task;
the Specialist receives only `article.read_current`, `article.propose_edits`, and the closed
`task_complete` protocol tool, with no Main planning, research, Skill-selection, or arbitrary
control tool. The result remains an expiring EditProposal behind the editor settlement boundary
and never mutates the canonical Article Revision directly. Free-text article turns may create the
same reviewable proposal when the host has an editable article binding, but cannot carry confirmed
grants or directly settle article changes. PostgreSQL integration tests cover the single persisted
Task, exact confirmed tool table, and pending Proposal result; Action Envelope, capability
intersection, expiry, replay, and Skill narrowing have separate contract/integration coverage.

InkOS transcript restore decision: the same fixed InkOS commit models append-only
`request_started -> message* -> request_committed` JSONL events in
`packages/core/src/interaction/session-transcript-schema.ts` and restores only committed request
ranges in `session-transcript-restore.ts`. Its tests prove uncommitted exclusion, bounded natural
history, provider-independent ToolCall folding, old `use_skill` expiry, and model-dialect
adaptation. AgentPress adopts those behaviors behind PostgreSQL facts rather than copying the AGPL
JSONL store or its Pi message types.

| InkOS behavior                                                      | AgentPress mapping                                                                   | Decision and evidence                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_committed` gates replay                                    | `agent_sessions.status = completed` gates transcript projection                      | Completed attempts only; interrupted/failed attempts are excluded.                                                                                            |
| Monotonic transcript `seq`                                          | `agent_transcript_entries(session_id, sequence)` plus locked `next_sequence`         | PostgreSQL owns ordering; process-local/file locks are rejected.                                                                                              |
| Raw ToolCall/ToolResult history is repaired before provider replay  | Completed transcript tools fold into a provider-independent historical state summary | Only one-to-one, same-session, same-ID and same-tool pairs are retained; missing, orphan, duplicate and mismatched facts are omitted rather than synthesized. |
| Old `use_skill` content expires                                     | Current Run Skill Binding owns Skill instructions                                    | Historical Skill output becomes an `expired` status without replaying instructions.                                                                           |
| Thinking and production UI state are not restored as current intent | Natural assistant projection keeps text and model metadata only                      | Tool blocks, thinking, article-action presentation and Specialist-private attempts are removed.                                                               |
| Agent cache evicts on model/action/Skill changes                    | Each AgentPress attempt creates a fresh Pi runtime from a frozen Run Context Pack    | No in-memory Agent cache is reused; Run ID plus immutable Prompt/Skill/Context revisions bound projection caches.                                             |

Contract tests exercise the pure projector and PostgreSQL integration writes completed and
interrupted sessions with out-of-order inserts, valid pairs, orphan results, duplicate results and
legacy Skill guidance before calling the production restore path. Raw continuation of a currently
approved tool is a separate path: `PiRuntimeAdapter.validateRuntimeHistory` rejects missing,
duplicate or mismatched ToolResults before provider I/O, and ToolCall settlement remains owned by
the PostgreSQL ToolCall ledger.

InkOS pipeline/Specialist decision: InkOS `packages/core/src/agent/agent-tools.ts` exposes a
`sub_agent` facade over Architect, Writer, Auditor, Reviser, and Exporter pipeline owners. AgentPress
does not copy that process-local dispatcher. It maps the product behaviors into its existing
PostgreSQL Execution Plan and bounded Specialist catalog:

| InkOS owner                | AgentPress owner                     | Adoption boundary                                                                                     |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Architect                  | Main Agent plus strict `plan_submit` | Architecture is Run-level planning, not a recursively spawnable Specialist.                           |
| Writer                     | `writer`                             | Produces only `Outline` or `ArticleDraft`; article writes remain proposals.                           |
| Auditor                    | `fact_checker` plus `editor`         | Fact/citation review and prose/structure review are split so each receives narrower capabilities.     |
| Reviser                    | `editor`                             | May return only an `EditProposal`; canonical Article Revision settlement stays in editor-application. |
| Exporter                   | publication-application              | Export/publish is a deterministic application boundary, not a model-created Specialist.               |
| No direct InkOS equivalent | `researcher`, `illustrator`          | Retained for source-backed research and governed media workflows.                                     |

All roles are host enums. `plan_submit` limits a DAG to 12 tasks and validates unique keys,
dependencies, acyclicity, current-turn capabilities and per-role capability policy. Persisted Task
Briefs carry owner, objective, acceptance criteria, immutable dependency summaries, capability
allowlist, timeout, attempts and detached policy. `task_complete` has a strict global schema and a
second host-owned role-to-Artifact policy: Researcher=`ResearchBrief`,
Writer=`Outline|ArticleDraft`, Editor=`EditProposal`, Fact Checker=`ClaimReview`, and
Illustrator=`ImagePlan|AssetProposal`. A mismatched Artifact fails before Evidence validation or
TaskResult persistence.

Specialists receive no full Conversation or root request text. `specialistApplicationTurn` creates
an application-origin turn from only the persisted Task Brief and accepted upstream summaries;
article/tool access resolves through frozen Run bindings. Thinking stays in the private Specialist
transcript and only TaskResult, Evidence, Artifact, Usage, warnings or typed failure reach Main and
the consumer projection. Task attempts are fenced by PostgreSQL attempt plus lease token; waits,
cancellation, expired-worker requeue and synthesis use the existing Task/Outbox services. This
retains Oh My Pi's already-adopted lifecycle contracts and rejects a second InkOS `sub_agent` state
machine.

Plan-level boundedness is now enforced by the existing plan protocol rather than a new scheduler:
`validateSubmittedPlan` and `plan_revise` call `assertBoundedPlan`, which caps 12 tasks, six DAG
stages, four parallel layers, and 96,000 deterministic estimated Specialist tokens. Existing
acyclic dependency validation, Specialist recursion/depth policy, provider concurrency, attempt
budget, lease/fencing, cancellation, and late-result tests remain the enforcement points for their
respective concerns. The new limits are host policy, not model-provided values.

Context governance reuses `packages/agent-context/src/context-assembler.ts` and the existing
PostgreSQL Context Pack preparation path. Its deterministic kind/score ordering, required-item
authorization, accepted-memory filter, fixed input/output budget and dropped-item manifest were
already local behavior. The real gap was provenance detail: `ContextCandidate` and frozen manifest
entries now carry typed `origin`, `owner`, `revision`, `trust`, token cost, selection reason, and
truncation state. Run context still freezes article revisions, Evidence, attachments, Skills,
memory retrieval version and compaction before execution; current request remains a separate typed
runtime turn. Untrusted content is escaped and never becomes a capability or a new user message.

Skill behavior reuses the existing AgentPress `validateSkillConformance`, deterministic discovery
precedence, `loadStaticSkillResources`, `pinSkills`, `Run Skill Binding`, and `PiSkillPreselector`
paths. These were compared with InkOS registry/loader/`use_skill` source and tests at the fixed
commit. Explicit selections are preserved, model selection can only choose from the host catalog,
disabled/hidden entries are excluded, and `narrowSkillTools` intersects rather than expands the
host allowlist. Resource documents must be declared regular UTF-8 files under bounded per-file and
total-size limits; symlink/duplicate/unsafe paths fail closed. Run bindings pin revision/hash and
historical instructions are expired by transcript projection. The Composer projection already shows
the compact Skill identity while revision/hash/resource diagnostics remain persisted details. The
online `pnpm eval:skill` target-model gate remains intentionally unchecked until credentials and a
provider/model manifest are supplied.

Web Research retains the existing SSRF/DNS/redirect/media/size guards and built-in `web_research`
MCP route. `packages/web-research` now owns product enums, the typed ResearchBrief schema,
claim-to-Evidence validation, provider-neutral search/fetch/synthesis Ports, depth-specific query,
source, concurrency, byte and synthesis-token budgets, and canonical URL deduplication. Production
HTML extraction now directly depends on pinned `parse5@7.3.0` instead of InkOS-style regular
expression tag removal; PDF extraction continues through `unpdf@1.8.0`. Provider output remains
untrusted and must become Evidence before a ResearchBrief claim can cite it. Search provider fields
stay behind `runtime-tools`/MCP adapters and do not enter the domain contract.

The target-model workflow gate exposed a provider-adapter gap: the local Google News plus Chinese
Wikipedia implementation returned successful empty arrays for technical documentation queries, so
the Researcher repeated 8-12 searches and reached its runtime deadline while already emitting
`task_complete`. InkOS `v1.7.2` uses a Tavily adapter in
`packages/core/src/utils/web-search.ts` and a bounded query/fetch loop in
`packages/core/src/agents/researcher.ts`; it is AGPL behavior reference only. The compatible reuse
source is `pi-web-access v0.15.0` (`b537183...`), whose `anysearch.ts` and
`test/anysearch-provider.test.mjs` prove anonymous POST search, strict envelope validation, bounded
result counts, cancellation, HTTP failure, and optional credential redaction. AgentPress will copy
that narrow MIT adapter and its behavior tests behind the existing `runtime-tools` search Port. It
will not import pi-web-access's Pi Coding Agent/TUI peers, config command execution, browser cookies,
activity monitor, provider manager, or auto-routing. The provider result remains untrusted MCP
output, and zero results continue through the existing provider-neutral degraded Research policy.

MCP remains independent of InkOS, which has no MCP subsystem at the pinned release. AgentPress
continues to use the official TypeScript SDK through `packages/mcp-runtime`, with the three fixed
built-in servers only. Their tools register in the shared Tool Registry and therefore execute via
PersistentToolBridge, ToolCallService, capability, approval and settlement facts; Specialist and
Skill paths receive no alternate executor. Oh My Pi reconnect and pi-mcp-adapter output-guard
behavior remain pinned in their existing tests. Consumer projection shows typed goal/result facts
and keeps JSON-RPC, transport and raw guarded payloads in diagnostic detail.

Review/revision behavior was audited at the same fixed InkOS commit in
`packages/core/src/pipeline/chapter-review-cycle.ts` and
`packages/core/src/__tests__/chapter-review-cycle.test.ts`. The reusable contract is the order
`initial hard-length normalization -> deterministic surface checks -> model audit -> bounded
revision -> reassessment`, with parse failures failing closed, a pass requiring model pass plus
score >= 85 and a hard-length gate, and a material three-point improvement before a non-passing
revision can replace the current candidate. InkOS's post-write checks, sensitive-word checks,
fiction length rules, and in-memory snapshots are not reused as domain facts. AgentPress maps the
behavior to `article-review-policy.ts` (revision/hash, document structure, grapheme length, HTTPS
links, declared claim-to-Evidence completeness), `article-review-cycle.ts` (typed terminal status,
bounded model/token/cost calls, best valid snapshot), and `article-review-store.ts` (PostgreSQL
`review_rounds` rows referencing immutable `artifact_versions`). A reviewer parse failure or hard
deterministic failure never creates an EditProposal; selection is recorded as a degraded outcome.
The cycle has no canonical article settlement capability: accepted article changes continue through
the existing editor Proposal/Batch decision service. Contract tests cover no-change, improvement,
degradation, parse failure, stale revision, missing Evidence and budget exhaustion. InkOS has no
token/cost budget or candidate persistence, so those are explicit AgentPress safety extensions rather
than claimed upstream behavior.

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

| Source and pin                                                                                                                                                      | License       | Current decision                                                                                             | Reviewed upstream paths                                                                                                                                                                                                                                    | Current local destination or boundary                                                                                                                                  | Verification                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`earendil-works/pi`](https://github.com/earendil-works/pi), npm `@earendil-works/pi-agent-core@0.82.1`, tag `v0.82.1` (`b4f293684bba718d59cc1157679bcf6157b3a7f5`) | MIT           | Direct dependency; no source copied                                                                          | Published `pi-agent-core` and `pi-ai` packages                                                                                                                                                                                                             | `packages/agent-runtime/src/pi-runtime-adapter.ts`, `packages/agent-runtime/src/current-turn.ts`, and `packages/agent-context/src/conversation-compaction-policy.ts`   | Model/tool event mapping, abort behavior, streaming, current-turn protocol, compaction threshold, schema handling, and provider fixture contracts                          |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), `v17.1.8` (`f446b8a8193e59b4cbd2cf487ab6fa1915e0b890`)                                                   | MIT           | Selected behavior/tests adapted; official Pi runtime retained                                                | Schema, tool protocol/recovery, Task lifecycle, MCP reconnect, Mnemopi recall, Hashline, ToolChoiceQueue, and compaction paths recorded in `THIRD_PARTY_NOTICES.md`                                                                                        | Exact implementation and test paths are recorded per behavior unit in `THIRD_PARTY_NOTICES.md`                                                                         | Provider fixtures, tool/recovery invariants, Specialist boundaries, MCP reconnect, Memory recall, hash anchoring, durable tool choice, and PostgreSQL compaction contracts |
| [`Narcooo/inkos`](https://github.com/Narcooo/inkos), `v1.7.2` (`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`)                                                          | AGPL-3.0-only | Behavior and test reference only; do not copy source under the current distribution                          | `packages/core/src/utils/context-assembly.ts`, `governed-context.ts`, `context-filter.ts`, `packages/core/src/pipeline/chapter-review-cycle.ts`, `chapter-state-recovery.ts`, `packages/core/src/interaction/action-envelope.ts`, plus corresponding tests | No copied destination; AgentPress-owned contracts and PostgreSQL adapters implement selected behavior independently                                                    | Verify behavior through AgentPress contract/integration tests; any future source reuse requires an explicit AGPL distribution decision                                     |
| [`deer-flow/llm-space`](https://github.com/deer-flow/llm-space), `v4.0.1` (`4a34cef4c8517eaf2371123e65dc7fb3373b7ebf`)                                              | MIT           | Candidate/reference only; no source or behavior adopted                                                      | `packages/core/src/parsers/normalize-thread.ts`, `packages/core/src/thread/`, `apps/desktop/src/components/trace-panel/`, `thread-playground/run-trace-view.tsx`, `run-evaluation-utils.ts` and tests                                                      | None                                                                                                                                                                   | A future adoption must first copy behavior tests, remove Tauri/local-file assumptions, and record exact local paths in this matrix and `THIRD_PARTY_NOTICES.md`            |
| [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), `v2.15.0` (`e588296e28b36a22b081d40fcfba76f418d6f84e`)                                 | MIT           | Lifecycle and output-guard behavior/tests adapted; package rejected as a direct dependency                   | `server-manager.ts`, `mcp-output-guard.ts`, `__tests__/server-manager-reconnect.test.ts`, `__tests__/init-failure-state.test.ts`, `__tests__/mcp-output-guard.test.ts`                                                                                     | `packages/mcp-runtime/src/server-manager.ts`, `packages/mcp-runtime/src/output-guard.ts`, and corresponding tests                                                      | Official MCP SDK `1.30` conformance, lazy lifecycle, cancellation, output schema, hostile output, and deterministic recovery                                               |
| [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk), `1.30.0` (pnpm lockfile pin)                                       | MIT           | Direct dependency through the MCP adapter; Domain remains SDK-free                                           | `src/client/index.ts`, `src/types.ts`, transport implementations, and upstream protocol/transport contract tests                                                                                                                                           | `packages/mcp-runtime/src/client-gateway.ts`, `packages/mcp-runtime/src/streamable-http.ts`, `packages/mcp-runtime/src/contracts.ts`, and `packages/mcp-runtime/test/` | Client/session/transport typing, JSON-RPC framing, cancellation, notifications, and protocol validation; host policy and persistence remain AgentPress-owned               |
| [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access), `v0.15.0` (`b537183632d555d1b2e61cb8f6bdf585766f2380`)                                   | MIT           | Selected SSRF and explicit AnySearch adapter behavior/tests adapted; package rejected as a direct dependency | `ssrf-protection.ts`, `anysearch.ts`, `test/ssrf-protection.test.mjs`, `test/anysearch-provider.test.mjs`                                                                                                                                                  | `packages/web-research/src/ssrf-guard.ts`, `packages/runtime-tools/src/web-search.ts`, and corresponding tests                                                         | DNS rebinding/redirect denial; anonymous search, strict provider envelope, bounded results, cancellation, HTTP failure, redaction, zero-result degradation                 |
| [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills), commit `90bb51cae36515a648515b633a81c0c6efc8c74d`                                                    | MIT           | Format/examples used as behavior reference; no executable source copied                                      | Repository `SKILL.md` examples and README format/discovery conventions                                                                                                                                                                                     | `packages/agent-context/src/skill.ts`, `packages/agent-context/test/context.test.ts`, and `packages/agent-application/src/skill-preselection.ts`                       | Frontmatter diagnostics, precedence conflicts, static-resource integrity, untrusted projection, tool allowlist narrowing, prompt injection, and exact-revision selection   |

The executable, test-first adoption backlog for Oh My Pi is maintained in
[`docs/oh-my-pi-reuse-todo.md`](../oh-my-pi-reuse-todo.md). It is intentionally broader than the
current reuse row: every item remains a TODO until dependency reuse or copied behavior has passed the
license, adapter-boundary, PostgreSQL-authority, contract-test, and real-model gates recorded there.

### MCP owner and adapter map

This table is the implementation boundary for the MCP items in
[`docs/inkos-reuse-todo.md`](../inkos-reuse-todo.md). InkOS has no MCP subsystem; these are
AgentPress owners and the upstream protocol pieces they are allowed to consume.

| Concern                                  | AgentPress owner and facts                                                                                                                                                                                     | Adapter boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client/session/transport                 | `packages/mcp-runtime/src/client-gateway.ts`, `streamable-http.ts`, `server-manager.ts`, `transport-errors.ts`                                                                                                 | Official SDK `1.30.0` owns MCP client/session and JSON-RPC transport types. The host proves dispatch boundaries: exhausted connection probes before dispatch are retryable; connection loss, timeout and stale results after dispatch become non-replayable typed unknown outcomes. A shared narrow classifier ensures only connection failures count toward the reconnect circuit; repeated authentication/protocol rejection stays typed and never opens it. Real fixtures prove closed-TCP probing, initialize-only request counts, absent/expired Authorization behavior, timeout cancellation, late-result fencing and session health. No SDK type crosses Domain. | `packages/mcp-runtime/test/client-gateway.test.ts`, `server-manager.test.ts`, `streamable-http.integration.test.ts`                                                         |
| Server capability and tool-list revision | `packages/mcp-runtime/src/built-in-tools.ts`, `in-memory-built-ins.ts`                                                                                                                                         | Built-in server id/revision and tool schema are converted to the host `ToolRegistry` definition. A Run snapshots `serverRevision`, `toolRevision` and `adapterRevision` in `tool_calls.transport_provenance`; remote Server or tool-list data cannot grant capability.                                                                                                                                                                                                                                                                                                                                                                                                  | `packages/mcp-runtime/test/built-in-tools.test.ts`, `packages/agent-application/test/tool-call.integration.test.ts` (provenance and drift)                                  |
| Schema/output guard                      | `packages/mcp-runtime/src/output-guard.ts`, `client-gateway.ts`                                                                                                                                                | `pi-mcp-adapter` behavior is adapted behind the gateway. Guarded output is untrusted, size-bounded and optionally stored as an Artifact. Official SDK `McpError` is reduced to a fixed host message and numeric protocol code; remote message, data, tool name and cause are discarded. Missing-tool errors keep the healthy session ready, while `ConnectionClosed` retains the distinct after-dispatch unknown-outcome path.                                                                                                                                                                                                                                          | `packages/mcp-runtime/test/output-guard.test.ts`, `built-in-tools.test.ts`, `client-gateway.test.ts`, `streamable-http.integration.test.ts`                                 |
| Host Tool Registry                       | `packages/tool-runtime/src/tool-registry.ts`                                                                                                                                                                   | Registry owns tool id/version, capability, hard deadline, input/output schema, transport provenance and evidence provider revision. The deadline races even a non-cooperative handler: read-only timeout is retryable, while an external/destructive call already dispatched becomes `outcome_unknown(timeout_after_dispatch)`. MCP only supplies an adapter-backed implementation; it does not create a second executor.                                                                                                                                                                                                                                               | `packages/tool-runtime/test/tool-registry.test.ts`, `packages/agent-application/test/tool-call.integration.test.ts`, `packages/mcp-runtime/src/built-in-tools.ts`           |
| Argument audit summary                   | `packages/tool-runtime/src/tool-argument-summary.ts`; PostgreSQL `tool_calls.argument_summary`                                                                                                                 | The host TypeBox input schema owns field identity and declared type. The summary records only required/type and bounded string/array/object sizes; additional user-controlled field names and all values are omitted. Historical rows use an empty v1 summary rather than invented schema facts.                                                                                                                                                                                                                                                                                                                                                                        | `packages/tool-runtime/test/tool-registry.test.ts`, `packages/agent-application/test/tool-call.integration.test.ts`, `apps/web/src/lib/agent-tool-audit-projection.test.ts` |
| Persistent execution bridge              | `packages/agent-application/src/persistent-tool-bridge.ts`                                                                                                                                                     | Every MCP call enters the same `ToolCallService` proposal/approval/execute path as first-party tools. Specialist `taskId/taskAttempt` is attached here; Skills only narrow the already-authorized host set. A runtime-tools integration composes the official SDK `McpServer` over Streamable HTTP with this bridge and PostgreSQL: the first call settles guarded output and frozen provenance; the same provider ToolCall id replays from the ledger while the Server handler remains at one execution.                                                                                                                                                               | `packages/agent-application/test/tool-call.integration.test.ts`, `packages/runtime-tools/test/mcp-postgres.integration.test.ts`, `persistent-tool-bridge.ts`                |
| ToolCall ledger and approval             | `packages/agent-application/src/tool-call-service.ts`, `tool-call-execution-service.ts`, `tool-call-aggregate-lock.ts`; PostgreSQL `tool_calls` and `run_events` schema                                        | PostgreSQL is the authority for idempotency, approval, attempt fencing, cancellation, provenance drift and terminal status. Aggregate mutations lock `Run -> ToolCall`; cancellation settles calls proven not dispatched as `cancelled` and fences executing calls as `outcome_unknown`, so concurrent approval or late provider settlement cannot revive them. An external-write MCP fixture proves denial preserves frozen transport provenance, dispatches zero provider calls and projects identical live/replay `tool.denied` facts. MCP transport errors never become Domain state directly.                                                                      | `packages/agent-application/test/tool-call.integration.test.ts`, `tool-call-failure.test.ts`                                                                                |
| Retry/reconnect audit                    | `packages/mcp-runtime/src/client-gateway.ts` observer -> `packages/agent-application/src/tool-transport-audit-service.ts`; `tool_calls.transport_retry_count`, `transport_reconnect_count`                     | Only pre-dispatch connection probes are retryable. The observer reports an ordinal; the application service validates persisted MCP provenance, updates counters under row lock, appends `tool.transport_retrying`/`tool.transport_reconnected`, and publishes the same durable fact. After dispatch, connection loss remains `outcome_unknown` and is never replayed.                                                                                                                                                                                                                                                                                                  | `packages/mcp-runtime/test/client-gateway.test.ts`, `streamable-http.integration.test.ts`, `packages/agent-application/test/tool-call.integration.test.ts`                  |
| Evidence/artifact settlement             | `packages/agent-application/src/tool-evidence-store.ts`, `packages/agent-application/src/run-settlement-service.ts`                                                                                            | Only guarded, validated MCP values can become Evidence/Artifact references. Settlement is atomic with the ledger; injected projection failure leaves the call `executing` for typed recovery, not a false success.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/agent-application/test/tool-call.integration.test.ts` (Evidence failure, outcome unknown)                                                                         |
| RunEvent and consumer projection         | `packages/agent-application/src/run-projection.ts`, `run-projection-service.ts`; Web `apps/web/src/lib/agent-execution-projection.ts`, `agent-tool-failure-projection.ts` and `agent-tool-audit-projection.ts` | Product projection exposes goal/result/outcome plus bounded typed failures, never raw provider error text. Rate limiting and authentication use exact code/messageKey/retryable contracts; Web rejects mismatched fields. Connection and initialization failures before dispatch remain ordinary `failed`, including external-write tools, while after-dispatch uncertainty remains non-retryable `outcome_unknown`. Server/tool/revision/transport and raw guarded payload remain audit-only; live and replay use the same facts.                                                                                                                                      | `packages/agent-application/test/run-projection.test.ts`, `tool-call-failure.test.ts`, `tool-call.integration.test.ts`; Web failure/runtime/audit projection tests          |

The map is complete for the documented local boundaries. Official SDK Streamable HTTP Server plus
PostgreSQL bridge composition now passes with exactly-once provider execution. The separate MCP
completion gate remains open until browser projection checks and a real Pi target-model run pass.

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
all non-terminal Tasks and releases active leases before the Run can settle, while pre-dispatch
ToolCalls become `cancelled` and executing ToolCalls become `outcome_unknown`. The same transaction
appends typed events, and the shared `Run -> ToolCall` aggregate lock order serializes approval and
cancellation. A late worker or provider result therefore cannot turn a cancelled fact into success.
PostgreSQL integration tests now cover Task and ToolCall attempt fencing, cancellation live/replay,
approval races, Unknown Outcome recovery, late settlement, and distinct repeated operations. Real
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
new Trial identity. This prevents a polluted attempt from reusing its object prefix or Kafka group.
No Harbor source is copied: AgentPress directly composes Docker CLI, Drizzle/PostgreSQL, KafkaJS and
MinIO behind `EvalSandboxResourceManager` and `executeDockerEvalSandbox`. The fixed infrastructure
test creates and removes real schema/topic/prefix resources and verifies the container's non-root,
read-only, noexec, capability, NoNewPrivileges, network-none, bounded-output and timeout-cleanup
contracts. `runSandboxExperiment` now joins Trial claim, lease renewal/expiry recovery, resource
lease, fixed case/arm command, structured output, cancellation, bounded retry and exact-claim
settlement; its real integration case proves failed-attempt cleanup and fresh retry identities.

## Primary Pi Business Reference

**Primary reference: [`Narcooo/inkos`](https://github.com/Narcooo/inkos) at release `v1.7.2`, commit `c7851b94ada27f2810b903e96d8fec6f33e5d9bc`.** This is the default upstream to inspect before changing AgentPress conversation-to-writing behavior, long-form writing orchestration, review, recovery, or session restoration. Other repositories in this document remain secondary references for narrower infrastructure concerns.

Executable learning and reuse work is tracked in `docs/inkos-reuse-todo.md`; completed consumer Web
alignment remains recorded separately in `docs/inkos-web-agent-alignment.md`.

The selection is evidence-based rather than a popularity choice:

- Its product domain is the closest match: a shipped story and long-form content creation application, not a coding-agent shell or framework example.
- The pinned release publishes `@actalk/inkos-core@1.7.2`, has 38 GitHub releases, 291 test files in the release tree, and passed its release CI on Ubuntu and Windows across Node.js 20, 22, and 24, followed by package verification.
- The repository is active, unarchived, and had 8,612 stars and 1,622 forks when reviewed on 2026-08-02. These figures are supporting signals only; source and test evidence below is the adoption basis.
- Its `AGPL-3.0-only` license matches AgentPress's repository license. Copied code still requires immutable provenance, preserved notices, and an entry in `THIRD_PARTY_NOTICES.md`.
- Electric is the stronger secondary reference for durable event timelines and Pi adapters, but its agent subsystem is less mature as a product surface and is not a long-form writing application. It does not replace InkOS as the single business reference.

The `v1.7.2` consumer UI evidence was verified from source and behavior tests:

- `packages/studio/src/components/ai-elements/reasoning.tsx` opens reasoning while streaming and closes it one second after streaming ends.
- `packages/studio/src/components/chat/ToolExecutionSteps.tsx` opens an active pipeline and closes it 500 ms after completion, while keeping the summary, duration, and status visible.
- The same file groups read/edit/grep/list utility calls under one file-operation disclosure and keeps individual utility results collapsed. `packages/studio/src/components/chat/__tests__/ToolExecutionSteps.test.ts` covers the grouped count and default-collapsed result body.
- Product result previews such as `ShortFictionResultPreview` and `ScriptStoryboardResultPreview` render before the collapsible pipeline stages and logs. Generic raw results remain separately disclosed and are not treated as the primary outcome.

### Adoption map

| AgentPress concern                     | InkOS source and tests at the pinned commit                                                                                                                                                                                                     | Decision and adaptation boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User intent and mutation authorization | `packages/core/src/interaction/action-envelope.ts`, `packages/core/src/agent/agent-session.ts`; `packages/core/src/__tests__/interaction-models.test.ts`, `agent-session.test.ts`, `instruction-adherence-boundary.test.ts`                     | Copy the structured `actionSource` + `requestedIntent` + validated `actionPayload` contract and host-side tool-table gating. Extend it so every AgentPress article mutation requires a matching current-turn capability; do not rely on natural-language keywords or prompt obedience.                                                                                                                                                                                                                                                    |
| Durable conversation restoration       | `packages/core/src/interaction/session-transcript-schema.ts`, `session-transcript.ts`, `session-transcript-restore.ts`; `packages/core/src/__tests__/session-transcript.test.ts`, `session-transcript-restore.test.ts`, `agent-session.test.ts` | Adapt committed-request filtering, tool-call/result repair, restore boundaries, failed-request exclusion, and cache invalidation. Store and project the facts from PostgreSQL `RunEvent` records rather than adopting InkOS JSONL/files as the fact source.                                                                                                                                                                                                                                                                               |
| Review and revision loop               | `packages/core/src/pipeline/chapter-review-cycle.ts`; `packages/core/src/__tests__/chapter-review-cycle.test.ts`                                                                                                                                | Adopted as AgentPress-owned policy/cycle contracts. InkOS's deterministic round order, parse-failure fail-closed behavior, score threshold, three-point material improvement, bounded iterations, usage accumulation, and best valid snapshot are covered by `packages/agent-application/src/article-review-policy.ts`, `article-review-cycle.ts`, and their tests. Candidate facts persist through existing immutable `artifact_versions` plus extended `review_rounds`; no chapter truth or canonical article settlement is introduced. |
| State recovery and degraded output     | `packages/core/src/pipeline/chapter-state-recovery.ts`; `packages/core/src/__tests__/chapter-state-recovery.test.ts`                                                                                                                            | Extend existing PostgreSQL recovery owners with isolated settlement retry, revalidation, explicit degraded output, and freezing of previously valid facts. Map chapter truth files to AgentPress Article Revision, Context Pack, Evidence, Artifact Version, TaskResult, Checkpoint, and settlement; never copy the file-backed truth model.                                                                                                                                                                                              |
| Context governance                     | `packages/core/src/utils/context-assembly.ts`, `governed-context.ts`, `context-filter.ts` and their tests                                                                                                                                       | Reuse selection, budgeting, and validation behavior behind `packages/agent-context/`. Preserve typed provenance and immutable Context Packs; do not copy the upstream conversion that presents injected book context as a new user message.                                                                                                                                                                                                                                                                                               |
| Consumer execution disclosure          | `packages/studio/src/components/ai-elements/reasoning.tsx`, `packages/studio/src/components/chat/ToolExecutionSteps.tsx`; `packages/studio/src/components/chat/__tests__/ToolExecutionSteps.test.ts`                                            | Independently adapt result-first disclosure: collapse settled reasoning and pipeline state, group low-value utility operations, and keep product outcomes/actions outside diagnostic detail. Preserve AgentPress RunEvent facts and assistant-ui primitives; do not copy InkOS components or its default-expanded raw result blocks.                                                                                                                                                                                                      |

### Deliberate exclusions

- Do not copy InkOS's `@mariozechner/pi-agent-core@0.67.1` or `@mariozechner/pi-ai@0.67.1` integration. AgentPress remains on `@earendil-works/pi-agent-core@0.82.1` and ports only isolated business behavior behind its runtime adapter.
- Do not copy `isWriteNextInstruction`, `isExplicitWriteChapterCommand`, or any keyword matcher as the primary router. Keywords may normalize an already authorized UI command, but cannot grant mutation authority.
- Do not copy the active-book free-text tool table unchanged. At the pinned release it still exposes `sub_agent`, cover, truth-file, chapter patch/replace, and import tools to an ordinary book chat turn. AgentPress must gate article mutation tools by current-turn structured capability so a greeting cannot continue or rewrite an article.
- Do not copy file-based project/session persistence, TUI/desktop assumptions, or InkOS domain entities into AgentPress. PostgreSQL Conversations, Runs, Tasks, Tool Calls, Events, Checkpoints, article versions, and Edit Proposals remain authoritative.
- Do not copy `context-transform.ts` behavior that injects business context with user-message provenance. Projected context must remain distinguishable from the user's current request.
- Do not copy InkOS source, its default-expanded operation results, local preference state, or raw execution logs into the consumer transcript. AgentPress adapts the verified per-pipeline business units and utility-operation grouping behind its durable projection, while keeping approvals, failures, recovery, and reviewable outcomes visible.

### State recovery gap audit

The pinned InkOS recovery unit retries only `settleChapterState`, passes the first validation warnings
back as structured feedback, revalidates the retry, and returns either `recovered` or `degraded`. On
degradation it freezes the previous state, hooks, ledger, runtime snapshot, and chapter summaries while
preserving the generated chapter body. Its four tests cover a clean retry, repeated validation failure,
freezing old truth outputs, and degraded review metadata.

AgentPress already has stronger infrastructure facts and must reuse them: PostgreSQL Checkpoints,
Run/Task lease fencing, immutable Article/Artifact versions, ToolCall operation keys,
`decideToolReplay`, `tool.outcome_unknown`, stale-worker rejection, and
`run.completed_with_degradation`. The remaining gap is an application contract that:

- retries settlement independently from generation and only when the settlement operation is replay-safe;
- freezes validated Article/Evidence/Artifact facts and recomputes only damaged or unsettled projections;
- runs Schema, capability, Evidence, and stale-revision validation again before accepting recovered output;
- returns typed preserved, missing, unverified, and next-action fields when full recovery is impossible.

This contract belongs in a small recovery policy/service behind existing stores and validators.
`RunRecoveryService` remains the Run/Tool recovery orchestrator; it must not absorb Article validation,
Evidence policy, Artifact persistence, or provider-specific retry logic. The existing independent
`outcome_unknown` state remains human-review-only and must never be collapsed into an ordinary failure.

The worker-crash boundary now uses the same public/protected ToolCall failure contract as live
execution. `RunRecoveryService` settles an already-dispatched external write as
`outcome_unknown(worker_lease_lost_after_dispatch)`, persists protected diagnostics, and publishes
only the bounded public failure; PostgreSQL replay and Web localization consume that same reason.
Read-only calls remain independently replay-ready, so this projection change does not broaden replay.
If the user cancels while the Run is recovering, the same aggregate lock path moves a replay-ready
read-only call to `tool.cancelled` before dispatch. PostgreSQL evidence fixes the event order, proves
zero provider calls, and rejects both later recovery preparation and execution; live and replay merge
to the same cancelled activity.
Stale-worker settlement is fenced at both ownership levels. A late Specialist attempt cannot persist
its TaskResult, Artifact, or RunEvent after a newer attempt succeeds. A stale Main worker cannot write
an assistant message, checkpoint, or terminal event after the Run enters recovery. Both paths are
verified against PostgreSQL row counts and leave the authoritative newer/recovering state unchanged.
Artifact persistence is transactionally claim-free on partial failure. A fixture inserts one valid
Artifact, then fails a second Artifact on a missing Evidence foreign key; PostgreSQL rolls back both
Artifacts and all links before a separate fallback transaction records only `persistence_failed`.
The missing Evidence id never enters the public event. Protocol validation independently covers the
opposite path where invalid Evidence is rejected before persistence after bounded repair.
Recovery timeout is now verified through the production Pi adapter and an OpenAI-compatible HTTP
transport rather than only a faux or cooperative runtime. A Server that accepts the provider request
but never sends the first response chunk is fenced by the host deadline even when the provider Promise
does not settle promptly. Only the interrupted optional Task receives attempt-two `task_timeout`; the
previously committed Research Artifact keeps its id, immutable version, and content. Late runtime
events are ignored, the HTTP connection is aborted, and PostgreSQL live/replay exposes the same
`timed_out` activity before the Run settles as `completed_with_degradation`.
Run settlement now reconciles connection loss against PostgreSQL rather than inferring commit state
from an exception. A second real PostgreSQL connection terminates the settlement backend before
commit and proves the assistant message, checkpoint, terminal event, and Run status all roll back;
the same generated result can then settle once. The opposite fixture commits the real transaction and
then drops the client acknowledgement. A bounded classifier accepts SQLSTATE class 08, shutdown and
system connection codes, plus Drizzle's structurally failed `rollback`, but never provider text. The
service reads terminal facts after the pre-transaction RunEvent watermark and adopts only a matching
committed terminal event, preventing duplicate messages and settlement events.

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
