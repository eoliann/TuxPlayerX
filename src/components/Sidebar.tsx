import { MonitorPlay, ListVideo, Settings, Info, Moon, Sun } from 'lucide-react';
import { cn } from '../lib/utils';
import { APP_NAME, APP_VERSION } from '../lib/appMeta';

export type TabKey = 'player' | 'subscriptions' | 'settings' | 'about';

interface SidebarProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  theme: 'dark' | 'light';
}

const appIcon = '/icon.png';

const items = [
  { key: 'player' as const, label: 'Player', icon: MonitorPlay },
  { key: 'subscriptions' as const, label: 'Subscriptions', icon: ListVideo },
  { key: 'settings' as const, label: 'Settings', icon: Settings },
  { key: 'about' as const, label: 'About', icon: Info },
];

export function Sidebar({ activeTab, onTabChange, theme }: SidebarProps) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-white/10 bg-slate-950 px-4 py-5 light:border-slate-200 light:bg-white">
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

      <div className="mt-auto space-y-3">
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
