import {
  Bot,
  ChevronDown,
  FileText,
  FolderClosed,
  History,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';

import { AgentWorkbench } from '../components/agent-workbench';
import { ArticleCanvas } from '../components/article-canvas';

const recentItems = [
  ['AI 产品观察', 'article'],
  ['Agent 架构笔记', 'article'],
  ['写作素材', 'folder'],
] as const;

export default function WorkspacePage(): React.JSX.Element {
  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="工作区导航">
        <div className="workspace-name">
          <span className="brand-mark">A</span>
          <span>AgentPress</span>
          <ChevronDown aria-hidden="true" size={15} />
        </div>

        <nav className="primary-nav">
          <button className="nav-item is-active" type="button">
            <Sparkles aria-hidden="true" size={17} />
            工作台
          </button>
          <button className="nav-item" type="button">
            <Search aria-hidden="true" size={17} />
            搜索
          </button>
          <button className="nav-item" type="button">
            <History aria-hidden="true" size={17} />
            最近
          </button>
        </nav>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>内容</span>
            <button aria-label="新建内容" className="icon-button" title="新建内容" type="button">
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>
          {recentItems.map(([label, type]) => (
            <button className="tree-item" key={label} type="button">
              {type === 'folder' ? (
                <FolderClosed aria-hidden="true" size={16} />
              ) : (
                <FileText aria-hidden="true" size={16} />
              )}
              <span>{label}</span>
            </button>
          ))}
        </section>

        <section className="sidebar-section">
          <div className="section-heading">
            <span>Agents</span>
            <button
              aria-label="新建 Agent"
              className="icon-button"
              title="新建 Agent"
              type="button"
            >
              <Plus aria-hidden="true" size={15} />
            </button>
          </div>
          <button className="tree-item" type="button">
            <Bot aria-hidden="true" size={16} />
            <span>写作助手</span>
          </button>
        </section>
      </aside>

      <section className="document-pane">
        <header className="document-toolbar">
          <div className="breadcrumb">
            <span>写作素材</span>
            <span>/</span>
            <strong>Agent 时代的长文创作</strong>
          </div>
          <div className="toolbar-actions">
            <button aria-label="页面设置" className="icon-button" title="页面设置" type="button">
              <Settings2 aria-hidden="true" size={17} />
            </button>
            <button aria-label="更多操作" className="icon-button" title="更多操作" type="button">
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
            <button
              aria-label="切换 Agent 面板"
              className="icon-button"
              title="Agent 面板"
              type="button"
            >
              <PanelRight aria-hidden="true" size={17} />
            </button>
          </div>
        </header>
        <ArticleCanvas />
      </section>

      <AgentWorkbench />
    </main>
  );
}
