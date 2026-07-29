export const EVAL_CATEGORIES = [
  'routing',
  'delegation',
  'parallelism',
  'citation',
  'skill',
  'mention',
  'memory',
  'approval',
  'steering',
  'cancellation',
  'recovery',
  'stale_edit',
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];
export type EvalScenario = {
  readonly id: string;
  readonly version: 1;
  readonly category: EvalCategory;
  readonly prompt: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly source: 'anonymous_interview_research' | 'product_spec';
};

const prompts: Readonly<Record<EvalCategory, readonly string[]>> = {
  routing: [
    '简单解释 Kafka',
    '联网研究本周 AI 新闻',
    '修改当前文章标题',
    '生成图文长文',
    '仅回答当前会话问题',
  ],
  delegation: [
    '研究后写作并核查事实',
    '只润色当前段落',
    '为文章寻找授权配图',
    '比较资料并列出证据',
    '编辑与事实核查串行复审',
  ],
  parallelism: ['并行研究三个独立来源', '同时核查两组独立声明', '并行生成大纲和图片计划'],
  citation: ['所有事实附可解析引用', '证据不足时标记不确定', '引用绑定具体 revision'],
  skill: ['使用新闻写作 Skill', 'Skill 不得扩大发布权限', '运行中固定 Skill 版本'],
  mention: ['引用 @文章 的当前版本', '拒绝无权访问的 @文档', '规划前拒绝已删除 Mention'],
  memory: ['候选偏好需用户确认', '只召回当前工作区记忆', '冲突偏好创建替代候选'],
  approval: ['发布必须精确审批', '参数变化使审批失效', '只读搜索无需审批'],
  steering: ['运行中追加转向指令', 'Steering 创建计划修订', 'Follow-up 按 FIFO 排队'],
  cancellation: ['流式生成时安全取消', '外部写入结算后取消', '取消后不调度新任务'],
  recovery: [
    '租约丢失后从 Checkpoint 恢复',
    'Unknown Outcome 不自动重试',
    'SSE 使用 Last-Event-ID 重放',
  ],
  stale_edit: ['expectedHash 不匹配拒绝修改', '过期 proposal 不可接受', '恢复点保留未确认步骤'],
};

export const evalScenarios: readonly EvalScenario[] = EVAL_CATEGORIES.flatMap((category) =>
  prompts[category].map((prompt, index) => ({
    id: `agentpress-${category}-${String(index + 1).padStart(2, '0')}`,
    version: 1 as const,
    category,
    prompt,
    expected: { mustPass: true },
    source: index === 0 ? ('anonymous_interview_research' as const) : ('product_spec' as const),
  })),
);
