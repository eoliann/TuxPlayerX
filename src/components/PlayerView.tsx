import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Maximize2, Play, RefreshCw, Search } from 'lucide-react';
import { Channel, AppSettings, Subscription } from '../lib/types';
import { api, isTauriRuntime } from '../lib/api';
import { VideoSurface, VideoSurfaceHandle } from './VideoSurface';
import { cn } from '../lib/utils';

interface PlayerViewProps {
  settings: AppSettings;
  reloadToken: number;
  onStatus: (status: string) => void;
}

export function PlayerView({ settings, reloadToken, onStatus }: PlayerViewProps) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<number | ''>('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [search, setSearch] = useState('');
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [activeStreamUrl, setActiveStreamUrl] = useState('');
  const [externalPlayback, setExternalPlayback] = useState(false);
  const [platform, setPlatform] = useState('web');
  const [loading, setLoading] = useState(false);
  const videoSurfaceRef = useRef<VideoSurfaceHandle | null>(null);

  const isWindowsRuntime = isTauriRuntime() && platform === 'windows';

  const loadSubscriptions = async () => {
    const list = await api.listSubscriptions();
    setSubscriptions(list);
    const def = list.find((item) => item.isDefault) || list[0];
    if (def?.id) setSelectedSubId(def.id);
  };


  useEffect(() => {
    if (!isTauriRuntime()) return;
    const shutdown = () => {
      api.shutdownPlayback().catch(() => undefined);
    };
    window.addEventListener('beforeunload', shutdown);
    return () => {
      window.removeEventListener('beforeunload', shutdown);
      api.shutdownPlayback().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    api.currentPlatform()
      .then(setPlatform)
      .catch(() => setPlatform('unknown'));
  }, []);

  useEffect(() => {
    loadSubscriptions().catch((err) => onStatus(String(err)));
  }, [reloadToken]);

  useEffect(() => {
    if (!settings.autoLoadDefault) return;
    api.getDefaultSubscription()
      .then((sub) => {
        if (sub?.id) {
          setSelectedSubId(sub.id);
          return handleLoadChannels(sub.id);
        }
        onStatus('No default subscription configured.');
      })
      .catch((err) => onStatus(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, settings.autoLoadDefault]);

  const handleLoadChannels = async (id = selectedSubId) => {
    if (!id) return;
    setLoading(true);
    try {
      const list = await api.loadChannels(Number(id));
      setChannels(list);
      onStatus(`Loaded ${list.length} channels.`);
    } catch (err) {
      onStatus(String(err));
    } finally {
      setLoading(false);
    }
  };

  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter((ch) => `${ch.name} ${ch.group || ''}`.toLowerCase().includes(q));
  }, [channels, search]);

  const selectedSubscription = subscriptions.find((item) => item.id === selectedSubId);

  const stopSecondaryPlayback = async () => {
    if (!isTauriRuntime()) return;
    await Promise.allSettled([api.closePipWindow(), api.stopExternalPlayer(), api.stopVlcBridge()]);
  };

  const stopEmbeddedPlayback = async () => {
    videoSurfaceRef.current?.stop();
    setCurrentUrl('');
    if (isTauriRuntime()) {
      await api.stopVlcBridge().catch(() => undefined);
    }
  };

  const playChannel = async (channel: Channel) => {
    if (!selectedSubscription?.id) return;
    try {
      await stopSecondaryPlayback();
      const url = await api.resolveChannelStream(selectedSubscription.id, channel);
      setCurrentChannel(channel);
      setActiveStreamUrl(url);
      setExternalPlayback(false);

      let playbackUrl = url;
      let usedBridge = false;

      if (isWindowsRuntime) {
        try {
          onStatus('Starting local VLC bridge for in-app playback...');
          playbackUrl = await api.startVlcBridge(url);
          usedBridge = true;
        } catch (bridgeError) {
          onStatus(`VLC bridge could not start. Trying direct WebView playback. ${String(bridgeError)}`);
        }
      }

      setCurrentUrl(playbackUrl);
      onStatus(usedBridge ? `Playing ${channel.name} through local VLC bridge.` : `Playing ${channel.name}.`);
    } catch (err) {
      onStatus(String(err));
    }
  };

  const detachPlayer = async () => {
    if (!currentUrl || !currentChannel) {
      onStatus('Start a channel before opening Picture-in-Picture.');
      return;
    }

    try {
      await videoSurfaceRef.current?.requestPictureInPicture();
      setExternalPlayback(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus(`Picture-in-Picture is not available. ${message}`);
    }
  };

  const openExternal = async () => {
    if (!activeStreamUrl) {
      onStatus('Start a channel before opening external player.');
      return;
    }
    await api.openExternalPlayer(activeStreamUrl);
    await stopEmbeddedPlayback();
    setExternalPlayback(true);
    onStatus('Opened in VLC. Embedded playback stopped.');
  };

  return (
    <div className="grid h-[calc(100vh-112px)] min-h-[620px] grid-cols-[320px_minmax(0,1fr)] items-stretch gap-5">
      <section className="flex h-full min-h-0 flex-col rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-3 shadow-2xl shadow-black/20 light:border-slate-200 light:bg-white">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">Channels</h2>
            <p className="text-xs text-slate-500">Load, search and play streams.</p>
          </div>
          <button onClick={() => handleLoadChannels()} className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10 light:border-slate-200 light:bg-slate-50 light:text-slate-700">
            <RefreshCw size={18} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        <select
          className="mb-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm outline-none light:border-slate-200 light:bg-white"
          value={selectedSubId}
          onChange={(event) => setSelectedSubId(Number(event.target.value))}
        >
          <option value="">Select subscription</option>
          {subscriptions.map((sub) => (
            <option key={sub.id} value={sub.id}>{sub.name} ({sub.type.toUpperCase()})</option>
          ))}
        </select>

        <div className="mb-2 flex gap-2">
          <button onClick={() => handleLoadChannels()} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-3 py-2.5 text-sm font-black text-slate-950 hover:bg-cyan-300">
            <RefreshCw size={16} /> Load channels
          </button>
        </div>

        <div className="relative mb-2">
          <Search className="absolute left-3 top-3.5 text-slate-500" size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search channels..."
            className="w-full rounded-xl border border-white/10 bg-slate-900 py-2.5 pl-10 pr-3 text-sm outline-none light:border-slate-200 light:bg-white"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {filteredChannels.map((channel) => (
            <button
              key={channel.id}
              onClick={() => playChannel(channel)}
              className={cn(
                'mb-1.5 flex w-full items-center gap-2 rounded-xl border p-2 text-left transition-all',
                currentChannel?.id === channel.id
                  ? 'border-cyan-400/50 bg-cyan-400/15'
                  : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07] light:border-slate-200 light:bg-slate-50 light:hover:bg-slate-100',
              )}
            >
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-800 text-xs font-black text-cyan-300 light:bg-slate-200 light:text-cyan-700">TV</div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold">{channel.name}</div>
                <div className="truncate text-[11px] text-slate-500">{channel.group || 'Uncategorized'}</div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="min-w-0">
        <div className="flex h-full min-h-0 flex-col rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/20 light:border-slate-200 light:bg-white">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">{currentChannel?.name || 'Player'}</h2>
              <p className="text-xs text-slate-500">
                {isWindowsRuntime ? 'Windows uses a local VLC bridge for in-app playback when needed.' : 'Double-click the video for fullscreen.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => currentChannel && playChannel(currentChannel)} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold hover:bg-white/10 light:border-slate-200 light:bg-slate-50">
                <Play size={16} /> Restart
              </button>
              <button onClick={detachPlayer} className="flex items-center gap-2 rounded-2xl bg-emerald-400 px-4 py-2 text-sm font-black text-slate-950 hover:bg-emerald-300">
                <Maximize2 size={16} /> Picture-in-Picture
              </button>
              <button onClick={openExternal} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold hover:bg-white/10 light:border-slate-200 light:bg-slate-50">
                <ExternalLink size={16} /> Open in VLC
              </button>
            </div>
          </div>
          <div className="min-h-[460px] flex-1">
            {externalPlayback ? (
              <div className="grid h-full min-h-[460px] place-items-center rounded-3xl border border-white/10 bg-black text-center text-slate-400 shadow-2xl shadow-black/30 light:border-slate-200">
                <div className="max-w-md px-6">
                  <div className="text-lg font-black text-white">Playing in VLC</div>
                  <div className="mt-2 text-sm">The selected stream is playing externally in VLC.</div>
                  <div className="mt-4 text-xs text-slate-500">Use Restart, Detach video or Open in VLC to control where the stream runs.</div>
                </div>
              </div>
            ) : (
              <VideoSurface ref={videoSurfaceRef} src={currentUrl} title={currentChannel?.name} autoRestart={settings.autoRestart} onStatus={onStatus} />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
