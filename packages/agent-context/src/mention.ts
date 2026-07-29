import type { BoundMention, MentionTarget } from './contracts.js';
export type MentionStore = {
  authorize(workspaceId: string, actorId: string, targetId: string): Promise<boolean>;
  load(targetId: string): Promise<MentionTarget | undefined>;
};
export async function resolveMention(
  store: MentionStore,
  input: { workspaceId: string; actorId: string; targetId: string },
): Promise<BoundMention> {
  if (!(await store.authorize(input.workspaceId, input.actorId, input.targetId)))
    throw new Error('Mention target is not authorized');
  const target = await store.load(input.targetId);
  if (!target || target.deleted || target.workspaceId !== input.workspaceId)
    throw new Error('Mention target is missing or deleted');
  return {
    id: target.id,
    workspaceId: target.workspaceId,
    kind: target.kind,
    revision: target.revision,
    contentHash: target.contentHash,
  };
}
