import { describe, expect, it } from 'vitest';

import { artifactPreview, structuredArtifactFields } from './agent-artifact-content';

describe('artifactPreview', () => {
  it('adapts persisted structured artifact content without stringifying internal data', () => {
    expect(artifactPreview({ markdown: '# Research' })).toBe('# Research');
    expect(artifactPreview({ content: 'Draft body' })).toBe('Draft body');
    expect(artifactPreview({ toolCallId: 'private', payload: { secret: true } })).toBe('');
  });
});

describe('structuredArtifactFields', () => {
  it('renders domain summaries while omitting opaque internal objects', () => {
    expect(
      structuredArtifactFields({ sections: [{ heading: '开篇' }], toolState: { id: 'private' } }),
    ).toEqual([{ label: '章节', values: ['开篇'] }]);
  });
});
