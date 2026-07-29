# Main Agent owns every Agent Run

Every Root Request creates one Agent Run owned by the Main Agent. Steering Instructions attach to that active run, while Follow-ups create later runs; mentioning a Specialist constrains delegation rather than invoking an independent agent. Specialists are stateless workers that receive immutable Task Briefs and return structured Artifacts and Evidence, keeping conversation ownership, approval, cancellation, recovery, and quota accounting unambiguous.
