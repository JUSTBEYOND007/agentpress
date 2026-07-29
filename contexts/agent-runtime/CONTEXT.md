# Agent Runtime

Agent Runtime turns a user's message into one durable execution whose work may be delegated to built-in specialists without transferring control of the execution.

## Language

**Conversation**:
A branchable sequence of user and assistant messages.
_Avoid_: Session, chat log

**Root Request**:
A user request that creates a new Agent Run on a Conversation branch.
_Avoid_: Steering Instruction, Follow-up while queued

**Agent Run**:
One durable execution created from a Root Request and owned by the Main Agent.
_Avoid_: Job, workflow, session

**Direct Run**:
An Agent Run that can answer without delegation, external tools, retrieval, or article changes.
_Avoid_: Simple mode, chat-only run

**Planned Run**:
An Agent Run governed by a persisted Execution Plan because it requires delegation, retrieval, tools, or article changes.
_Avoid_: Workflow, background job

**Main Agent**:
The sole agent responsible for planning, delegation, approvals, completion, and failure of an Agent Run.
_Avoid_: Router, supervisor

**Execution Plan**:
The user-visible task graph that governs a Planned Run.
_Avoid_: Chain of thought, checklist

**Plan Revision**:
An immutable replacement of an Execution Plan created when new evidence or failure changes the remaining work.
_Avoid_: Plan edit, hidden replan

**Agent Task**:
A durable unit of planned work with one objective, owner, dependency set, expected Artifact, and budget.
_Avoid_: Step, Tool Call

**Required Task**:
An Agent Task whose Acceptance Criteria must be satisfied for its Agent Run to complete successfully.
_Avoid_: High-priority task

**Optional Task**:
An Agent Task that may fail or be skipped while allowing its Agent Run to complete with disclosed degradation.
_Avoid_: Best-effort background task

**Acceptance Criteria**:
The observable conditions that determine whether an Agent Task produced an acceptable Task Result.
_Avoid_: Hidden grader prompt, model confidence

**Specialist**:
A built-in stateless agent that performs a bounded task delegated by the Main Agent.
_Avoid_: Sub-agent with its own conversation, independent agent

**Task Brief**:
An immutable contract describing a Specialist's objective, inputs, constraints, expected outputs, and budget.
_Avoid_: Prompt, message

**Context Pack**:
The immutable, least-privilege set of references and instructions made available to one Agent Task.
_Avoid_: Full conversation, prompt context

**Task Result**:
The structured outcome of an Agent Task containing its status, Artifacts, Evidence, Usage, and failure details.
_Avoid_: Reply, final answer

**Artifact**:
A structured result produced by a Specialist for consumption by the Main Agent.
_Avoid_: Reply, chat message

**Evidence**:
A sourced fragment that supports an Artifact or a factual claim.
_Avoid_: Search result, context

**Steering Instruction**:
A user instruction that changes the remaining work of an active Agent Run at its next safe boundary.
_Avoid_: New conversation message, prompt injection

**Follow-up**:
A user request queued to create a new Agent Run after the active run on the same Conversation branch finishes.
_Avoid_: Steering Instruction

**Approval**:
A user's time-bounded authorization for one exact Tool Call and its declared side effect.
_Avoid_: General consent, Agent permission

**Unknown Outcome**:
A Tool Call result used when an external side effect may have happened but cannot be confirmed safely.
_Avoid_: Failure, retryable error

**Degraded Run**:
An Agent Run that completed its Required Tasks while disclosing failed or skipped Optional Tasks.
_Avoid_: Successful run

**Checkpoint**:
A durable boundary from which an interrupted Agent Run can be reconstructed without repeating confirmed side effects.
_Avoid_: Token snapshot, database backup

## Relationships

- A **Conversation** contains one or more **Agent Runs**
- A **Root Request** creates exactly one **Agent Run**
- An **Agent Run** is owned by exactly one **Main Agent**
- An **Agent Run** is either a **Direct Run** or a **Planned Run**
- A **Direct Run** cannot delegate, retrieve, call external tools, or change an Article
- A **Planned Run** is governed by exactly one active **Execution Plan**
- An **Execution Plan** contains one or more dependency-ordered **Agent Tasks**
- A **Plan Revision** preserves the previous plan and replaces only the active plan
- A **Main Agent** may delegate one or more bounded tasks to **Specialists**
- Only the **Main Agent** may create, schedule, cancel, or replace an **Agent Task**
- An **Agent Task** is either a **Required Task** or an **Optional Task**
- Every **Agent Task** has explicit **Acceptance Criteria**
- Every delegated **Agent Task** has exactly one **Task Brief** and one **Context Pack**
- A **Context Pack** contains only explicitly selected revisions, blocks, Mentions, Evidence, accepted memory, Skill instructions, allowed tools, output requirements, and budget
- A **Specialist** cannot access the full **Conversation** or context that is absent from its **Context Pack**
- A **Specialist** cannot delegate to or communicate directly with another **Specialist**
- A **Specialist** returns exactly one **Task Result**
- A **Task Result** may contain one or more **Artifacts** and **Evidence**
- A **Specialist** cannot directly change an Article; an article change is returned as an Artifact for the **Main Agent** to govern
- Mentioning a **Specialist** constrains delegation but does not change ownership of the **Agent Run**
- A **Specialist** does not own a **Conversation** or long-term memory
- A failed **Optional Task** may produce a **Degraded Run**, but a failed **Required Task** must be recovered, resolved by the user, or fail the run
- A user message during active work is either a **Steering Instruction** for that run or a queued **Follow-up**, never an implicit concurrent run or **Root Request**
- A queued **Follow-up** becomes a **Root Request** only after the active run reaches a terminal state
- An **Approval** authorizes only the Tool Call whose arguments and side-effect declaration were shown to the user
- An **Unknown Outcome** cannot be retried automatically
- A **Checkpoint** follows every accepted plan, completed Task Result, and settled side-effecting Tool Call

## Example Dialogue

> **User:** "Ask @Researcher to verify these claims and rewrite the introduction."
> **Domain expert:** "The Main Agent creates a Planned Run, gives Researcher only the relevant blocks in a Context Pack, and receives a Task Result. Any proposed rewrite remains an Artifact until the Main Agent governs the article change."

## Flagged Ambiguities

- `@Specialist` was used as if it could start an independent run — resolved: it is a delegation constraint within a Main Agent-owned Agent Run.
- `Agent Task` had no planning boundary — resolved: only a persisted Execution Plan can create Agent Tasks, while a Direct Run creates none.
- `Specialist context` could have meant the full Conversation — resolved: a Specialist sees only its immutable Context Pack.
- `Specialist delegation depth` implied nested control — resolved: Specialists never delegate; the Main Agent alone schedules follow-on tasks.
- `task failure` could have meant run failure — resolved: Required and Optional Tasks have different, visible failure propagation.
- `message during a run` was ambiguous — resolved: the user explicitly steers the active run or queues a Follow-up.
- `every user message creates a run` conflicted with Steering — resolved: only a Root Request creates a run.
- `tool timeout` could have meant safe failure — resolved: an unconfirmed external side effect is an Unknown Outcome and is never retried automatically.
