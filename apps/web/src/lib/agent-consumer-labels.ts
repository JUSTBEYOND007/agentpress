const taskLabels: Readonly<Record<string, string>> = {
  researcher: '整理资料',
  writer: '撰写内容',
  editor: '优化文章',
  fact_checker: '核对事实',
  illustrator: '准备配图',
};

export function consumerTaskLabel(owner: string): string {
  return taskLabels[owner] ?? '处理任务';
}
