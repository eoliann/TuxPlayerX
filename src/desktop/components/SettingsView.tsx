import { useEffect, useRef, useState } from 'react';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { Download, FolderOpen, Moon, Save, Sun, Upload } from 'lucide-react';
import { AppSettings } from '../../core/types';
import { api } from '../../core/api';

interface Props {
  settings: AppSettings;
  onSettings: (settings: AppSettings) => void;
  /** Called after a backup import so subscription lists are reloaded. */
  onDataChanged: () => void;
  onStatus: (status: string) => void;
}

export function SettingsView({ settings: savedSettings, onSettings, onDataChanged, onStatus }: Props) {
  // Edits stay local until saved, so the player does not react (e.g. reload the EPG) on every keystroke.
  const [settings, setSettings] = useState<AppSettings>(savedSettings);
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current) setSettings(savedSettings);
  }, [savedSettings]);

  const update = (patch: Partial<AppSettings>) => {
    dirtyRef.current = true;
    setSettings((prev) => ({ ...prev, ...patch }));
    // Theme previews immediately; everything else applies on save.
    if (patch.theme) onSettings({ ...savedSettings, theme: patch.theme });
  };

  const [lastBackupPath, setLastBackupPath] = useState('');
  const importInputRef = useRef<HTMLInputElement | null>(null);

  /** The backup contains subscription passwords, so the user chooses where it is stored. */
  const exportBackup = async () => {
    try {
      const target = await saveFileDialog({
        title: 'Save TuxPlayerX backup (contains passwords)',
        defaultPath: `TuxPlayerX-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'TuxPlayerX backup', extensions: ['json'] }],
      });
      if (!target) return;
      const path = await api.exportBackup(target);
      setLastBackupPath(path);
      onStatus(`Backup saved: ${path}`);
    } catch (err) {
      onStatus(`Backup failed: ${String(err)}`);
    }
  };

  const importBackup = async (file: File) => {
    try {
      const summary = await api.importBackup(await file.text());
      dirtyRef.current = false;
      onSettings(summary.settings);
      onDataChanged();
      onStatus(
        `Backup imported: ${summary.addedSubscriptions} new subscription(s), ${summary.existingSubscriptions} already present, ${summary.favorites} favorite(s) added.`,
      );
    } catch (err) {
      onStatus(`Import failed: ${String(err)}`);
    }
  };

  const save = async () => {
    try {
      await api.saveSettings(settings);
      dirtyRef.current = false;
      onSettings(settings);
      onStatus('Settings saved.');
    } catch (err) {
      onStatus(String(err));
    }
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
          <span>Resume last watched channel on startup</span>
          <input type="checkbox" checked={settings.resumeLastChannel} onChange={(e) => update({ resumeLastChannel: e.target.checked })} />
        </label>
        <label className="setting-row">
          <span>Auto-restart stalled stream</span>
          <input type="checkbox" checked={settings.autoRestart} onChange={(e) => update({ autoRestart: e.target.checked })} />
        </label>
        <label className="block">
          <span className="label">Live TV playback engine</span>
          <select value={settings.playbackEngine} onChange={(e) => update({ playbackEngine: e.target.value as AppSettings['playbackEngine'] })} className="field mt-2">
            <option value="auto">Built-in player, VLC only when needed (recommended)</option>
            <option value="vlc">Always through VLC</option>
          </select>
          <p className="mt-2 text-xs text-slate-500">The built-in player uses almost no CPU. Channels it cannot play (for example HEVC video or AC-3 audio) switch to VLC automatically. Choose "Always through VLC" if some channels play without sound.</p>
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

        <label className="block">
          <span className="label">EPG / XMLTV sources</span>
          <textarea
            value={settings.epgUrl}
            onChange={(e) => update({ epgUrl: e.target.value })}
            className="field mt-2 min-h-24 resize-y font-mono text-xs"
            placeholder={'https://epgshare01.online/epgshare01/epg_ripper_RO1.xml.gz\nhttps://www.open-epg.com/files/romania1.xml.gz'}
            spellCheck={false}
          />
          <p className="mt-2 text-xs text-slate-500">Optional. One URL or local file per line; .xml and compressed .xml.gz are supported and all sources are combined. XMLTV channel IDs are matched against M3U tvg-id or channel name.</p>
        </label>

        <div className="grid gap-4 rounded-3xl border border-white/10 bg-black/10 p-4 light:border-slate-200 light:bg-slate-50">
          <div>
            <div className="font-black">EPG time correction</div>
            <p className="mt-1 text-xs text-slate-500">
              Use Auto first. If the guide is still shifted, use Manual offset to adjust the displayed programme times.
            </p>
          </div>

          <label className="block">
            <span className="label">EPG timezone mode</span>
            <select
              value={settings.epgTimezoneMode || 'auto'}
              onChange={(e) => update({ epgTimezoneMode: e.target.value as AppSettings['epgTimezoneMode'] })}
              className="field mt-2"
            >
              <option value="auto">Auto / XMLTV timezone</option>
              <option value="local">Treat EPG times as local time</option>
              <option value="manual">Manual offset</option>
            </select>
          </label>

          <label className="block">
            <span className="label">Manual EPG offset</span>
            <input
              type="number"
              min={-720}
              max={720}
              step={30}
              value={settings.epgTimeOffsetMinutes ?? 0}
              onChange={(e) => update({ epgTimeOffsetMinutes: Number(e.target.value) })}
              className="field mt-2"
              disabled={(settings.epgTimezoneMode || 'auto') !== 'manual'}
            />
            <p className="mt-2 text-xs text-slate-500">
              Value in minutes. Examples: -60 if programmes appear one hour late, +60 if they appear one hour early.
            </p>
          </label>
        </div>


        <div className="grid gap-3 rounded-3xl border border-white/10 bg-black/10 p-4 light:border-slate-200 light:bg-slate-50">
          <div>
            <div className="font-black">Backup &amp; restore</div>
            <p className="mt-1 text-xs text-slate-500">
              Saves subscriptions, favorites, recently watched channels and settings to a JSON file in your Downloads folder.
              Importing merges the file into the current data without deleting anything. The file contains subscription
              credentials, so keep it private.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={exportBackup} className="btn-secondary"><Download size={15} /> Export backup</button>
            <button onClick={() => importInputRef.current?.click()} className="btn-secondary"><Upload size={15} /> Import backup</button>
            {lastBackupPath && (
              <button onClick={() => api.revealBackup(lastBackupPath).catch((err) => onStatus(String(err)))} className="btn-secondary">
                <FolderOpen size={15} /> Open folder
              </button>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) importBackup(file).catch(() => undefined);
              }}
            />
          </div>
          {lastBackupPath && <p className="break-all text-xs text-slate-500">Last backup: {lastBackupPath}</p>}
        </div>

        <button onClick={save} className="flex items-center gap-2 rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300">
          <Save size={16} /> Save settings
        </button>
      </div>
    </div>
  );
}
