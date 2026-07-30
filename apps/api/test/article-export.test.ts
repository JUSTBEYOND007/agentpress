import { describe, expect, it } from 'vitest';

import { serializeDocument } from '../src/workspace/article-export.js';

describe('article export', () => {
  const document = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '<script>alert(1)</script> ' },
          {
            type: 'text',
            text: '安全链接',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '完成' }] }],
          },
        ],
      },
      {
        type: 'image',
        attrs: { src: 'https://example.com/a.png', alt: '"封面"', attribution: '<作者>' },
      },
    ],
  } as const;

  it('escapes untrusted HTML and rejects unsafe links', () => {
    const result = serializeDocument(document, 'html');
    expect(result).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result).not.toContain('javascript:');
    expect(result).toContain('alt="&quot;封面&quot;"');
    expect(result).toContain('<figcaption>&lt;作者&gt;</figcaption>');
  });

  it('exports structured Markdown', () => {
    const result = serializeDocument(document, 'markdown');
    expect(result).toContain('## 标题');
    expect(result).toContain('- [x] 完成');
    expect(result).toContain('!["封面"](https://example.com/a.png)');
  });
});
