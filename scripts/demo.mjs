import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const environmentPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (!(await exists(environmentPath))) {
  await copyFile(examplePath, environmentPath, constants.COPYFILE_EXCL);
  process.stdout.write('Created .env from .env.example\n');
}

const fileEnvironment = parseEnv(await readFile(environmentPath, 'utf8'));
const environment = { ...fileEnvironment, ...process.env };

await run('docker', ['compose', 'up', '-d', '--wait']);
await run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@agentpress/demo-kit...']);
await run('node', ['packages/database/dist/migrate.js']);
await run('node', ['packages/demo-kit/dist/seed.js']);

if (!process.argv.includes('--prepare-only')) {
  await run('pnpm', ['dev']);
}

async function run(command, arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? String(code)})`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
