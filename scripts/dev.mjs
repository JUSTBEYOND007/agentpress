import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

const migrationStatus = await run(pnpm, ['--filter', '@agentpress/database', 'db:migrate']);
if (migrationStatus !== 0) process.exit(migrationStatus);

const turbo = spawn(
  process.execPath,
  ['./node_modules/turbo/bin/turbo', 'run', 'dev', '--parallel', '--concurrency=100'],
  { stdio: 'inherit', env: process.env },
);

const stop = (signal) => turbo.kill(signal);
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
turbo.once('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
