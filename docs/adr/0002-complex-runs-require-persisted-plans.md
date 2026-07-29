# Complex runs require persisted plans

An Agent Run is either a Direct Run with no delegation, retrieval, external tools, or article changes, or a Planned Run governed by a persisted, user-visible Execution Plan. Planned work is represented as dependency-ordered Agent Tasks, and replanning creates an immutable Plan Revision; this adds state-machine complexity but makes multi-agent behavior observable, recoverable, and auditable without exposing private chain-of-thought.
