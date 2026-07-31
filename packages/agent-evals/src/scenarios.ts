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
export type EvalRole = 'researcher' | 'writer' | 'editor' | 'fact_checker' | 'illustrator';
export type EvalExpectation = {
  readonly allowedModes: readonly ('direct' | 'planned')[];
  readonly requiredRoles: readonly EvalRole[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredArtifactTypes: readonly string[];
  readonly evidence: 'required' | 'optional' | 'forbidden';
  readonly approval: 'required' | 'forbidden' | 'optional';
  readonly recovery?: 'checkpoint' | 'outcome_unknown' | 'event_replay';
  readonly mustReject?: 'unauthorized_context' | 'stale_edit' | 'approval_mismatch';
};
export type EvalScenario = {
  readonly id: string;
  readonly version: 2;
  readonly category: EvalCategory;
  readonly prompt: string;
  readonly expected: EvalExpectation;
  readonly source: 'anonymous_interview_research' | 'product_spec';
};

const direct = expectation(['direct']);
const planned = expectation(['planned']);

export const evalScenarios: readonly EvalScenario[] = [
  scenario('routing-01', 'routing', '简单解释 Kafka', direct),
  scenario(
    'routing-02',
    'routing',
    '联网研究本周 AI 新闻',
    expectation(['planned'], ['researcher'], ['web.research'], [], 'required'),
  ),
  scenario(
    'routing-03',
    'routing',
    '修改当前文章标题',
    expectation(['planned'], ['editor'], ['article.edit'], ['EditProposal']),
  ),
  scenario(
    'routing-04',
    'routing',
    '生成图文长文',
    expectation(
      ['planned'],
      ['writer', 'illustrator'],
      ['media.generate'],
      ['ArticleDraft', 'ImagePlan'],
    ),
  ),
  scenario('routing-05', 'routing', '仅回答当前会话问题', direct),
  scenario(
    'delegation-01',
    'delegation',
    '研究后写作并核查事实',
    expectation(
      ['planned'],
      ['researcher', 'writer', 'fact_checker'],
      [],
      ['ResearchBrief', 'ArticleDraft', 'ClaimReview'],
      'required',
    ),
  ),
  scenario(
    'delegation-02',
    'delegation',
    '只润色当前段落',
    expectation(['planned'], ['editor'], ['article.edit'], ['EditProposal']),
  ),
  scenario(
    'delegation-03',
    'delegation',
    '为文章寻找授权配图',
    expectation(['planned'], ['illustrator'], ['media.search'], ['AssetProposal'], 'required'),
  ),
  scenario(
    'delegation-04',
    'delegation',
    '比较资料并列出证据',
    expectation(['planned'], ['researcher'], ['web.research'], ['ResearchBrief'], 'required'),
  ),
  scenario(
    'delegation-05',
    'delegation',
    '编辑与事实核查串行复审',
    expectation(
      ['planned'],
      ['editor', 'fact_checker'],
      [],
      ['EditProposal', 'ClaimReview'],
      'required',
    ),
  ),
  scenario(
    'parallelism-01',
    'parallelism',
    '并行研究三个独立来源',
    expectation(['planned'], ['researcher'], ['web.research'], ['ResearchBrief'], 'required'),
  ),
  scenario(
    'parallelism-02',
    'parallelism',
    '同时核查两组独立声明',
    expectation(['planned'], ['fact_checker'], [], ['ClaimReview'], 'required'),
  ),
  scenario(
    'parallelism-03',
    'parallelism',
    '并行生成大纲和图片计划',
    expectation(['planned'], ['writer', 'illustrator'], [], ['Outline', 'ImagePlan']),
  ),
  scenario(
    'citation-01',
    'citation',
    '所有事实附可解析引用',
    expectation(['planned'], ['researcher'], ['web.research'], [], 'required'),
  ),
  scenario(
    'citation-02',
    'citation',
    '证据不足时标记不确定',
    expectation(['planned'], ['fact_checker'], [], ['ClaimReview'], 'required'),
  ),
  scenario(
    'citation-03',
    'citation',
    '引用绑定具体 revision',
    expectation(['planned'], ['researcher'], [], [], 'required'),
  ),
  scenario('skill-01', 'skill', '使用新闻写作 Skill', planned),
  scenario(
    'skill-02',
    'skill',
    'Skill 不得扩大发布权限',
    expectation(['planned'], [], [], [], 'optional', 'required'),
  ),
  scenario('skill-03', 'skill', '运行中固定 Skill 版本', planned),
  scenario('mention-01', 'mention', '引用 @文章 的当前版本', planned),
  scenario(
    'mention-02',
    'mention',
    '拒绝无权访问的 @文档',
    expectation(['planned'], [], [], [], 'optional', 'optional', undefined, 'unauthorized_context'),
  ),
  scenario(
    'mention-03',
    'mention',
    '规划前拒绝已删除 Mention',
    expectation(['planned'], [], [], [], 'optional', 'optional', undefined, 'unauthorized_context'),
  ),
  scenario('memory-01', 'memory', '候选偏好需用户确认', planned),
  scenario('memory-02', 'memory', '只召回当前工作区记忆', planned),
  scenario('memory-03', 'memory', '冲突偏好创建替代候选', planned),
  scenario(
    'approval-01',
    'approval',
    '发布必须精确审批',
    expectation(['planned'], [], ['publication.write'], [], 'optional', 'required'),
  ),
  scenario(
    'approval-02',
    'approval',
    '参数变化使审批失效',
    expectation(['planned'], [], [], [], 'optional', 'required', undefined, 'approval_mismatch'),
  ),
  scenario(
    'approval-03',
    'approval',
    '只读搜索无需审批',
    expectation(['planned'], ['researcher'], ['web.research'], [], 'required', 'forbidden'),
  ),
  scenario('steering-01', 'steering', '运行中追加转向指令', planned),
  scenario('steering-02', 'steering', 'Steering 创建计划修订', planned),
  scenario('steering-03', 'steering', 'Follow-up 按 FIFO 排队', planned),
  scenario(
    'cancellation-01',
    'cancellation',
    '流式生成时安全取消',
    expectation(['direct', 'planned']),
  ),
  scenario(
    'cancellation-02',
    'cancellation',
    '外部写入结算后取消',
    expectation(['planned'], [], [], [], 'optional', 'required'),
  ),
  scenario('cancellation-03', 'cancellation', '取消后不调度新任务', expectation(['planned'])),
  scenario(
    'recovery-01',
    'recovery',
    '租约丢失后从 Checkpoint 恢复',
    expectation(['planned'], [], [], [], 'optional', 'optional', 'checkpoint'),
  ),
  scenario(
    'recovery-02',
    'recovery',
    'Unknown Outcome 不自动重试',
    expectation(['planned'], [], [], [], 'optional', 'required', 'outcome_unknown'),
  ),
  scenario(
    'recovery-03',
    'recovery',
    'SSE 使用 Last-Event-ID 重放',
    expectation(['direct', 'planned'], [], [], [], 'optional', 'optional', 'event_replay'),
  ),
  scenario(
    'stale-edit-01',
    'stale_edit',
    'expectedHash 不匹配拒绝修改',
    expectation(
      ['planned'],
      ['editor'],
      ['article.edit'],
      ['EditProposal'],
      'optional',
      'required',
      undefined,
      'stale_edit',
    ),
  ),
  scenario(
    'stale-edit-02',
    'stale_edit',
    '过期 proposal 不可接受',
    expectation(
      ['planned'],
      ['editor'],
      ['article.edit'],
      ['EditProposal'],
      'optional',
      'required',
      undefined,
      'stale_edit',
    ),
  ),
  scenario(
    'stale-edit-03',
    'stale_edit',
    '恢复点保留未确认步骤',
    expectation(
      ['planned'],
      ['editor'],
      ['article.edit'],
      ['EditProposal'],
      'optional',
      'required',
      'checkpoint',
    ),
  ),
];

function expectation(
  allowedModes: EvalExpectation['allowedModes'],
  requiredRoles: EvalExpectation['requiredRoles'] = [],
  requiredCapabilities: EvalExpectation['requiredCapabilities'] = [],
  requiredArtifactTypes: EvalExpectation['requiredArtifactTypes'] = [],
  evidence: EvalExpectation['evidence'] = 'optional',
  approval: EvalExpectation['approval'] = 'optional',
  recovery?: EvalExpectation['recovery'],
  mustReject?: EvalExpectation['mustReject'],
): EvalExpectation {
  return {
    allowedModes,
    requiredRoles,
    requiredCapabilities,
    requiredArtifactTypes,
    evidence,
    approval,
    ...(recovery ? { recovery } : {}),
    ...(mustReject ? { mustReject } : {}),
  };
}

function scenario(
  id: string,
  category: EvalCategory,
  prompt: string,
  expected: EvalExpectation,
): EvalScenario {
  return {
    id: `agentpress-${id}`,
    version: 2,
    category,
    prompt,
    expected,
    source: id.endsWith('01') ? 'anonymous_interview_research' : 'product_spec',
  };
}
