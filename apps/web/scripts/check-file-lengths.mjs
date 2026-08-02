import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const allowedExtensions = new Set(['.css', '.ts', '.tsx']);
const limit = 1000;
const oversized = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!allowedExtensions.has(extname(entry.name))) continue;
    const lines = (await readFile(path, 'utf8')).split('\n').length;
    if (lines > limit) oversized.push(`${relative(sourceRoot, path)}: ${lines} lines`);
  }
}

await visit(sourceRoot);
if (oversized.length > 0) {
  process.stderr.write(`Source files must not exceed ${limit} lines:\n${oversized.join('\n')}\n`);
  process.exitCode = 1;
}
