import { describe, expect, it } from 'vitest';

import { artifactPreview } from './agent-artifact-drawer';

describe('artifactPreview', () => {
  it('adapts persisted structured artifact content without stringifying internal data', () => {
    expect(artifactPreview({ markdown: '# Research' })).toBe('# Research');
    expect(artifactPreview({ content: 'Draft body' })).toBe('Draft body');
    expect(artifactPreview({ toolCallId: 'private', payload: { secret: true } })).toBe('');
  });
});
