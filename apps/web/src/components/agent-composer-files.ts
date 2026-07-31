const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'md', 'markdown', 'txt']);

export type PreparedComposerFiles = {
  readonly files: readonly File[];
  readonly message?: string;
};

export function prepareComposerFiles(
  input: readonly File[],
  remainingSlots: number,
): PreparedComposerFiles {
  if (remainingSlots <= 0) {
    return { files: [], message: '每次对话最多添加 10 个附件，请先移除部分文件。' };
  }
  const supported = input.filter((file) => {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    return SUPPORTED_EXTENSIONS.has(extension) && file.size <= MAX_ATTACHMENT_BYTES;
  });
  const files = supported.slice(0, remainingSlots);
  const rejectedCount = input.length - supported.length;
  const omittedCount = supported.length - files.length;
  if (rejectedCount > 0) {
    return {
      files,
      message: `${String(rejectedCount)} 个文件未添加，仅支持 20MB 以内的 PDF、Word、Markdown 和文本文件。`,
    };
  }
  if (omittedCount > 0) {
    return {
      files,
      message: `${String(omittedCount)} 个文件未添加，每次对话最多使用 10 个附件。`,
    };
  }
  return { files };
}
