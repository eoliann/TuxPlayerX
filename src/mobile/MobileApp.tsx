import { Component, useEffect, useState, type ReactNode } from 'react';
import { Clapperboard, ListVideo, Settings, Tv } from 'lucide-react';
import { AppSettings } from '../core/types';
import { api } from '../core/api';
import { cn } from '../core/utils';
import { enableSpatialNavigation } from './spatialNav';
import { LiveTv } from './LiveTv';
import { MobileSubscriptions } from './MobileSubscriptions';
import { MobileSettings } from './MobileSettings';
import { MobileVod } from './MobileVod';

type Tab = 'live' | 'vod' | 'subscriptions' | 'settings';

const defaultSettings: AppSettings = {
  theme: 'dark',
  networkCacheMs: 3000,
  autoLoadDefault: true,
  autoRestart: true,
  externalPlayerCommand: 'vlc',
  epgUrl: 'https://epgshare01.online/epgshare01/epg_ripper_RO1.xml.gz',
  epgTimezoneMode: 'auto',
  epgTimeOffsetMinutes: 0,
  resumeLastChannel: true,
  playbackEngine: 'auto',
};

const TABS: { key: Tab; label: string; icon: typeof Tv }[] = [
  { key: 'live', label: 'Live TV', icon: Tv },
  { key: 'vod', label: 'Movies & Series', icon: Clapperboard },
  { key: 'subscriptions', label: 'Subscriptions', icon: ListVideo },
  { key: 'settings', label: 'Settings', icon: Settings },
];

/** Keeps one failing screen from blanking the whole app; offers a reload instead. */
class ScreenBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <div className="text-lg font-black">Something went wrong</div>
          <p className="mt-2 max-w-md break-words text-xs text-slate-400">{this.state.error}</p>
          <button type="button" onClick={() => window.location.reload()} className="btn-primary mx-auto mt-5">Reload</button>
        </div>
      </div>
    );
  }
}

/** Android app (phones, tablets and TVs): bottom navigation on phones, a side rail on wide screens. */
export default function MobileApp() {
  const [tab, setTab] = useState<Tab>('live');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => enableSpatialNavigation(), []);

  useEffect(() => {
    api.getSettings()
      .then(setSettings)
      .catch(() => setSettings(defaultSettings))
      .finally(() => setSettingsLoaded(true));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('light', settings.theme === 'light');
  }, [settings.theme]);

  // Status messages appear briefly as a toast.
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 4500);
    return () => window.clearTimeout(timer);
  }, [status]);

  const nav = (
    <>
      {TABS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => setTab(key)}
          className={cn(
            'flex flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-bold md:flex-none md:py-3',
            tab === key ? 'text-cyan-300 light:text-cyan-700' : 'text-slate-400 light:text-slate-500',
          )}
        >
          <Icon size={22} />
          {label}
        </button>
      ))}
    </>
  );

  return (
    <div data-mobile className="flex h-[100dvh] bg-slate-950 text-slate-100 light:bg-slate-100 light:text-slate-950">
      <nav className="hidden w-24 shrink-0 flex-col gap-2 border-r border-white/10 p-2 pt-6 md:flex light:border-slate-200">{nav}</nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ScreenBoundary>
          {/* Live TV stays mounted so the channel list and position survive tab switches. */}
          <div className={tab === 'live' ? 'h-full' : 'hidden'}>
            {settingsLoaded && (
              <LiveTv settings={settings} reloadToken={reloadToken} onStatus={setStatus} onOpenSubscriptions={() => setTab('subscriptions')} />
            )}
          </div>
          {tab === 'vod' && <MobileVod reloadToken={reloadToken} onStatus={setStatus} />}
          {tab === 'subscriptions' && <MobileSubscriptions onChanged={() => setReloadToken((x) => x + 1)} onStatus={setStatus} />}
          {tab === 'settings' && <MobileSettings settings={settings} onSettings={setSettings} onStatus={setStatus} />}
          </ScreenBoundary>
        </main>
        <nav className="flex shrink-0 border-t border-white/10 bg-slate-950/95 px-2 pb-1 md:hidden light:border-slate-200 light:bg-white">{nav}</nav>
      </div>
      {status && (
        <div className="pointer-events-none fixed inset-x-4 bottom-20 z-[60] mx-auto max-w-md rounded-2xl border border-white/10 bg-slate-900/95 px-4 py-3 text-center text-sm shadow-2xl md:bottom-6 light:border-slate-200 light:bg-white">
          {status}
        </div>
      )}
    </div>
  );
}
