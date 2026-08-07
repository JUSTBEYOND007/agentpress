import { describe, expect, it } from 'vitest';

import {
  hashSkillRevisionContent,
  isSafeSkillResourcePath,
  loadSkill,
  loadStaticSkillResources,
} from '../src/index.js';

describe('Skill static resource boundary', () => {
  it.each([
    '../secret.md',
    'references/../../secret.md',
    '/etc/passwd',
    'references\\secret.md',
    './references.md',
    'references//secret.md',
  ])('rejects path traversal and non-relative resource path %s', (path) => {
    expect(isSafeSkillResourcePath(path)).toBe(false);
    expect(() => loadSkill(skillMarkdown([path]))).toThrow(/resource path/u);
  });

  it('fails closed on invalid UTF-8 bytes', () => {
    const skill = loadSkill(skillMarkdown(['references/a.md']));
    expect(() =>
      loadStaticSkillResources(skill, [
        {
          path: 'references/a.md',
          content: Uint8Array.from([0xc3, 0x28]),
          fileType: 'file',
        },
      ]),
    ).toThrow(/valid UTF-8/u);
  });

  it('enforces single-file and aggregate byte limits independently', () => {
    const skill = loadSkill(skillMarkdown(['references/a.md', 'references/b.md']));
    expect(() =>
      loadStaticSkillResources(
        skill,
        [file('references/a.md', '12345'), file('references/b.md', '1')],
        { maxFileBytes: 4, maxTotalBytes: 8 },
      ),
    ).toThrow(/file limit/u);
    expect(() =>
      loadStaticSkillResources(
        skill,
        [file('references/a.md', '1234'), file('references/b.md', '5678')],
        { maxFileBytes: 4, maxTotalBytes: 7 },
      ),
    ).toThrow(/total limit/u);
  });

  it('changes the revision hash when Markdown or discovered resource content changes', () => {
    const markdown = skillMarkdown(['references/a.md']);
    const skill = loadSkill(markdown);
    const firstResources = loadStaticSkillResources(skill, [file('references/a.md', 'first')]);
    const changedResources = loadStaticSkillResources(skill, [file('references/a.md', 'changed')]);
    const first = hashSkillRevisionContent(markdown, firstResources);

    expect(hashSkillRevisionContent(`${markdown}\nChanged instruction.`, firstResources)).not.toBe(first);
    expect(hashSkillRevisionContent(markdown, changedResources)).not.toBe(first);
    expect(changedResources[0]?.contentHash).not.toBe(firstResources[0]?.contentHash);
  });
});

function skillMarkdown(resources: readonly string[]): string {
  return `---\nid: resource-test\ndescription: Resource boundary test\nresources:\n${resources.map((path) => `  - ${path}`).join('\n')}\n---\nUse declared resources only.`;
}

function file(path: string, content: string) {
  return { path, content, fileType: 'file' as const };
}
