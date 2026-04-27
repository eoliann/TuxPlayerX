import { Moon, Save, Sun } from 'lucide-react';
import { AppSettings } from '../lib/types';
import { api } from '../lib/api';

interface Props {
  settings: AppSettings;
  onSettings: (settings: AppSettings) => void;
  onStatus: (status: string) => void;
}

export function SettingsView({ settings, onSettings, onStatus }: Props) {
  const update = (patch: Partial<AppSettings>) => onSettings({ ...settings, ...patch });

  const save = async () => {
    await api.saveSettings(settings);
    onStatus('Settings saved.');
  };

  return (
    <div className="max-w-3xl rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 light:border-slate-200 light:bg-white">
      <h2 className="text-xl font-black">Settings</h2>
      <p className="mb-6 text-sm text-slate-500">Customize playback, theme and external player fallback.</p>

      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => update({ theme: 'dark' })} className={`rounded-3xl border p-5 text-left ${settings.theme === 'dark' ? 'border-cyan-400 bg-cyan-400/10' : 'border-white/10 light:border-slate-200'}`}>
            <Moon className="mb-3" />
            <div className="font-black">Dark mode</div>
            <div className="text-xs text-slate-500">Default visual mode.</div>
          </button>
          <button onClick={() => update({ theme: 'light' })} className={`rounded-3xl border p-5 text-left ${settings.theme === 'light' ? 'border-cyan-400 bg-cyan-400/10' : 'border-white/10 light:border-slate-200'}`}>
            <Sun className="mb-3" />
            <div className="font-black">Light mode</div>
            <div className="text-xs text-slate-500">Brighter interface.</div>
          </button>
        </div>

        <label className="setting-row">
          <span>Auto-load default subscription</span>
          <input type="checkbox" checked={settings.autoLoadDefault} onChange={(e) => update({ autoLoadDefault: e.target.checked })} />
        </label>
        <label className="setting-row">
          <span>Auto-restart stalled stream</span>
          <input type="checkbox" checked={settings.autoRestart} onChange={(e) => update({ autoRestart: e.target.checked })} />
        </label>
        <label className="block">
          <span className="label">Network cache value</span>
          <input type="number" min={300} max={30000} step={500} value={settings.networkCacheMs} onChange={(e) => update({ networkCacheMs: Number(e.target.value) })} className="field mt-2" />
        </label>
        <label className="block">
          <span className="label">External player command</span>
          <input value={settings.externalPlayerCommand} onChange={(e) => update({ externalPlayerCommand: e.target.value })} className="field mt-2" placeholder="vlc" />
          <p className="mt-2 text-xs text-slate-500">Used by the Open in VLC fallback. Default: vlc.</p>
        </label>

        <button onClick={save} className="flex items-center gap-2 rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300">
          <Save size={16} /> Save settings
        </button>
      </div>
    </div>
  );
}
