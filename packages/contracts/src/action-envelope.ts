import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const ActionSourceSchema = Type.Union([Type.Literal('free_text'), Type.Literal('button')]);

export const RequestedIntentSchema = Type.Literal('article_edit');

export const ActionSelectedBlockSchema = Type.Object(
  {
    blockId: Type.String({ minLength: 1, maxLength: 160 }),
    contentHash: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const ArticleEditActionPayloadSchema = Type.Object(
  {
    instruction: Type.String({ minLength: 1, maxLength: 100_000 }),
    articleId: Type.String({ pattern: UUID_PATTERN }),
    baseRevisionId: Type.String({ pattern: UUID_PATTERN }),
    selectedBlocks: Type.Array(ActionSelectedBlockSchema, { maxItems: 200 }),
  },
  { additionalProperties: false },
);

export const ActionEnvelopeV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    source: ActionSourceSchema,
    requestedIntent: Type.Optional(RequestedIntentSchema),
    actionProposalId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
    payload: Type.Optional(ArticleEditActionPayloadSchema),
    grantedCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false, $id: 'ActionEnvelopeV1' },
);

export type ActionSource = Static<typeof ActionSourceSchema>;
export type RequestedIntent = Static<typeof RequestedIntentSchema>;
export type ActionSelectedBlock = Static<typeof ActionSelectedBlockSchema>;
export type ArticleEditActionPayload = Static<typeof ArticleEditActionPayloadSchema>;
export type ActionEnvelopeV1 = Static<typeof ActionEnvelopeV1Schema>;

export function createFreeTextActionEnvelope(): ActionEnvelopeV1 {
  return { version: 1, source: 'free_text', grantedCapabilities: [] };
}

export function parseActionEnvelope(value: unknown): ActionEnvelopeV1 {
  if (!Value.Check(ActionEnvelopeV1Schema, value)) {
    throw new TypeError('Invalid ActionEnvelopeV1');
  }
  const envelope = value;
  if (envelope.source === 'free_text') {
    if (
      envelope.requestedIntent !== undefined ||
      envelope.actionProposalId !== undefined ||
      envelope.payload !== undefined ||
      envelope.grantedCapabilities.length > 0
    ) {
      throw new TypeError('Free-text turns cannot grant a confirmed action');
    }
    return envelope;
  }
  if (
    envelope.requestedIntent !== 'article_edit' ||
    envelope.actionProposalId === undefined ||
    envelope.payload === undefined ||
    envelope.grantedCapabilities.length === 0
  ) {
    throw new TypeError('Button turns require a complete confirmed action');
  }
  return envelope;
}
