'use client';

export function ArticleCanvas(): React.JSX.Element {
  return (
    <article className="article-canvas" contentEditable suppressContentEditableWarning>
      <h1>Agent 时代的长文创作</h1>
      <p className="article-lead">
        好的写作工具不应该替作者做决定，而应该让研究、组织、修改和核验都变得可见、可控。
      </p>
      <h2>从一次回答变成一次可靠执行</h2>
      <p>
        当任务涉及联网检索、资料引用和文章修改时，系统会先生成计划，再把边界清晰的任务交给不同
        Specialist。每一步都留下来源、状态和恢复点。
      </p>
      <blockquote>
        Agent 的价值不只是生成文字，而是在复杂任务中维持上下文、权限和结果质量。
      </blockquote>
      <h2>修改应该可以审阅</h2>
      <p>
        Agent
        对正文的调整首先形成提案。作者可以查看删除与新增内容，逐项接受或拒绝，并随时恢复到修改前版本。
      </p>
    </article>
  );
}
