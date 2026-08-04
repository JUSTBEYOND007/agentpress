import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const allowedExtensions = new Set(['.css', '.ts', '.tsx']);
const sourceLimit = 1000;
const agentModuleLimit = 500;
const oversized = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!allowedExtensions.has(extname(entry.name))) continue;
    const sourcePath = relative(sourceRoot, path);
    const lines = (await readFile(path, 'utf8')).split('\n').length;
    const isAgentModule =
      ['.ts', '.tsx'].includes(extname(entry.name)) &&
      /^(components|lib)\/(?:use-)?agent/u.test(sourcePath);
    const limit = isAgentModule ? agentModuleLimit : sourceLimit;
    if (lines > limit) oversized.push(`${sourcePath}: ${lines} lines (limit ${limit})`);
  }
}

await visit(sourceRoot);
if (oversized.length > 0) {
  process.stderr.write(`Source file length limits exceeded:\n${oversized.join('\n')}\n`);
  process.exitCode = 1;
}
