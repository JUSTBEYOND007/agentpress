# InkOS Web Agent Alignment TODO

Reference: `Narcooo/inkos` `v1.7.2` at commit
`c7851b94ada27f2810b903e96d8fec6f33e5d9bc`.

AgentPress keeps `assistant-ui@0.15.1`, PostgreSQL RunEvent projections, and the existing
domain components as ownership boundaries. InkOS UI behavior is reused where it is mature;
file-backed sessions, unrestricted tool tables, TUI code, and keyword authorization are excluded.

## P0 Message Rendering

- [x] Render assistant Markdown incrementally with pinned Streamdown and CJK/code/math/Mermaid plugins.
- [ ] Split generic message rendering from AgentPress domain parts so neither becomes a god component.
- [ ] Render user messages as literal text and assistant messages as Markdown.
- [ ] Use animated rendering only for the active streamed part; use static rendering for completed and restored messages.
- [ ] Add a collapsed reasoning-summary part with streaming, completed, and elapsed-time states. Never expose hidden chain of thought.
- [ ] Test headings, emphasis, lists, tables, code, math, Mermaid, links, unsafe HTML, CJK, and incomplete streamed Markdown.

## P0 Run Timeline

- [ ] Group adjacent tool/task lifecycle parts into one `ToolExecutionSteps` timeline.
- [ ] Define one visual state model for queued, active, waiting, succeeded, failed, cancelled, degraded, and stale.
- [ ] Preserve approval, ask-user, article review, evidence, and artifact interactions as typed domain parts.
- [ ] Show duration and concise result/error summaries without dumping raw tool payloads by default.
- [ ] Derive every state from RunEvent projection; the Web must not infer lifecycle state from labels or timers.
- [ ] Add projection and component tests for interleaved tools, retries, approvals, terminal events, and replay.

## P1 Recovery And Failure

- [ ] Give recovery, retry, degraded completion, cancellation, protocol error, provider error, and stale edit distinct views.
- [ ] Preserve an existing article working draft when a later Run fails and show that fact explicitly.
- [ ] Show actionable public error messages while keeping internal stack traces and credentials hidden.
- [ ] Test live SSE and restored projection parity for every terminal state.

## P1 Scrolling

- [ ] Reuse `ThreadPrimitive.Viewport` and `ScrollToBottom` with explicit bottom-pinned behavior.
- [ ] Do not force-scroll while the user reads history.
- [ ] Keep the bottom anchor stable when Markdown, code highlighting, Mermaid, or tool details change height.
- [ ] Show the return-to-bottom control only when the viewport is not pinned.
- [ ] Add browser tests for streaming, expanding steps, and switching conversations.

## P1 Artifacts And Context

- [ ] Replace inline artifact dumps with an `ArtifactDrawer` backed by persisted artifact projections.
- [ ] Render Markdown artifacts with Streamdown static mode; render typed assets with domain viewers.
- [ ] Show title, type, version, summary, evidence, download/open actions, and provenance.
- [ ] Add a compact context-source view backed by Context Pack/Turn Profile facts: article revision, selection, attachments, evidence, skills, provider/model, and budget.
- [ ] Never reconstruct context provenance from composer state after a Run starts.
- [ ] Test authorization, missing artifacts, stale versions, and restored Runs.

## P1 Conversation Branches

- [ ] Reuse the existing branch fork API to add regenerate/fork actions to assistant messages.
- [ ] Add previous/next branch navigation and branch count without duplicating messages.
- [ ] Preserve the original branch and fork point as immutable facts.
- [ ] Test fork authorization, exact message boundary, branch switching, and independent subsequent Runs.

## P2 Composer And Visual Polish

- [ ] Make current article, selection, attachments, skills, steering/follow-up mode, and pending-review lock visible in one composer context row.
- [ ] Ensure cancel, stop, steering, follow-up, and send-disabled states have distinct semantics.
- [ ] Align typography, spacing, table overflow, code blocks, long links, focus states, and reduced motion with the Notion reference and InkOS density.
- [ ] Verify desktop and mobile layouts with browser screenshots and overlap checks.

## Completion Gates

- [ ] Upstream behavior references and immutable versions remain recorded in `docs/references/pi-ecosystem.md` and `THIRD_PARTY_NOTICES.md` when code is copied.
- [ ] Web unit tests, projection contract tests, typecheck, lint, build, and PostgreSQL integration tests pass.
- [ ] Browser verification covers Markdown streaming, tool timeline, recovery, scrolling, artifact drawer, context sources, and branch navigation.
- [ ] A real Pi runtime/target-model scenario verifies normal Markdown, tool use, recovery, and a branch follow-up without duplicate content.
