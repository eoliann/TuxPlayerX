import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Moon, RefreshCw, Save, Sun } from 'lucide-react';
import { AppInfo, AppSettings, UpdateInfo } from '../core/types';
import { api } from '../core/api';
import { ANDROID_VERSION, APP_NAME } from '../core/appMeta';
import { cn } from '../core/utils';

interface Props {
  settings: AppSettings;
  onSettings: (settings: AppSettings) => void;
  onStatus: (status: string) => void;
  onCheckUpdate: () => Promise<UpdateInfo>;
  onDownloadUpdate: (update: UpdateInfo) => void;
}

export function MobileSettings({ settings, onSettings, onStatus, onCheckUpdate, onDownloadUpdate }: Props) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<UpdateInfo | null>(null);
  // Unsaved edits survive the theme being applied (which updates `settings`).
  const dirtyRef = useRef(false);

  useEffect(() => {
    setDraft((prev) => (dirtyRef.current ? { ...prev, theme: settings.theme } : settings));
  }, [settings]);
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => undefined);
  }, []);

  const update = (patch: Partial<AppSettings>) => {
    dirtyRef.current = true;
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  /** The theme applies and is stored right away, like on desktop; other settings wait for Save. */
  const selectTheme = (theme: AppSettings['theme']) => {
    const next = { ...settings, theme };
    onSettings(next);
    api.saveSettings(next).catch((error) => onStatus(String(error)));
  };

  const save = async () => {
    try {
      await api.saveSettings(draft);
      dirtyRef.current = false;
      onSettings(draft);
      onStatus('Settings saved.');
    } catch (error) {
      onStatus(String(error));
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const result = await onCheckUpdate();
      setFound(result.available ? result : null);
      onStatus(result.available ? `TuxPlayerX ${result.latestVersion} is available.` : `You have the latest version (${result.currentVersion}).`);
    } catch (error) {
      onStatus(`Could not check for updates: ${String(error)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4">
      <h2 className="text-xl font-black">Settings</h2>

      <div className="grid grid-cols-2 gap-2">
        {(['dark', 'light'] as const).map((theme) => (
          <button
            key={theme}
            type="button"
            onClick={() => selectTheme(theme)}
            className={cn(
              'flex items-center gap-2 rounded-2xl border p-4 text-sm font-black',
              draft.theme === theme ? 'border-cyan-400 bg-cyan-400/10' : 'border-white/10 light:border-slate-200',
            )}
          >
            {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
            {theme === 'dark' ? 'Dark' : 'Light'}
          </button>
        ))}
      </div>

      <label className="setting-row">
        <span>Check for new versions on startup</span>
        <input type="checkbox" checked={draft.checkUpdates} onChange={(e) => update({ checkUpdates: e.target.checked })} />
      </label>

      <label className="setting-row">
        <span>Auto-restart stalled streams</span>
        <input type="checkbox" checked={draft.autoRestart} onChange={(e) => update({ autoRestart: e.target.checked })} />
      </label>

      <label className="block">
        <span className="label">TV guide (XMLTV) sources</span>
        <textarea
          value={draft.epgUrl}
          onChange={(e) => update({ epgUrl: e.target.value })}
          rows={3}
          className="field mt-2 w-full"
          placeholder="One URL per line (.xml or .xml.gz)"
        />
      </label>

      <button type="button" onClick={save} className="btn-primary w-full justify-center">
        <Save size={18} /> Save settings
      </button>

      <div className="rounded-3xl border border-white/10 p-4 text-sm light:border-slate-200">
        <div className="font-black">{info?.name || APP_NAME} for Android</div>
        <div className="mt-1 text-slate-400 light:text-slate-500">Version {info?.version || ANDROID_VERSION}</div>
        <p className="mt-2 text-xs text-slate-400">
          Plays your own M3U playlists and MAC portal subscriptions. Some channels use video or audio formats your device cannot decode.
        </p>
        {found ? (
          <button type="button" onClick={() => onDownloadUpdate(found)} className="btn-primary mt-3">
            <Download size={16} /> Download {found.latestVersion}
          </button>
        ) : (
          <button type="button" onClick={checkUpdate} disabled={checking} className="btn-primary mt-3">
            <RefreshCw size={16} className={cn(checking && 'animate-spin')} /> Check for updates
          </button>
        )}
        {info?.repository && (
          <button type="button" onClick={() => api.openUrl(`https://github.com/${info.repository}`).catch((error) => onStatus(String(error)))} className="btn-secondary ml-2 mt-3">
            <ExternalLink size={16} /> Project on GitHub
          </button>
        )}
      </div>
    </div>
  );
}
