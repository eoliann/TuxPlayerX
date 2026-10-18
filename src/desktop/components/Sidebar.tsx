import { Clapperboard, Download, MonitorPlay, ListVideo, Settings, Info, Moon, Sun, X } from 'lucide-react';
import { cn } from '../../core/utils';
import { APP_NAME, APP_VERSION } from '../../core/appMeta';
import { UpdateInfo } from '../../core/types';

export type TabKey = 'player' | 'vod' | 'subscriptions' | 'settings' | 'about';

interface SidebarProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  theme: 'dark' | 'light';
  update: UpdateInfo | null;
  onDownloadUpdate: (update: UpdateInfo) => void;
  onDismissUpdate: () => void;
}

const appIcon = '/icon.png';

const items = [
  { key: 'player' as const, label: 'Player', icon: MonitorPlay },
  { key: 'vod' as const, label: 'Movies & Series', icon: Clapperboard },
  { key: 'subscriptions' as const, label: 'Subscriptions', icon: ListVideo },
  { key: 'settings' as const, label: 'Settings', icon: Settings },
  { key: 'about' as const, label: 'About', icon: Info },
];

export function Sidebar({ activeTab, onTabChange, theme, update, onDownloadUpdate, onDismissUpdate }: SidebarProps) {
  return (
    // Scrolls on its own when the window is shorter than the sidebar.
    <aside className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-white/10 bg-slate-950 px-4 py-5 light:border-slate-200 light:bg-white">
      <div className="mb-7 flex items-center gap-3 rounded-3xl border border-cyan-400/20 bg-cyan-400/10 p-3 light:border-cyan-500/20 light:bg-cyan-50">
        <div className="grid h-12 w-12 place-items-center overflow-hidden rounded-2xl border border-cyan-300/30 bg-slate-900 shadow-lg shadow-cyan-500/20 light:bg-white">
          <img src={appIcon} alt={`${APP_NAME} icon`} className="h-11 w-11 object-contain" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-lg font-black tracking-tight">{APP_NAME}</div>
          <div className="truncate text-[11px] uppercase tracking-[0.22em] text-cyan-300 light:text-cyan-700">Streaming Toolkit</div>
        </div>
      </div>

      <nav className="space-y-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onTabChange(item.key)}
              className={cn(
                'group flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm font-bold transition-all',
                active
                  ? 'border-cyan-400/40 bg-cyan-400/15 text-cyan-100 shadow-lg shadow-cyan-500/10 light:bg-cyan-50 light:text-cyan-900'
                  : 'border-transparent text-slate-400 hover:border-white/10 hover:bg-white/5 hover:text-slate-100 light:text-slate-600 light:hover:border-slate-200 light:hover:bg-slate-50 light:hover:text-slate-950',
              )}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-3 pt-4">
        {update && (
          <div className="rounded-3xl border border-emerald-400/30 bg-emerald-400/10 p-4 light:border-emerald-500/30 light:bg-emerald-50">
            <div className="mb-1 flex items-start justify-between gap-2">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-300 light:text-emerald-700">Update available</div>
              <button onClick={onDismissUpdate} title="Remind me about the next version" className="-mr-1 -mt-1 rounded-lg p-1 text-slate-400 hover:bg-white/10 light:hover:bg-slate-200">
                <X size={14} />
              </button>
            </div>
            <div className="text-sm font-semibold">Version {update.latestVersion} is out</div>
            <p className="mt-1 text-xs text-slate-500">You have {update.currentVersion}.</p>
            <button onClick={() => onDownloadUpdate(update)} className="btn-primary mt-3 w-full justify-center">
              <Download size={16} /> Download
            </button>
          </div>
        )}
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4 light:border-slate-200 light:bg-slate-50">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-500">
            {theme === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
            Theme
          </div>
          <div className="text-sm font-semibold">{theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</div>
          <p className="mt-1 text-xs text-slate-500">Change it from Settings.</p>
        </div>
        <div className="px-2 text-center text-[11px] font-bold uppercase tracking-[0.22em] text-slate-600 light:text-slate-400">
          Version {APP_VERSION}
        </div>
      </div>
    </aside>
  );
}
