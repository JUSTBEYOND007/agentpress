import { createHash } from 'node:crypto';

export type ToolLoopGuardDecision =
  | { readonly allow: true; readonly signature: string; readonly consecutive: number }
  | {
      readonly allow: false;
      readonly signature: string;
      readonly consecutive: number;
      readonly reason: string;
    };

/** Guards only consecutive identical calls; legitimate calls separated by another tool are allowed. */
export class ToolLoopGuard {
  private previousSignature: string | undefined;
  private consecutive = 0;

  public constructor(private readonly maxConsecutiveIdenticalCalls = 3) {
    if (!Number.isSafeInteger(maxConsecutiveIdenticalCalls) || maxConsecutiveIdenticalCalls < 2) {
      throw new RangeError('Tool loop guard limit must be an integer >= 2');
    }
  }

  public observe(
    toolName: string,
    arguments_: Readonly<Record<string, unknown>>,
  ): ToolLoopGuardDecision {
    const signature = `${toolName}:${canonicalHash(arguments_)}`;
    if (signature === this.previousSignature) {
      this.consecutive += 1;
    } else {
      this.previousSignature = signature;
      this.consecutive = 1;
    }
    if (this.consecutive > this.maxConsecutiveIdenticalCalls) {
      return {
        allow: false,
        signature,
        consecutive: this.consecutive,
        reason: `Repeated identical tool call exceeded ${String(this.maxConsecutiveIdenticalCalls)} attempts`,
      };
    }
    return { allow: true, signature, consecutive: this.consecutive };
  }
}

function canonicalHash(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Tool arguments cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Tool arguments must be JSON-compatible');
}
