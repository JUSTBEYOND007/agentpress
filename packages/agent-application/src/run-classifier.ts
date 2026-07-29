export type RunClassification = {
  readonly mode: 'direct' | 'planned';
  readonly reasons: readonly string[];
};

const PLANNED_SIGNALS: readonly { readonly reason: string; readonly pattern: RegExp }[] = [
  {
    reason: 'retrieval',
    pattern: /联网|搜索|检索|查找|最新|实时|资料|来源|引用|research|search|rag/i,
  },
  { reason: 'article_change', pattern: /修改|改写|润色|编辑|重构|文章|长文|write|edit|rewrite/i },
  { reason: 'media', pattern: /图片|配图|插图|图文|封面|image|illustrat/i },
  { reason: 'tool', pattern: /工具|mcp|tool|发布|publish/i },
  {
    reason: 'delegation',
    pattern:
      /@(researcher|writer|editor|fact[_ -]?checker|illustrator)|@(研究员|写作者|编辑|事实核查|插画师)/i,
  },
];

export function classifyRun(prompt: string): RunClassification {
  const reasons = PLANNED_SIGNALS.filter(({ pattern }) => pattern.test(prompt)).map(
    ({ reason }) => reason,
  );
  return reasons.length > 0 ? { mode: 'planned', reasons } : { mode: 'direct', reasons: [] };
}
