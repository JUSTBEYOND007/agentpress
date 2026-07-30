'use client';

import {
  Bot,
  ChevronDown,
  FileText,
  History,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';

import { AgentWorkbench } from '../components/agent-workbench';
import { ArticleCanvas } from '../components/article-canvas';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const userId = process.env.NEXT_PUBLIC_DEMO_USER_ID ?? '00000000-0000-4000-8000-000000000001';

type WorkspaceArticle = {
  readonly id: string;
  readonly title: string;
  readonly revisionId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
  readonly conversationId?: string;
  readonly branchId?: string;
};

type View = 'workspace' | 'search' | 'recent';

export default function WorkspacePage(): React.JSX.Element {
  const [articles, setArticles] = useState<readonly WorkspaceArticle[]>([]);
  const [activeArticleId, setActiveArticleId] = useState<string>();
  const [view, setView] = useState<View>('workspace');
  const [agentOpen, setAgentOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newArticleOpen, setNewArticleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void fetch(`${apiUrl}/workspaces/${workspaceId}/articles`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`文章列表加载失败 (${String(response.status)})`);
        return (await response.json()) as WorkspaceArticle[];
      })
      .then((items) => {
        setArticles(items);
        setActiveArticleId((current) => current ?? items[0]?.id);
      })
      .catch((reason: unknown) =>
        { setError(reason instanceof Error ? reason.message : '文章列表加载失败'); },
      );
  }, []);

  const activeArticle = articles.find((article) => article.id === activeArticleId) ?? articles[0];
  const filteredArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return query.length === 0
      ? articles
      : articles.filter((article) => article.title.toLowerCase().includes(query));
  }, [articles, searchQuery]);
  const listedArticles =
    view === 'search'
      ? filteredArticles
      : [...articles].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  async function createArticle(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    try {
      const response = await fetch(`${apiUrl}/workspaces/${workspaceId}/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: newTitle, userId }),
      });
      if (!response.ok) throw new Error(`创建文章失败 (${String(response.status)})`);
      const article = (await response.json()) as WorkspaceArticle;
      setArticles((current) => [article, ...current]);
      setActiveArticleId(article.id);
      setNewTitle('');
      setNewArticleOpen(false);
      setView('workspace');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建文章失败');
    }
  }

  function selectArticle(articleId: string): void {
    setActiveArticleId(articleId);
    setView('workspace');
    setSearchQuery('');
  }

  function openView(nextView: View): void {
    setView(nextView);
    setSettingsOpen(false);
    setMenuOpen(false);
  }

  return (
    <main className={agentOpen ? 'workspace' : 'workspace agent-closed'}>
      <aside className="sidebar" aria-label="工作区导航">
        <div className="workspace-name">
          <span className="brand-mark">A</span>
          <span>AgentPress</span>
          <ChevronDown aria-hidden="true" size={15} />
        </div>

        <nav className="primary-nav">
          <button
            className={view === 'workspace' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => {
              openView('workspace');
            }}
            type="button"
          >
            <Sparkles aria-hidden="true" size={17} /> 工作台
          </button>
          <button
            className={view === 'search' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => {
              openView('search');
            }}
            type="button"
          >
            <Search aria-hidden="true" size={17} /> 搜索
          </button>
          <button
            className={view === 'recent' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => {
              openView('recent');
            }}
            type="button"
          >
            <History aria-hidden="true" size={17} /> 最近
          </button>
        </nav>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>内容</span>
            <button
              aria-label="新建内容"
              className="icon-button"
              onClick={() => { setNewArticleOpen(true); }}
              title="新建内容"
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>
          {articles.map((article) => (
            <button
              className={article.id === activeArticle?.id ? 'tree-item is-selected' : 'tree-item'}
              key={article.id}
              onClick={() => { selectArticle(article.id); }}
              type="button"
            >
              <FileText aria-hidden="true" size={16} />
              <span>{article.title}</span>
            </button>
          ))}
        </section>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Agents</span>
          </div>
          <button className="tree-item" onClick={() => { setAgentOpen(true); }} type="button">
            <Bot aria-hidden="true" size={16} />
            <span>写作助手</span>
          </button>
        </section>
      </aside>

      <section className="document-pane">
        <header className="document-toolbar">
          <div className="breadcrumb">
            <span>{view === 'search' ? '搜索' : view === 'recent' ? '最近' : '写作素材'}</span>
            {activeArticle && view === 'workspace' ? (
              <>
                <span>/</span>
                <strong>{activeArticle.title}</strong>
              </>
            ) : null}
          </div>
          <div className="toolbar-actions">
            <button
              aria-label="页面设置"
              className="icon-button"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen((value) => !value);
              }}
              title="页面设置"
              type="button"
            >
              <Settings2 aria-hidden="true" size={17} />
            </button>
            <button
              aria-label="更多操作"
              className="icon-button"
              onClick={() => {
                setSettingsOpen(false);
                setMenuOpen((value) => !value);
              }}
              title="更多操作"
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
            <button
              aria-label="切换 Agent 面板"
              className="icon-button"
              onClick={() => { setAgentOpen((value) => !value); }}
              title="Agent 面板"
              type="button"
            >
              <PanelRight aria-hidden="true" size={17} />
            </button>
          </div>
          {settingsOpen ? (
            <div className="toolbar-popover">
              <strong>页面设置</strong>
              <span>自动保存与服务端恢复已开启</span>
              <span>当前用户：Demo Workspace</span>
            </div>
          ) : null}
          {menuOpen ? (
            <div className="toolbar-popover toolbar-menu">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setNewArticleOpen(true);
                }}
                type="button"
              >
                新建文章
              </button>
              <a href="/trending">打开热榜</a>
            </div>
          ) : null}
        </header>

        {view === 'workspace' && activeArticle ? (
          <ArticleCanvas
            key={activeArticle.id}
            articleId={activeArticle.id}
            baseRevisionId={activeArticle.revisionId}
            initialDocument={activeArticle.document}
          />
        ) : (
          <section className="workspace-list-view">
            <h1>{view === 'search' ? '搜索文章' : '最近编辑'}</h1>
            {view === 'search' ? (
              <input
                aria-label="搜索文章"
                autoFocus
                onChange={(event) => { setSearchQuery(event.target.value); }}
                placeholder="输入标题搜索"
                value={searchQuery}
              />
            ) : null}
            <div className="workspace-results">
              {listedArticles.map((article) => (
                <button key={article.id} onClick={() => { selectArticle(article.id); }} type="button">
                  <FileText size={17} />
                  <span>{article.title}</span>
                </button>
              ))}
              {listedArticles.length === 0 ? (
                <p className="workspace-empty">没有匹配的文章</p>
              ) : null}
            </div>
          </section>
        )}
      </section>

      {agentOpen ? (
        <AgentWorkbench
          key={activeArticle?.conversationId ?? 'workspace-agent'}
          userId={userId}
          {...(activeArticle?.conversationId
            ? { conversationId: activeArticle.conversationId }
            : {})}
          {...(activeArticle?.branchId ? { branchId: activeArticle.branchId } : {})}
        />
      ) : null}

      {error ? (
        <div className="workspace-toast" role="alert">
          {error}
          <button aria-label="关闭提示" onClick={() => { setError(undefined); }} type="button">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {newArticleOpen ? (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void createArticle(event)}>
            <div className="modal-heading">
              <strong>新建文章</strong>
              <button aria-label="关闭" onClick={() => { setNewArticleOpen(false); }} type="button">
                <X size={16} />
              </button>
            </div>
            <label htmlFor="new-article-title">标题</label>
            <input
              id="new-article-title"
              onChange={(event) => { setNewTitle(event.target.value); }}
              placeholder="输入文章标题"
              required
              value={newTitle}
            />
            <button className="primary-action" type="submit">
              创建文章
            </button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
