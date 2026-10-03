import { useEffect, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Sidebar, TabKey } from './components/Sidebar';
import { PlayerView } from './components/PlayerView';
import { SubscriptionsView } from './components/SubscriptionsView';
import { SettingsView } from './components/SettingsView';
import { AboutView } from './components/AboutView';
import { VodView } from './components/VodView';
import { AppSettings, Subscription } from './lib/types';
import { daysUntilExpiry, EXPIRY_WARNING_DAYS } from './lib/utils';
import { api } from './lib/api';

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
};

const TAB_TITLES: Record<TabKey, string> = {
  player: 'Player',
  vod: 'Movies & Series',
  subscriptions: 'Subscriptions',
  settings: 'Settings',
  about: 'About',
};

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('player');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [reloadToken, setReloadToken] = useState(0);
  const [status, setStatus] = useState('Ready.');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  /** Bumped when movies/series start, so the live player releases the stream (providers limit connections). */
  const [liveStopSignal, setLiveStopSignal] = useState(0);
  const [expiring, setExpiring] = useState<{ sub: Subscription; days: number }[]>([]);
  const [expiryDismissed, setExpiryDismissed] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then(setSettings)
      .catch(() => setSettings(defaultSettings))
      .finally(() => setSettingsLoaded(true));
  }, []);

  // Refresh subscription info (expiry, connections) at most every 12 hours, then warn about subscriptions
  // that expire within EXPIRY_WARNING_DAYS days.
  useEffect(() => {
    let cancelled = false;
    const REFRESH_KEY = 'tuxplayerx.infoRefreshedAt';
    const check = (list: Subscription[]) => {
      if (cancelled) return;
      setExpiring(
        list
          .map((sub) => ({ sub, days: daysUntilExpiry(sub.expiresAt) }))
          .filter((item): item is { sub: Subscription; days: number } => item.days !== null && item.days <= EXPIRY_WARNING_DAYS),
      );
    };
    (async () => {
      let list = await api.listSubscriptions();
      check(list);
      let last = 0;
      try {
        last = Number(window.localStorage.getItem(REFRESH_KEY) || 0);
      } catch {
        // Ignore storage failures.
      }
      if (Date.now() - last < 12 * 3_600_000 || list.length === 0) return;
      for (const sub of list) {
        if (sub.id) await api.refreshSubscriptionInfo(sub.id).catch(() => undefined);
      }
      try {
        window.localStorage.setItem(REFRESH_KEY, String(Date.now()));
      } catch {
        // Ignore storage failures.
      }
      list = await api.listSubscriptions();
      check(list);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    document.documentElement.classList.toggle('light', settings.theme === 'light');
  }, [settings.theme]);

  // The player stays mounted (just hidden) so playback keeps running while other pages are open.
  const page = (() => {
    switch (activeTab) {
      case 'vod':
        return <VodView reloadToken={reloadToken} onPlaybackStart={() => setLiveStopSignal((x) => x + 1)} onStatus={setStatus} />;
      case 'subscriptions':
        return <SubscriptionsView onChanged={() => setReloadToken((x) => x + 1)} onStatus={setStatus} />;
      case 'settings':
        return <SettingsView settings={settings} onSettings={setSettings} onDataChanged={() => setReloadToken((x) => x + 1)} onStatus={setStatus} />;
      case 'about':
        return <AboutView onStatus={setStatus} />;
      default:
        return null;
    }
  })();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 transition-colors light:bg-slate-100 light:text-slate-950">
      <div className="flex min-h-screen">
        <Sidebar activeTab={activeTab} onTabChange={setActiveTab} theme={settings.theme} />
        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-white/10 bg-slate-950/85 px-6 backdrop-blur light:border-slate-200 light:bg-white/85">
            <div>
              <h1 className="text-base font-bold tracking-tight">{TAB_TITLES[activeTab]}</h1>
              <p className="text-xs text-slate-400 light:text-slate-500">TuxPlayerX desktop streaming player</p>
            </div>
            <div className="max-w-[50%] truncate rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-300 light:border-slate-200 light:bg-slate-50 light:text-slate-600">{status}</div>
          </header>
          <div className={activeTab === 'player' ? 'p-6' : 'hidden'}>
            {/* Wait for saved settings so auto-load / resume decisions use the user's real preferences. */}
            {settingsLoaded && <PlayerView settings={settings} reloadToken={reloadToken} active={activeTab === 'player'} stopSignal={liveStopSignal} onStatus={setStatus} />}
          </div>
          <AnimatePresence mode="wait">
            {page && (
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="p-6"
              >
                {page}
              </motion.div>
            )}
          </AnimatePresence>
          {expiring.length > 0 && !expiryDismissed && (
            <div className="fixed bottom-5 right-5 z-30 flex max-w-sm gap-3 rounded-2xl border border-amber-400/30 bg-amber-950/90 p-4 text-sm text-amber-50 shadow-2xl backdrop-blur light:bg-amber-50 light:text-amber-950">
              <CalendarClock className="mt-0.5 shrink-0 text-amber-300 light:text-amber-600" size={18} />
              <div className="min-w-0">
                <div className="font-black">Subscription expiring soon</div>
                {expiring.map(({ sub, days }) => (
                  <div key={sub.id} className="mt-1 text-xs opacity-90">
                    {sub.name}: {days < 0 ? `expired on ${sub.expiresAt}` : days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'} (${sub.expiresAt})`}
                  </div>
                ))}
                <button onClick={() => { setActiveTab('subscriptions'); setExpiryDismissed(true); }} className="mt-2 text-xs font-bold underline">
                  Open subscriptions
                </button>
              </div>
              <button onClick={() => setExpiryDismissed(true)} className="self-start rounded-lg p-1 hover:bg-white/10" title="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
