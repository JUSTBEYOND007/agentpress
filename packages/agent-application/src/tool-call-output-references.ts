import type { PersistedToolEvidence } from './tool-evidence-store.js';

export function boundedEvidenceReferences(
  references: readonly PersistedToolEvidence[],
): readonly Readonly<Record<string, string>>[] {
  return references.slice(0, 32).map((reference) => ({
    evidenceId: reference.evidenceId.slice(0, 240),
    title: reference.title.slice(0, 240),
    source: reference.source.slice(0, 240),
    sourceRevision: reference.sourceRevision.slice(0, 240),
  }));
}
