import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sidebar, TabKey } from './components/Sidebar';
import { PlayerView } from './components/PlayerView';
import { SubscriptionsView } from './components/SubscriptionsView';
import { SettingsView } from './components/SettingsView';
import { AboutView } from './components/AboutView';
import { AppSettings } from './lib/types';
import { api } from './lib/api';

const defaultSettings: AppSettings = {
  theme: 'dark',
  networkCacheMs: 3000,
  autoLoadDefault: true,
  autoRestart: true,
  externalPlayerCommand: 'vlc',
};

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('player');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [reloadToken, setReloadToken] = useState(0);
  const [status, setStatus] = useState('Ready.');

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setSettings(defaultSettings));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('light', settings.theme === 'light');
  }, [settings.theme]);

  const page = (() => {
    switch (activeTab) {
      case 'player':
        return <PlayerView settings={settings} reloadToken={reloadToken} onStatus={setStatus} />;
      case 'subscriptions':
        return <SubscriptionsView onChanged={() => setReloadToken((x) => x + 1)} onStatus={setStatus} />;
      case 'settings':
        return <SettingsView settings={settings} onSettings={setSettings} onStatus={setStatus} />;
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
              <h1 className="text-base font-bold tracking-tight">{activeTab[0].toUpperCase() + activeTab.slice(1)}</h1>
              <p className="text-xs text-slate-400 light:text-slate-500">TuxPlayerX desktop streaming player</p>
            </div>
            <div className="max-w-[50%] truncate rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-slate-300 light:border-slate-200 light:bg-slate-50 light:text-slate-600">{status}</div>
          </header>
          <AnimatePresence mode="wait">
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
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

export default App;
