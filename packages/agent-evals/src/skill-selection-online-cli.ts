import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PiSkillPreselector } from '@agentpress/agent-application';

import { loadOnlineModelConfiguration } from './online-model-configuration.js';
import { runSkillSelectionEvals, skillSelectionEvalCases } from './skill-selection-eval.js';

const { values } = parseArgs({
  options: {
    limit: { type: 'string', default: String(skillSelectionEvalCases.length) },
    'output-dir': { type: 'string', default: '.agentpress/evals' },
  },
  strict: true,
});
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > skillSelectionEvalCases.length) {
  throw new Error(`limit must be between 1 and ${String(skillSelectionEvalCases.length)}`);
}
const configuration = loadOnlineModelConfiguration();
const model = configuration.proModel;
const evaluator = new PiSkillPreselector({ create: () => configuration.create(model) });
const report = await runSkillSelectionEvals({ evaluator, model, maxCases: limit });
const outputDirectory = resolve(values['output-dir']);
await mkdir(outputDirectory, { recursive: true });
const stamp = report.startedAt.replaceAll(/[:.]/gu, '-');
const safeModel = model.replaceAll(/[^a-zA-Z0-9._-]/gu, '_');
const path = resolve(outputDirectory, `${stamp}-${safeModel}-skill-selection.json`);
await writeFile(path, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8');
console.log(
  JSON.stringify({ report: path, totals: report.totals, gatesPassed: report.gatesPassed }),
);
if (!report.gatesPassed) process.exitCode = 1;
