'use client';

import {
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderPlus,
  History,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  RotateCcw,
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
  readonly folderId?: string | null;
  readonly title: string;
  readonly revisionId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
  readonly conversationId?: string;
  readonly branchId?: string;
};

type ContentFolder = {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly position: number;
};

type ArticleRevision = {
  readonly id: string;
  readonly revisionNumber: number;
  readonly source: string;
  readonly documentHash: string;
  readonly createdAt: string;
};

type ArticlePublication = {
  readonly id: string;
  readonly slug: string;
  readonly status: 'published' | 'unpublished';
  readonly editionNumber: number;
  readonly publishedAt: string;
};

type View = 'workspace' | 'search' | 'recent' | 'trash';

export default function AuthenticatedWorkspacePage(): React.JSX.Element {
  return (
    <AuthProvider>
      <WorkspacePage />
    </AuthProvider>
  );
}

function WorkspacePage(): React.JSX.Element {
  const [articles, setArticles] = useState<readonly WorkspaceArticle[]>([]);
  const [folders, setFolders] = useState<readonly ContentFolder[]>([]);
  const [trashArticles, setTrashArticles] = useState<readonly WorkspaceArticle[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [activeArticleId, setActiveArticleId] = useState<string>();
  const [view, setView] = useState<View>('workspace');
  const [agentOpen, setAgentOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newArticleOpen, setNewArticleOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState('');
  const [newArticleFolderId, setNewArticleFolderId] = useState('');
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [revisions, setRevisions] = useState<readonly ArticleRevision[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishSlug, setPublishSlug] = useState('');
  const [coverAssetId, setCoverAssetId] = useState('');
  const [mediaAssets, setMediaAssets] = useState<
    readonly { id: string; prompt?: string; attribution?: string }[]
  >([]);
  const [publishedSlug, setPublishedSlug] = useState<string>();
  const [publicationHistory, setPublicationHistory] = useState<readonly ArticlePublication[]>([]);
  const [error, setError] = useState<string>();

  const loadArticles = useCallback(async (id: string): Promise<void> => {
    const [articleResponse, folderResponse, trashResponse] = await Promise.all([
      authenticatedFetch(`${apiUrl}/workspaces/${id}/articles`),
      authenticatedFetch(`${apiUrl}/workspaces/${id}/folders`),
      authenticatedFetch(`${apiUrl}/workspaces/${id}/articles?trash=true`),
    ]);
    if (!articleResponse.ok)
      throw new Error(`文章列表加载失败 (${String(articleResponse.status)})`);
    if (!folderResponse.ok) throw new Error(`目录加载失败 (${String(folderResponse.status)})`);
    if (!trashResponse.ok) throw new Error(`回收站加载失败 (${String(trashResponse.status)})`);
    const items = (await articleResponse.json()) as WorkspaceArticle[];
    setArticles(items);
    setFolders((await folderResponse.json()) as ContentFolder[]);
    setTrashArticles((await trashResponse.json()) as WorkspaceArticle[]);
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
        body: JSON.stringify({ title: newTitle, folderId: newArticleFolderId || null }),
      });
      if (!response.ok) throw new Error(`创建文章失败 (${String(response.status)})`);
      const article = (await response.json()) as WorkspaceArticle;
      setArticles((current) => [article, ...current]);
      setActiveArticleId(article.id);
      setNewTitle('');
      setNewArticleFolderId('');
      setNewArticleOpen(false);
      setView('workspace');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建文章失败');
    }
  }

  async function createFolder(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!workspaceId) return;
    const response = await authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newFolderName, parentId: newFolderParentId || null }),
    });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setNewFolderName('');
    setNewFolderParentId('');
    setNewFolderOpen(false);
    await reloadArticles();
  }

  async function moveArticle(folderId: string): Promise<void> {
    if (!activeArticle) return;
    const response = await authenticatedFetch(`${apiUrl}/articles/${activeArticle.id}/location`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folderId || null }),
    });
    if (!response.ok) throw new Error(await response.text());
    await reloadArticles();
  }

  async function trashArticle(): Promise<void> {
    if (!activeArticle) return;
    const response = await authenticatedFetch(`${apiUrl}/articles/${activeArticle.id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error(await response.text());
    setMenuOpen(false);
    await reloadArticles();
  }

  async function restoreArticle(articleId: string): Promise<void> {
    const response = await authenticatedFetch(`${apiUrl}/articles/${articleId}/restore`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error(await response.text());
    await reloadArticles();
  }

  async function openRevisions(): Promise<void> {
    if (!activeArticle) return;
    const response = await authenticatedFetch(`${apiUrl}/articles/${activeArticle.id}/revisions`);
    if (!response.ok) throw new Error(await response.text());
    setRevisions((await response.json()) as ArticleRevision[]);
    setRevisionsOpen(true);
    setMenuOpen(false);
  }

  async function downloadArticle(
    format: 'markdown' | 'html' | 'json',
    revisionId?: string,
  ): Promise<void> {
    if (!activeArticle) return;
    const query = new URLSearchParams({ format });
    if (revisionId) query.set('revisionId', revisionId);
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${activeArticle.id}/export?${query.toString()}`,
    );
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as {
      filename: string;
      mimeType: string;
      content: string;
    };
    const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
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
    const [mediaResponse, historyResponse] = await Promise.all([
      authenticatedFetch(`${apiUrl}/workspaces/${workspaceId}/media`),
      authenticatedFetch(`${apiUrl}/articles/${activeArticle.id}/publications`),
    ]);
    if (mediaResponse.ok)
      setMediaAssets(
        (await mediaResponse.json()) as readonly {
          id: string;
          prompt?: string;
          attribution?: string;
        }[],
      );
    if (historyResponse.ok)
      setPublicationHistory((await historyResponse.json()) as ArticlePublication[]);
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
    await loadPublicationHistory(activeArticle.id);
  }

  async function loadPublicationHistory(articleId: string): Promise<void> {
    const response = await authenticatedFetch(`${apiUrl}/articles/${articleId}/publications`);
    if (!response.ok) throw new Error(await response.text());
    setPublicationHistory((await response.json()) as ArticlePublication[]);
  }

  async function unpublish(publicationId: string): Promise<void> {
    if (!activeArticle) return;
    const response = await authenticatedFetch(
      `${apiUrl}/articles/${activeArticle.id}/publications/${publicationId}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw new Error(await response.text());
    await loadPublicationHistory(activeArticle.id);
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
          <button
            className={view === 'trash' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => {
              openView('trash');
            }}
            type="button"
          >
            <Trash2 aria-hidden="true" size={17} /> 回收站
          </button>
        </nav>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>内容</span>
            <button
              aria-label="新建目录"
              className="icon-button"
              onClick={() => {
                setNewFolderOpen(true);
              }}
              title="新建目录"
              type="button"
            >
              <FolderPlus aria-hidden="true" size={15} />
            </button>
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
          <ContentTree
            {...(activeArticle?.id ? { activeArticleId: activeArticle.id } : {})}
            articles={articles}
            folders={folders}
            onSelectArticle={selectArticle}
          />
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
            <span>
              {view === 'search'
                ? '搜索'
                : view === 'recent'
                  ? '最近'
                  : view === 'trash'
                    ? '回收站'
                    : '写作素材'}
            </span>
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
              <button
                onClick={() =>
                  void openRevisions().catch((reason: unknown) => {
                    setError(reason instanceof Error ? reason.message : '版本加载失败');
                  })
                }
                type="button"
              >
                版本记录与导出
              </button>
              <button
                onClick={() =>
                  void trashArticle().catch((reason: unknown) => {
                    setError(reason instanceof Error ? reason.message : '移入回收站失败');
                  })
                }
                type="button"
              >
                移入回收站
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
            <h1>{view === 'search' ? '搜索文章' : view === 'trash' ? '回收站' : '最近编辑'}</h1>
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
              {(view === 'trash' ? trashArticles : listedArticles).map((article) => (
                <button
                  key={article.id}
                  onClick={() => {
                    if (view === 'trash')
                      void restoreArticle(article.id).catch((reason: unknown) => {
                        setError(reason instanceof Error ? reason.message : '恢复失败');
                      });
                    else selectArticle(article.id);
                  }}
                  type="button"
                >
                  {view === 'trash' ? <RotateCcw size={17} /> : <FileText size={17} />}
                  <span>{article.title}</span>
                </button>
              ))}
              {(view === 'trash' ? trashArticles : listedArticles).length === 0 ? (
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
            <label htmlFor="new-article-folder">目录</label>
            <select
              id="new-article-folder"
              value={newArticleFolderId}
              onChange={(event) => {
                setNewArticleFolderId(event.target.value);
              }}
            >
              <option value="">根目录</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <button className="primary-action" type="submit">
              创建文章
            </button>
          </form>
        </div>
      ) : null}
      {newFolderOpen ? (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void createFolder(event)}>
            <div className="modal-heading">
              <strong>新建目录</strong>
              <button
                aria-label="关闭"
                onClick={() => {
                  setNewFolderOpen(false);
                }}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <label htmlFor="new-folder-name">名称</label>
            <input
              id="new-folder-name"
              required
              maxLength={180}
              value={newFolderName}
              onChange={(event) => {
                setNewFolderName(event.target.value);
              }}
            />
            <label htmlFor="new-folder-parent">父目录</label>
            <select
              id="new-folder-parent"
              value={newFolderParentId}
              onChange={(event) => {
                setNewFolderParentId(event.target.value);
              }}
            >
              <option value="">根目录</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <button className="primary-action" type="submit">
              创建目录
            </button>
          </form>
        </div>
      ) : null}
      {revisionsOpen && activeArticle ? (
        <div className="modal-backdrop">
          <section className="modal revision-modal" aria-label="版本记录">
            <div className="modal-heading">
              <strong>版本记录</strong>
              <button
                aria-label="关闭"
                onClick={() => {
                  setRevisionsOpen(false);
                }}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <label htmlFor="article-folder">所在目录</label>
            <select
              id="article-folder"
              value={activeArticle.folderId ?? ''}
              onChange={(event) => {
                void moveArticle(event.target.value).catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : '移动失败');
                });
              }}
            >
              <option value="">根目录</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
            <div className="export-actions">
              <button type="button" onClick={() => void downloadArticle('markdown')}>
                <Download size={14} /> Markdown
              </button>
              <button type="button" onClick={() => void downloadArticle('html')}>
                <Download size={14} /> HTML
              </button>
              <button type="button" onClick={() => void downloadArticle('json')}>
                <Download size={14} /> JSON
              </button>
            </div>
            <div className="revision-list">
              {revisions.map((revision) => (
                <div key={revision.id}>
                  <span>
                    版本 {revision.revisionNumber} · {revision.source}
                  </span>
                  <button
                    type="button"
                    onClick={() => void downloadArticle('markdown', revision.id)}
                  >
                    <Download size={14} /> 导出
                  </button>
                </div>
              ))}
            </div>
          </section>
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
            {publicationHistory.length > 0 ? (
              <div className="publication-history">
                <span>发布记录</span>
                {publicationHistory.map((publication) => (
                  <div key={publication.id}>
                    <a href={`/p/${publication.slug}`}>
                      Edition {publication.editionNumber} · {publication.slug}
                    </a>
                    {publication.status === 'published' ? (
                      <button
                        onClick={() =>
                          void unpublish(publication.id).catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : '撤回失败');
                          })
                        }
                        type="button"
                      >
                        撤回
                      </button>
                    ) : (
                      <small>已撤回</small>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </form>
        </div>
      ) : null}
    </main>
  );
}

function ContentTree({
  activeArticleId,
  articles,
  folders,
  onSelectArticle,
}: {
  readonly activeArticleId?: string;
  readonly articles: readonly WorkspaceArticle[];
  readonly folders: readonly ContentFolder[];
  readonly onSelectArticle: (articleId: string) => void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const renderFolder = (folder: ContentFolder, depth: number): React.JSX.Element => {
    const isCollapsed = collapsed.has(folder.id);
    const children = folders.filter((item) => item.parentId === folder.id);
    const contained = articles.filter((article) => article.folderId === folder.id);
    return (
      <div key={folder.id}>
        <button
          className="tree-item"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(folder.id)) next.delete(folder.id);
              else next.add(folder.id);
              return next;
            });
          }}
          type="button"
        >
          <ChevronRight className={isCollapsed ? '' : 'tree-chevron-open'} size={13} />
          <Folder size={15} />
          <span>{folder.name}</span>
        </button>
        {!isCollapsed ? (
          <>
            {children.map((child) => renderFolder(child, depth + 1))}
            {contained.map((article) => (
              <ArticleTreeItem
                active={article.id === activeArticleId}
                article={article}
                depth={depth + 1}
                key={article.id}
                onSelect={onSelectArticle}
              />
            ))}
          </>
        ) : null}
      </div>
    );
  };
  return (
    <>
      {folders
        .filter((folder) => folder.parentId === null)
        .map((folder) => renderFolder(folder, 0))}
      {articles
        .filter((article) => !article.folderId)
        .map((article) => (
          <ArticleTreeItem
            active={article.id === activeArticleId}
            article={article}
            depth={0}
            key={article.id}
            onSelect={onSelectArticle}
          />
        ))}
    </>
  );
}

function ArticleTreeItem({
  active,
  article,
  depth,
  onSelect,
}: {
  readonly active: boolean;
  readonly article: WorkspaceArticle;
  readonly depth: number;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? 'tree-item is-selected' : 'tree-item'}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => {
        onSelect(article.id);
      }}
      type="button"
    >
      <FileText size={15} />
      <span>{article.title}</span>
    </button>
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
