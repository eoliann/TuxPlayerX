import { useEffect, useState } from 'react';
import { ExternalLink, Github, ShieldCheck } from 'lucide-react';
import { AppInfo } from '../lib/types';
import { api } from '../lib/api';
import { APP_NAME, APP_VERSION } from '../lib/appMeta';

interface Props {
  onStatus: (status: string) => void;
}

export function AboutView({ onStatus }: Props) {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    api.appInfo().then(setInfo).catch((err) => onStatus(String(err)));
  }, []);

  const open = async (url?: string) => {
    if (!url) return;
    await api.openUrl(url).catch(() => window.open(url, '_blank'));
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
          <button onClick={() => open(info?.downloadUrl)} className="btn-primary"><Github size={16} /> Releases</button>
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
