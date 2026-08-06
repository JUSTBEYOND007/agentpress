import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const workspaceRoots = ['packages', 'apps'];

async function packageDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

function runPublint(directory) {
  return new Promise((resolve) => {
    const child = spawn(
      'pnpm',
      ['exec', 'publint', 'run', '--strict', '--pack', 'pnpm', directory],
      {
        stdio: 'inherit',
      },
    );
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const directories = (await Promise.all(workspaceRoots.flatMap(packageDirectories))).flat();
let failed = false;
for (const directory of directories) {
  const code = await runPublint(directory);
  if (code !== 0) failed = true;
}
if (failed) process.exitCode = 1;
