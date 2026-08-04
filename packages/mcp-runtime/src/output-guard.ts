import { Value } from '@sinclair/typebox/value';

import type { GuardedMcpOutput, McpOutputArtifactReference, McpToolContract } from './contracts.js';

const SECRET_PATTERN = /(authorization|api[_-]?key|access[_-]?token|secret|password)/i;

export function guardMcpOutput(
  value: unknown,
  contract?: Pick<McpToolContract, 'outputSchema'>,
  maxBytes = 256_000,
): GuardedMcpOutput {
  const redacted = redact(value);
  const encoded = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`MCP output exceeds ${String(maxBytes)} bytes`);
  }
  if (contract?.outputSchema && !Value.Check(contract.outputSchema, redacted)) {
    throw new Error('MCP output does not satisfy the declared schema');
  }
  return { value: redacted, bytes, redactions: countRedactions(value) };
}

export async function guardMcpOutputWithArtifact(
  value: unknown,
  contract: Pick<McpToolContract, 'outputSchema'> | undefined,
  options: {
    readonly maxBytes?: number;
    readonly writeArtifact?: (input: {
      readonly value: unknown;
      readonly bytes: number;
    }) => Promise<McpOutputArtifactReference>;
  } = {},
): Promise<GuardedMcpOutput> {
  const redacted = redact(value);
  const encoded = JSON.stringify(redacted);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  const maxBytes = options.maxBytes ?? 256_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('MCP output byte limit must be positive');
  }
  if (contract?.outputSchema && !Value.Check(contract.outputSchema, redacted)) {
    throw new Error('MCP output does not satisfy the declared schema');
  }
  const redactions = countRedactions(value);
  if (bytes <= maxBytes) return { value: redacted, bytes, redactions };
  if (!options.writeArtifact) {
    throw new Error(`MCP output exceeds ${String(maxBytes)} bytes`);
  }
  const artifact = await options.writeArtifact({ value: redacted, bytes });
  return {
    value: {
      artifactId: artifact.artifactId,
      versionId: artifact.versionId,
      uri: artifact.uri,
      bytes: artifact.bytes,
      summary: summarizeOversizedValue(redacted),
    },
    bytes,
    redactions,
    artifact,
  };
}

function summarizeOversizedValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= 1_000) return text;
  return `${text.slice(0, 997)}...`;
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function countRedactions(value: unknown, key?: string): number {
  if (key && SECRET_PATTERN.test(key)) {
    return 1;
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    let total = 0;
    for (const entry of entries) {
      total += countRedactions(entry);
    }
    return total;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).reduce(
      (total, [entryKey, entryValue]) => total + countRedactions(entryValue, entryKey),
      0,
    );
  }
  return 0;
}
