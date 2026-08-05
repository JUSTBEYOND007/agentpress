export const EVAL_CATEGORIES = [
  'routing',
  'delegation',
  'parallelism',
  'tool',
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
  readonly actionProposal?: 'required' | 'forbidden' | 'optional';
  readonly requiredToolIds?: readonly string[];
  readonly maxToolCalls?: number;
};
export type EvalScenario = {
  readonly id: string;
  readonly version: 3;
  readonly category: EvalCategory;
  readonly prompt: string;
  readonly setup?: {
    readonly bindArticle?: boolean;
    readonly confirmedArticleEdit?: boolean;
    readonly priorTurns?: readonly {
      readonly user: string;
      readonly assistant: string;
    }[];
  };
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
    '将当前文章标题修改为《真实 Pi Agent 实践指南》',
    expectation(['direct'], [], [], [], 'optional', 'optional', undefined, undefined, 'required'),
    { bindArticle: true },
  ),
  scenario(
    'routing-04',
    'routing',
    '以下要点已确认，无需研究、核查、联网或修改现有文章：真实 Pi Agent 由模型、工具、消息历史和事件循环组成，模型通过真实 tool call 自主推进任务。请基于这些要点新生成一篇图文长文。',
    expectation(
      ['planned'],
      ['writer', 'illustrator'],
      ['image.generate'],
      ['ArticleDraft', 'ImagePlan'],
      'optional',
      'required',
    ),
  ),
  scenario('routing-05', 'routing', '仅回答当前会话问题：Kafka 的消费者组有什么作用？', direct),
  scenario('routing-06', 'routing', '你好', direct, {
    bindArticle: true,
    priorTurns: [
      {
        user: '续写当前文章的下一段',
        assistant: '已完成续写，并生成了一项正文修改提案。',
      },
    ],
  }),
  scenario(
    'routing-07',
    'routing',
    '继续上一段',
    expectation(['direct'], [], [], [], 'optional', 'optional', undefined, undefined, 'required'),
    {
      bindArticle: true,
      priorTurns: [
        {
          user: '续写当前文章的下一段',
          assistant: '已完成第一段续写。',
        },
      ],
    },
  ),
  scenario(
    'routing-08',
    'routing',
    '继续上一段',
    expectation(['planned'], ['editor'], ['article.propose'], ['EditProposal']),
    { bindArticle: true, confirmedArticleEdit: true },
  ),
  scenario(
    'delegation-01',
    'delegation',
    '研究 Kafka 消费者组再均衡的工作机制，基于可引用来源撰写一篇 800 字中文技术解读，并由事实核查角色复核关键声明。',
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
    '只润色当前文章的第一段，使其更简洁；不要联网研究或增加事实。',
    expectation(['direct'], [], [], [], 'optional', 'optional', undefined, undefined, 'required'),
    { bindArticle: true },
  ),
  scenario(
    'delegation-03',
    'delegation',
    '为一篇介绍上海天文馆的文章交付两份相互独立的成果：一份由写作角色完成的三段式内容大纲，以及一份由视觉角色完成的配图计划（画面、构图、尺寸、无障碍替代文本和许可要求）。不搜索、导入或生成素材。',
    expectation(['planned'], ['writer', 'illustrator'], [], ['Outline', 'ImagePlan']),
  ),
  scenario(
    'delegation-04',
    'delegation',
    '为当前文章同时交付两项相互独立的成果：将 Kafka exactly-once 段落改成不超过 120 字的准确表述并生成可审阅修改提案；另行制定一份解释 Kafka 事务边界的配图计划，包含构图、尺寸和无障碍替代文本。不联网搜索、导入或生成素材。',
    expectation(
      ['planned'],
      ['editor', 'illustrator'],
      [],
      ['EditProposal', 'ImagePlan'],
    ),
    { bindArticle: true },
  ),
  scenario(
    'delegation-05',
    'delegation',
    '先编辑当前文章中关于 Kafka exactly-once 语义的段落，再由事实核查角色按以下给定验收规则复核编辑结果：保证只适用于 Kafka 事务性读-处理-写链路；外部数据库或 HTTP 副作用仍需幂等或去重；不得声称所有消费端在任何情况下都绝不重复。本用例只核对给定规则，不联网检索。',
    expectation(
      ['planned'],
      ['editor', 'fact_checker'],
      [],
      ['EditProposal', 'ClaimReview'],
      'optional',
    ),
    { bindArticle: true },
  ),
  scenario(
    'parallelism-01',
    'parallelism',
    '并行处理三份给定材料并分别形成 ResearchBrief，最后由写作角色合并为 ArticleDraft。每个 Specialist 的 Task Brief 必须逐字包含它所需的材料，不得只写“材料 A/B/C”：材料 A = “组成员变化会触发分区重新分配”；材料 B = “cooperative rebalance 可渐进转移分区”；材料 C = “消费者协议由 coordinator 计算分配”。不联网检索。',
    expectation(
      ['planned'],
      ['researcher', 'writer'],
      [],
      ['ResearchBrief', 'ArticleDraft'],
    ),
  ),
  scenario(
    'parallelism-02',
    'parallelism',
    '基于当前文章修订交付两项互不依赖、可并行执行的成果：Editor 将 exactly-once 段落改为准确的 120 字内表述并生成可审阅 EditProposal；Illustrator 基于当前 revision 独立输出解释事务边界的 ImagePlan，包含构图、尺寸和无障碍替代文本。两者不得互相依赖，不联网搜索、导入或生成素材。',
    expectation(['planned'], ['editor', 'illustrator'], [], ['EditProposal', 'ImagePlan']),
    { bindArticle: true },
  ),
  scenario(
    'parallelism-03',
    'parallelism',
    '为一篇“城市夜间经济”专题并行生成文章大纲和配套图片计划，两个结果互不依赖，最后汇总。',
    expectation(['planned'], ['writer', 'illustrator'], [], ['Outline', 'ImagePlan']),
  ),
  scenario(
    'tool-01',
    'tool',
    '将当前文章的 Kafka exactly-once 段落改为准确且不超过 120 字的表述，只生成可审阅修改提案，不直接发布。',
    {
      ...expectation(
        ['direct'],
        [],
        [],
        [],
        'optional',
        'optional',
        undefined,
        undefined,
        'required',
      ),
      requiredToolIds: ['article.read_current', 'article.propose_edits'],
      maxToolCalls: 2,
    },
    { bindArticle: true },
  ),
  scenario(
    'tool-02',
    'tool',
    '先读取当前文章并由 Editor 生成 exactly-once 段落的可审阅修改提案，同时由 Illustrator 独立输出事务边界配图计划；不联网、导入或生成图片。',
    {
      ...expectation(
        ['planned'],
        ['editor', 'illustrator'],
        [],
        ['EditProposal', 'ImagePlan'],
      ),
      requiredToolIds: ['article.read_current', 'article.propose_edits'],
      maxToolCalls: 4,
    },
    { bindArticle: true },
  ),
  scenario(
    'tool-03',
    'tool',
    '只解释 Kafka 消费者组的作用，不读取或修改文章，不联网，也不要调用任何工具。',
    {
      ...expectation(['direct']),
      requiredToolIds: [],
      maxToolCalls: 0,
    },
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
      ['article.propose'],
      ['EditProposal'],
      'optional',
      'required',
      undefined,
      'stale_edit',
    ),
    { bindArticle: true, confirmedArticleEdit: true },
  ),
  scenario(
    'stale-edit-02',
    'stale_edit',
    '过期 proposal 不可接受',
    expectation(
      ['planned'],
      ['editor'],
      ['article.propose'],
      ['EditProposal'],
      'optional',
      'required',
      undefined,
      'stale_edit',
    ),
    { bindArticle: true, confirmedArticleEdit: true },
  ),
  scenario(
    'stale-edit-03',
    'stale_edit',
    '恢复点保留未确认步骤',
    expectation(
      ['planned'],
      ['editor'],
      ['article.propose'],
      ['EditProposal'],
      'optional',
      'required',
      'checkpoint',
    ),
    { bindArticle: true, confirmedArticleEdit: true },
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
  actionProposal: EvalExpectation['actionProposal'] = 'optional',
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
    actionProposal,
  };
}

function scenario(
  id: string,
  category: EvalCategory,
  prompt: string,
  expected: EvalExpectation,
  setup?: EvalScenario['setup'],
): EvalScenario {
  return {
    id: `agentpress-${id}`,
    version: 3,
    category,
    prompt,
    ...(setup ? { setup } : {}),
    expected,
    source: id.endsWith('01') ? 'anonymous_interview_research' : 'product_spec',
  };
}
