# InkOS Web Agent Alignment TODO

Reference: `Narcooo/inkos` `v1.7.2` at commit
`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`.

AgentPress keeps `assistant-ui@0.15.1`, PostgreSQL RunEvent projections, and the existing
domain components as ownership boundaries. InkOS UI behavior is reused where it is mature;
file-backed sessions, unrestricted tool tables, TUI code, and keyword authorization are excluded.

## P0 Message Rendering

- [x] Render assistant Markdown incrementally with pinned Streamdown and CJK/code/math/Mermaid plugins.
- [x] Split generic message rendering from AgentPress domain parts so neither becomes a god component.
- [x] Render user messages as literal text and assistant messages as Markdown.
- [x] Use animated rendering only for the active streamed part; use static rendering for completed and restored messages.
- [x] Add a collapsed reasoning-summary part with streaming, completed, and elapsed-time states. Never expose hidden chain of thought.
- [x] Test headings, emphasis, lists, tables, code, math, Mermaid, links, unsafe HTML, CJK, and incomplete streamed Markdown.

## P0 Run Timeline

- [x] Group adjacent tool/task lifecycle parts into one `ToolExecutionSteps` timeline.
- [x] Define one visual state model for queued, active, waiting, succeeded, failed, cancelled, degraded, and stale.
- [x] Preserve approval, ask-user, article review, evidence, and artifact interactions as typed domain parts.
- [x] Show duration and concise result/error summaries without dumping raw tool payloads by default.
- [x] Derive every state from RunEvent projection; the Web must not infer lifecycle state from labels or timers.
- [x] Add projection and component tests for interleaved tools, retries, approvals, terminal events, and replay.

## P1 Recovery And Failure

- [x] Give recovery, retry, degraded completion, cancellation, protocol error, provider error, and stale edit distinct views.
- [x] Preserve an existing article working draft when a later Run fails and show that fact explicitly.
- [x] Show actionable public error messages while keeping internal stack traces and credentials hidden.
- [x] Test live SSE and restored projection parity for every terminal state.

## P1 Scrolling

- [x] Reuse `ThreadPrimitive.Viewport` and `ScrollToBottom` with explicit bottom-pinned behavior.
- [x] Do not force-scroll while the user reads history.
- [x] Keep the bottom anchor stable when Markdown, code highlighting, Mermaid, or tool details change height.
- [x] Show the return-to-bottom control only when the viewport is not pinned.
- [ ] Add browser tests for streaming, expanding steps, and switching conversations.

## P1 Artifacts And Context

- [x] Replace inline artifact dumps with an `ArtifactDrawer` backed by persisted artifact projections.
- [x] Render Markdown artifacts with Streamdown static mode; render typed assets with domain viewers.
- [x] Show title, type, version, summary, evidence, download/open actions, and provenance.
- [x] Add a compact context-source view backed by Context Pack/Turn Profile facts: article revision, selection, attachments, evidence, skills, provider/model, and budget.
- [x] Never reconstruct context provenance from composer state after a Run starts.
- [x] Test authorization, missing artifacts, stale versions, and restored Runs.

## P1 Conversation Branches

- [x] Reuse the existing branch fork API to add regenerate/fork actions to assistant messages.
- [x] Add previous/next branch navigation and branch count without duplicating messages.
- [x] Preserve the original branch and fork point as immutable facts.
- [x] Test fork authorization, exact message boundary, branch switching, and independent subsequent Runs.

## P2 Composer And Visual Polish

- [x] Make current article, selection, attachments, skills, steering/follow-up mode, and pending-review lock visible in one composer context row.
- [x] Ensure cancel, stop, steering, follow-up, and send-disabled states have distinct semantics.
- [x] Align typography, spacing, table overflow, code blocks, long links, focus states, and reduced motion with the Notion reference and InkOS density.
- [x] Verify desktop and mobile layouts with browser screenshots and overlap checks.

## P0 Composer And Run Lifecycle

- [x] Derive composer actions from one pure Run lifecycle model instead of independent Web booleans.
- [x] Keep new-send, stop-generation, cancel-Run, in-flight steering, queued follow-up, and disabled-send as distinct commands with distinct labels and effects.
- [x] Preserve per-conversation composer drafts and pending directives while switching conversations; never submit one conversation's draft to another branch.
- [x] Make stopping and cancellation idempotent and project their acknowledged, cancelling, and terminal states from persisted Run facts.
- [x] Add opposite-semantics tests proving steering does not become a follow-up, follow-up does not interrupt the current Run, and stopping does not create a new message.

## P0 Durable Sessions And Review Loop

- [x] Keep an active Run executing when the user switches articles or conversations and expose its durable status in the conversation picker.
- [x] Restore the same Run after refresh or SSE reconnect from PostgreSQL projections without duplicate messages, tool calls, edit batches, or optimistic content.
- [x] Resume event streaming from the last durable event ID and fall back to a full projection refresh when the stream cursor is stale.
- [x] Represent one complete article write as one reviewable document batch while retaining granular batches for targeted edits.
- [x] Link an article-change part to its working draft, first changed block, latest batch undo, partial accept, reject, and stale-reload actions.
- [x] Keep review settlement and Run settlement independent: a completed Run may leave a durable pending article review.

## P1 Conversation And Background Work

- [x] Show running, waiting-for-user, waiting-for-approval, failed, and pending-review status for every conversation from persisted facts.
- [x] Preserve background progress and unread completion when the user leaves and returns to a conversation.
- [x] Offer recovery actions appropriate to provider failure, tool failure, protocol failure, stale article, cancellation, and degraded completion.
- [x] Show long-task phase, completed steps, outstanding interaction, and the latest safe recovery point without exposing hidden reasoning.

## P1 Actionable Results And Execution Facts

- [x] Give tool results, evidence, artifacts, and article changes typed open, locate, download, retry, and provenance actions where applicable.
- [x] Locate the editor at the first affected block when an article-change part or review batch is opened, without moving the viewport during unrelated streaming.
- [x] Display the actual provider, model, context window, output limit, duration, tokens, and cost facts captured by the Run; never substitute current settings for historical facts.
- [x] Test artifact and context authorization, missing resources, stale versions, restored Runs, and hostile external URLs.

## P2 Accessibility And Responsive Behavior

- [x] Support keyboard send, stop/close, branch navigation, and focus return with accessible names and visible focus states.
- [x] Respect reduced-motion preferences for streamed Markdown, spinners, drawers, menus, and scrolling.
- [x] Keep tables, code, Mermaid, CJK, and long links inside the Agent viewport at desktop and mobile widths.
- [x] Prevent the workspace header, global account actions, Agent header, composer, and mobile safe areas from overlapping by assigning layout ownership explicitly.
- [x] Verify these contracts with automated browser assertions and desktop/mobile screenshots, not screenshots alone.

## Deliberate Non-Adoption

- [x] Do not adopt InkOS file/JSONL sessions as a fact source; PostgreSQL RunEvents and checkpoints remain authoritative.
- [x] Do not expose the full writing tool table to ordinary chat turns or allow free text to grant mutation capability.
- [x] Do not use keyword intent routing, prompt-only authorization, or current composer state to reconstruct historical context.
- [x] Do not expose hidden chain of thought or copy InkOS's older Pi runtime integration.
- [x] Do not auto-settle a canonical article revision without AgentPress review and permission boundaries.

## Completion Gates

- [x] Upstream behavior references and immutable versions remain recorded in `docs/references/pi-ecosystem.md` and `THIRD_PARTY_NOTICES.md` when code is copied.
- [ ] Web unit tests, projection contract tests, typecheck, lint, build, and PostgreSQL integration tests pass.
- [ ] Browser verification covers Markdown streaming, tool timeline, recovery, scrolling, artifact drawer, context sources, and branch navigation.
- [ ] A real Pi runtime/target-model scenario verifies normal Markdown, tool use, recovery, and a branch follow-up without duplicate content.
