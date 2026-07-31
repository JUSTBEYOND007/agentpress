import { describe, expect, it } from 'vitest';

import { prepareComposerFiles } from './agent-composer-files';

describe('prepareComposerFiles', () => {
  it('accepts supported documents within the remaining slots', () => {
    const files = [new File(['a'], 'brief.pdf'), new File(['b'], 'notes.md')];
    expect(prepareComposerFiles(files, 2)).toEqual({ files });
  });

  it('rejects unsupported and oversized files without dropping valid files', () => {
    const valid = new File(['a'], 'brief.txt');
    const unsupported = new File(['b'], 'photo.png');
    const oversized = new File(['a'], 'large.pdf');
    Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 });
    const result = prepareComposerFiles([valid, unsupported, oversized], 10);
    expect(result.files).toEqual([valid]);
    expect(result.message).toContain('2 个文件未添加');
  });

  it('enforces the ten-attachment context limit', () => {
    const files = [new File(['a'], 'one.txt'), new File(['b'], 'two.txt')];
    const result = prepareComposerFiles(files, 1);
    expect(result.files).toEqual([files[0]]);
    expect(result.message).toContain('最多使用 10 个附件');
  });
});
