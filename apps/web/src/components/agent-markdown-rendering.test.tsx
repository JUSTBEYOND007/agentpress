import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { describe, expect, it } from 'vitest';

const plugins = { cjk, code, math, mermaid };

function render(markdown: string, mode: 'streaming' | 'static' = 'static'): string {
  return renderToStaticMarkup(
    <Streamdown linkSafety={{ enabled: true }} mode={mode} plugins={plugins}>
      {markdown}
    </Streamdown>,
  );
}

describe('Agent Markdown rendering contract', () => {
  it('renders the supported document structures and CJK text', () => {
    const html = render(`## 中文标题

**强调**

- 一
- 二

| 项目 | 值 |
| --- | --- |
| 公式 | $E=mc^2$ |

\`\`\`typescript
const value = 1
\`\`\`

\`\`\`mermaid
graph TD
A --> B
\`\`\``);

    expect(html).toContain('<h2');
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('<ul');
    expect(html).toContain('<table');
    expect(html).toContain('typescript');
    expect(html).toContain('animate-spin');
    expect(html).toContain('中文标题');
  });

  it('does not turn unsafe HTML or javascript links into executable markup', () => {
    const html = render(
      '<script>globalThis.compromised = true</script>\n[unsafe](javascript:alert(1))',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
  });

  it('renders incomplete streaming Markdown without throwing or dropping text', () => {
    expect(render('**尚未结束\n\n```ts\nconst x =', 'streaming')).toContain('尚未结束');
  });
});
