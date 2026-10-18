import { Component, useEffect, useState, type ReactNode } from 'react';
import { Clapperboard, Download, ListVideo, Settings, Tv } from 'lucide-react';
import { AppSettings, UpdateInfo } from '../core/types';
import { api } from '../core/api';
import { cn } from '../core/utils';
import { useUpdateCheck } from '../core/useUpdateCheck';
import { enableSpatialNavigation } from './spatialNav';
import { enableSafeArea, safePadding } from './safeArea';
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
  checkUpdates: true,
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
  const { update, checkNow, dismiss: dismissUpdate } = useUpdateCheck(settingsLoaded && settings.checkUpdates);

  const downloadUpdate = (info: UpdateInfo) => {
    // The browser downloads the APK; Android then offers to install it over the current version.
    api.openUrl(info.downloadUrl)
      .then(() => setStatus(`Downloading TuxPlayerX ${info.latestVersion} in your browser.`))
      .catch((error) => setStatus(String(error)));
  };

  useEffect(() => enableSpatialNavigation(), []);
  useEffect(() => enableSafeArea(), []);

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
    <div data-mobile className="flex h-[100dvh] bg-slate-950 text-slate-100 light:bg-slate-100 light:text-slate-950" style={safePadding()}>
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
          {tab === 'settings' && <MobileSettings settings={settings} onSettings={setSettings} onStatus={setStatus} onCheckUpdate={checkNow} onDownloadUpdate={downloadUpdate} />}
          </ScreenBoundary>
        </main>
        <nav className="flex shrink-0 border-t border-white/10 bg-slate-950/95 px-2 pb-1 md:hidden light:border-slate-200 light:bg-white">{nav}</nav>
      </div>
      {update && (
        <div className="fixed inset-x-4 bottom-28 z-50 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-emerald-400/30 bg-slate-900/95 p-3 shadow-2xl md:bottom-6 light:border-emerald-500/30 light:bg-white">
          <Download className="shrink-0 text-emerald-300 light:text-emerald-600" size={20} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-black">TuxPlayerX {update.latestVersion} is available</div>
            <div className="text-xs text-slate-400 light:text-slate-500">You have {update.currentVersion}.</div>
          </div>
          <button type="button" onClick={() => downloadUpdate(update)} className="btn-primary shrink-0">Download</button>
          <button type="button" onClick={dismissUpdate} className="btn-secondary shrink-0">Later</button>
        </div>
      )}
      {status && (
        <div
          className={cn(
            'pointer-events-none fixed inset-x-4 z-[60] mx-auto max-w-md rounded-2xl border border-white/10 bg-slate-900/95 px-4 py-3 text-center text-sm shadow-2xl light:border-slate-200 light:bg-white',
            // Above the update notice while it is shown.
            update ? 'bottom-52 md:bottom-28' : 'bottom-20 md:bottom-6',
          )}
        >
          {status}
        </div>
      )}
    </div>
  );
}
