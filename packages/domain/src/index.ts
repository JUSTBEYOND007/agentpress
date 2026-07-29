export const PRODUCT_NAME = 'AgentPress';

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
