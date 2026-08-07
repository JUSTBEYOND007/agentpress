import { describe, expect, it } from 'vitest';

import {
  createResearchPlan,
  deduplicateResearchHits,
  researchExecutionPolicy,
} from '../src/index.js';

describe('research execution policy', () => {
  it('owns bounded query expansion by research depth', () => {
    const plan = createResearchPlan({
      topic: '  Agent   systems ',
      purpose: 'general',
      depth: 'quick',
      expandedQueries: ['agent systems', 'agent systems safety', 'unused third query'],
    });
    expect(plan.queries).toEqual(['Agent systems', 'agent systems safety']);
    expect(plan.policy).toMatchObject({ maxQueries: 2, maxSources: 5, fetchConcurrency: 2 });
  });

  it('deduplicates canonical URLs before applying the source budget', () => {
    const hits = deduplicateResearchHits(
      [
        hit('https://example.com/a?utm_source=test#section'),
        hit('https://example.com/a'),
        hit('https://example.com/b'),
      ],
      2,
    );
    expect(hits.map(({ url }) => url)).toEqual([
      'https://example.com/a?utm_source=test#section',
      'https://example.com/b',
    ]);
  });

  it('exposes immutable depth budgets to provider adapters and Agent runtimes', () => {
    expect(researchExecutionPolicy('deep')).toEqual({
      maxQueries: 8,
      resultsPerQuery: 2,
      maxSources: 24,
      fetchConcurrency: 6,
      maxSourceBytes: 1_000_000,
      maxSynthesisTokens: 6_000,
    });
  });
});

function hit(url: string) {
  return { title: url, url, excerpt: '', provider: 'test' };
}
