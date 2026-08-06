import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import process from 'node:process';

const roots = [
  'packages/agent-runtime/src',
  'packages/agent-application/src',
  'packages/editor-application/src',
  'apps/agent-worker/src',
];
const limit = 500;
const oversized = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!['.ts', '.tsx'].includes(extname(entry.name))) continue;
    const source = await readFile(path, 'utf8');
    const lines = source.length === 0 ? 0 : source.split('\n').length - Number(source.endsWith('\n'));
    if (lines > limit) oversized.push(`${path}: ${lines} lines (limit ${limit})`);
  }
}

for (const root of roots) await visit(root);
if (oversized.length > 0) {
  process.stderr.write(`Agent-facing source file limits exceeded:\n${oversized.join('\n')}\n`);
  process.exitCode = 1;
}
