import { readFile, readdir } from 'node:fs/promises';
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

async function checkDistDevelopmentContract(directory) {
  const packageJsonPath = join(directory, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (packageJson.main !== './dist/index.js') return true;

  const errors = [];
  if (typeof packageJson.scripts?.build !== 'string') {
    errors.push('missing a build script');
  }
  if (
    typeof packageJson.scripts?.dev !== 'string' ||
    !packageJson.scripts.dev.includes('--watch')
  ) {
    errors.push('missing a watch-mode dev script');
  }
  if (errors.length === 0) return true;

  process.stderr.write(`${packageJson.name ?? directory}: ${errors.join('; ')}\n`);
  return false;
}

const directories = (await Promise.all(workspaceRoots.flatMap(packageDirectories))).flat();
let failed = false;
for (const directory of directories) {
  if (!(await checkDistDevelopmentContract(directory))) failed = true;
  const code = await runPublint(directory);
  if (code !== 0) failed = true;
}
if (failed) process.exitCode = 1;
