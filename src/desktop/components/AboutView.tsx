import { useEffect, useState } from 'react';
import { Download, ExternalLink, Github, RefreshCw, ShieldCheck } from 'lucide-react';
import { AppInfo, UpdateInfo } from '../../core/types';
import { cn } from '../../core/utils';
import { api } from '../../core/api';
import { APP_NAME, APP_VERSION } from '../../core/appMeta';

interface Props {
  onStatus: (status: string) => void;
  onCheckUpdate: () => Promise<UpdateInfo>;
  onDownloadUpdate: (update: UpdateInfo) => void;
}

export function AboutView({ onStatus, onCheckUpdate, onDownloadUpdate }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<UpdateInfo | null>(null);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const result = await onCheckUpdate();
      setFound(result.available ? result : null);
      onStatus(result.available ? `TuxPlayerX ${result.latestVersion} is available.` : `You have the latest version (${result.currentVersion}).`);
    } catch (err) {
      onStatus(`Could not check for updates: ${String(err)}`);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    api.appInfo().then(setInfo).catch((err) => onStatus(String(err)));
  }, []);

  const open = async (url?: string) => {
    if (!url) return;
    // Links always open in the system browser, never inside the app window.
    await api.openUrl(url).catch((err) => onStatus(String(err)));
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-8 light:border-slate-200 light:bg-white">
        <div className="mb-6 flex items-center gap-4">
          <div className="grid h-20 w-20 place-items-center rounded-[1.7rem] bg-gradient-to-br from-cyan-400 to-emerald-400 text-2xl font-black text-slate-950">TX</div>
          <div>
            <h2 className="text-3xl font-black">{info?.name || APP_NAME}</h2>
            <p className="text-sm text-slate-500">Version {info?.version || APP_VERSION}</p>
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-7 text-slate-400 light:text-slate-600">
          TuxPlayerX is a desktop streaming player for user-provided M3U playlists and authorized MAC/Stalker/Ministra-style subscriptions. It is built with React, TypeScript, Tailwind CSS, Tauri and Rust.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {found ? (
            <button onClick={() => onDownloadUpdate(found)} className="btn-primary"><Download size={16} /> Download {found.latestVersion}</button>
          ) : (
            <button onClick={checkUpdate} disabled={checking} className="btn-primary">
              <RefreshCw size={16} className={cn(checking && 'animate-spin')} /> Check for updates
            </button>
          )}
          <button onClick={() => open(info?.downloadUrl)} className="btn-secondary"><Github size={16} /> Releases</button>
          <button onClick={() => open('https://github.com/eoliann')} className="btn-secondary"><ExternalLink size={16} /> Author GitHub</button>
        </div>
      </section>
      <aside className="rounded-[2rem] border border-amber-400/20 bg-amber-400/10 p-6 text-amber-100 light:bg-amber-50 light:text-amber-900">
        <ShieldCheck className="mb-4" />
        <h3 className="mb-3 text-lg font-black">Legal notice</h3>
        <p className="text-sm leading-6">This application is only a media player. The developer does not provide subscriptions, playlists, portal credentials or streaming content. Users are responsible for using only legal sources they are authorized to access.</p>
        <div className="mt-5 rounded-2xl bg-black/20 p-4 text-xs leading-5 light:bg-white/70">License: {info?.license || 'MIT'} · Author: {info?.author || 'eoliann'}</div>
      </aside>
    </div>
  );
}
