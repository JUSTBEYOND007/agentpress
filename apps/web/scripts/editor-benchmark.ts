import { performance } from 'node:perf_hooks';

import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';

const characterCount = boundedInteger(process.env.EDITOR_CHARACTERS, 100_000, 1, 1_000_000);
const schema = getSchema([StarterKit]);
const initial = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] });
let state = EditorState.create({ schema, doc: initial });

const insertStarted = performance.now();
state = state.apply(state.tr.insertText('文'.repeat(characterCount), 1));
const insertMs = performance.now() - insertStarted;
const serializeStarted = performance.now();
const serialized = JSON.stringify(state.doc.toJSON());
const serializeMs = performance.now() - serializeStarted;

process.stdout.write(
  `${JSON.stringify({
    characterCount,
    documentBytes: Buffer.byteLength(serialized),
    insertMs: round(insertMs),
    serializeMs: round(serializeMs),
    heapUsedMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
  })}\n`,
);

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Expected an integer between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
