# Specialists use least-privilege Context Packs

Each Specialist receives an immutable Context Pack assembled for one Agent Task rather than inheriting the full Conversation, workspace, or user memory. Specialists return structured Task Results and cannot directly change an Article; this costs explicit context assembly and result schemas, but limits privacy exposure, context pollution, token use, and uncontrolled side effects.
