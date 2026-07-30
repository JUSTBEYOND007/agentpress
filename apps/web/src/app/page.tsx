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
import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';

import { AgentWorkbench } from '../components/agent-workbench';
import { ArticleCanvas } from '../components/article-canvas';
import { AuthProvider } from '../components/auth-provider';
import { authenticatedFetch } from '../lib/authenticated-fetch';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

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

export default function AuthenticatedWorkspacePage(): React.JSX.Element {
  return (
    <AuthProvider>
      <WorkspacePage />
    </AuthProvider>
  );
}

function WorkspacePage(): React.JSX.Element {
  const [articles, setArticles] = useState<readonly WorkspaceArticle[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [activeArticleId, setActiveArticleId] = useState<string>();
  const [view, setView] = useState<View>('workspace');
  const [agentOpen, setAgentOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newArticleOpen, setNewArticleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishSlug, setPublishSlug] = useState('');
  const [coverAssetId, setCoverAssetId] = useState('');
  const [mediaAssets, setMediaAssets] = useState<
    readonly { id: string; prompt?: string; attribution?: string }[]
  >([]);
  const [publishedSlug, setPublishedSlug] = useState<string>();
  const [error, setError] = useState<string>();

  const loadArticles = useCallback(async (id: string): Promise<void> => {
    const response = await authenticatedFetch(`${apiUrl}/workspaces/${id}/articles`);
    if (!response.ok) throw new Error(`文章列表加载失败 (${String(response.status)})`);
    const items = (await response.json()) as WorkspaceArticle[];
    setArticles(items);
    setActiveArticleId((current) =>
      current && items.some((item) => item.id === current) ? current : items[0]?.id,
    );
  }, []);

  const reloadArticles = useCallback(async (): Promise<void> => {
    if (!workspaceId) throw new Error('工作区尚未就绪');
    try {
      await loadArticles(workspaceId);
      setError(undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '文章重新加载失败';
      setError(message);
      throw reason;
    }
  }, [loadArticles, workspaceId]);

  useEffect(() => {
    void authenticatedFetch(`${apiUrl}/me/workspace`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`工作区加载失败 (${String(response.status)})`);
        return (await response.json()) as { readonly id: string };
      })
      .then((workspace) => {
        setWorkspaceId(workspace.id);
        return loadArticles(workspace.id);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '文章列表加载失败');
      });
  }, [loadArticles]);

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
      if (!workspaceId) throw new Error('工作区尚未就绪');
      const response = await authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/articles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
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

  async function openPublish(): Promise<void> {
    if (!workspaceId || !activeArticle) return;
    setPublishSlug(slugify(activeArticle.title));
    setPublishedSlug(undefined);
    const response = await authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/media`);
    if (response.ok)
      setMediaAssets(
        (await response.json()) as readonly { id: string; prompt?: string; attribution?: string }[],
      );
    setPublishOpen(true);
    setMenuOpen(false);
  }

  async function publishArticle(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!activeArticle) return;
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${activeArticle.id}/publications`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionId: activeArticle.revisionId,
          slug: publishSlug,
          ...(coverAssetId ? { coverAssetId } : {}),
        }),
      },
    );
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const result = (await response.json()) as { slug: string };
    setPublishedSlug(result.slug);
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
              onClick={() => {
                setNewArticleOpen(true);
              }}
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
              onClick={() => {
                selectArticle(article.id);
              }}
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
          <button
            className="tree-item"
            onClick={() => {
              setAgentOpen(true);
            }}
            type="button"
          >
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
              onClick={() => {
                setAgentOpen((value) => !value);
              }}
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
              <span>当前空间：个人工作区</span>
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
              <button onClick={() => void openPublish()} type="button">
                发布当前修订
              </button>
              <a href="/trending">打开热榜</a>
            </div>
          ) : null}
        </header>

        {view === 'workspace' && activeArticle ? (
          <ArticleCanvas
            key={`${activeArticle.id}:${activeArticle.revisionId}`}
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
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                }}
                placeholder="输入标题搜索"
                value={searchQuery}
              />
            ) : null}
            <div className="workspace-results">
              {listedArticles.map((article) => (
                <button
                  key={article.id}
                  onClick={() => {
                    selectArticle(article.id);
                  }}
                  type="button"
                >
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
          {...(activeArticle?.conversationId
            ? { conversationId: activeArticle.conversationId }
            : {})}
          {...(activeArticle?.branchId ? { branchId: activeArticle.branchId } : {})}
          onArticleUpdated={reloadArticles}
          {...(workspaceId ? { workspaceId } : {})}
          {...(activeArticle
            ? { activeArticleId: activeArticle.id, activeArticleTitle: activeArticle.title }
            : {})}
        />
      ) : null}

      {error ? (
        <div className="workspace-toast" role="alert">
          {error}
          <button
            aria-label="关闭提示"
            onClick={() => {
              setError(undefined);
            }}
            type="button"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
      {newArticleOpen ? (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void createArticle(event)}>
            <div className="modal-heading">
              <strong>新建文章</strong>
              <button
                aria-label="关闭"
                onClick={() => {
                  setNewArticleOpen(false);
                }}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <label htmlFor="new-article-title">标题</label>
            <input
              id="new-article-title"
              onChange={(event) => {
                setNewTitle(event.target.value);
              }}
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
      {publishOpen ? (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void publishArticle(event)}>
            <div className="modal-heading">
              <strong>发布不可变 Edition</strong>
              <button
                aria-label="关闭"
                onClick={() => {
                  setPublishOpen(false);
                }}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            {publishedSlug ? (
              <a className="primary-action" href={`/p/${publishedSlug}`}>
                打开已发布文章
              </a>
            ) : (
              <>
                <label htmlFor="publication-slug">Slug</label>
                <input
                  id="publication-slug"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  required
                  value={publishSlug}
                  onChange={(event) => {
                    setPublishSlug(event.target.value);
                  }}
                />
                <label htmlFor="publication-cover">封面（可选）</label>
                <select
                  id="publication-cover"
                  value={coverAssetId}
                  onChange={(event) => {
                    setCoverAssetId(event.target.value);
                  }}
                >
                  <option value="">无封面</option>
                  {mediaAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.prompt ?? asset.attribution ?? asset.id}
                    </option>
                  ))}
                </select>
                <button className="primary-action" type="submit">
                  发布当前修订
                </button>
              </>
            )}
          </form>
        </div>
      ) : null}
    </main>
  );
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `article-${Date.now().toString(36)}`;
}
