import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const component = process.argv[2];
if (!['kafka', 'redis'].includes(component)) {
  throw new Error('Usage: CONFIRM_LOCAL_FAULT_DRILL=1 node scripts/fault-drill.mjs <kafka|redis>');
}
if (process.env.CONFIRM_LOCAL_FAULT_DRILL !== '1') {
  throw new Error('Set CONFIRM_LOCAL_FAULT_DRILL=1 to disrupt a local dependency');
}

await run(['stop', component]);
try {
  process.stdout.write(
    `${component} stopped; inspect API/Worker degradation and durable state now.\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 5_000));
} finally {
  await run(['start', component]);
  await run(['up', '-d', '--wait', component]);
  await run(['ps', component]);
}

async function run(arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...arguments_], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose failed (${signal ?? String(code)})`));
    });
  });
}
