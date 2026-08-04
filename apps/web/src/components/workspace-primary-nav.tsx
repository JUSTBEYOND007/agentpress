import { ChartNoAxesCombined, History, Search, Sparkles, Trash2 } from 'lucide-react';

export type WorkspaceView = 'workspace' | 'search' | 'recent' | 'trash' | 'evals';

export function WorkspacePrimaryNav({
  view,
  onOpen,
}: {
  readonly view: WorkspaceView;
  readonly onOpen: (view: WorkspaceView) => void;
}): React.JSX.Element {
  return (
    <nav className="primary-nav">
      <NavItem
        active={view === 'workspace'}
        icon={<Sparkles aria-hidden="true" size={17} />}
        label="工作台"
        onClick={() => {
          onOpen('workspace');
        }}
      />
      <NavItem
        active={view === 'search'}
        icon={<Search aria-hidden="true" size={17} />}
        label="搜索"
        onClick={() => {
          onOpen('search');
        }}
      />
      <NavItem
        active={view === 'recent'}
        icon={<History aria-hidden="true" size={17} />}
        label="最近"
        onClick={() => {
          onOpen('recent');
        }}
      />
      <NavItem
        active={view === 'evals'}
        icon={<ChartNoAxesCombined aria-hidden="true" size={17} />}
        label="评估"
        onClick={() => {
          onOpen('evals');
        }}
      />
      <NavItem
        active={view === 'trash'}
        icon={<Trash2 aria-hidden="true" size={17} />}
        label="回收站"
        onClick={() => {
          onOpen('trash');
        }}
      />
    </nav>
  );
}

function NavItem({
  active,
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <button className={active ? 'nav-item is-active' : 'nav-item'} onClick={onClick} type="button">
      {icon} {label}
    </button>
  );
}
