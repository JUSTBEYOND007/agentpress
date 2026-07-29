# Product runtime owns Agent durability

Pi Agent Core is the execution engine, but AgentPress owns Conversations, plans, tasks, tool calls, approvals, checkpoints, usage, and run events in PostgreSQL. Pi sessions and provider streams are not the system of record; interrupted work is reconstructed from AgentPress checkpoints, and only operations proven idempotent may be replayed automatically. This adds an adapter and persistence layer but prevents framework churn or a lost worker from corrupting product state.
