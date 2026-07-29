import { FormatRegistry, Type, type Static } from '@sinclair/typebox';

const RFC_3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set(
    'date-time',
    (value) => RFC_3339_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
  );
}

export const ServiceNameSchema = Type.Union([
  Type.Literal('api'),
  Type.Literal('agent-worker'),
  Type.Literal('async-worker'),
  Type.Literal('web'),
]);

export type ServiceName = Static<typeof ServiceNameSchema>;

export const HealthResponseSchema = Type.Object(
  {
    service: ServiceNameSchema,
    status: Type.Literal('ok'),
    timestamp: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'HealthResponse' },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
