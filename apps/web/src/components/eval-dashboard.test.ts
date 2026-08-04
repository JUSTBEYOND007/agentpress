import { describe, expect, it } from 'vitest';

import { formatMetric } from './eval-dashboard';

describe('evaluation dashboard formatting', () => {
  it('formats result and process metrics without coercing missing values', () => {
    expect(formatMetric(0.875, 'percent')).toBe('87.5%');
    expect(formatMetric(12.34567, 'usd')).toBe('$12.3457');
    expect(formatMetric(1520, 'milliseconds')).toBe('1,520 ms');
    expect(formatMetric(null, 'number')).toBe('-');
  });
});
