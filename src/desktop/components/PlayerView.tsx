import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ExternalLink, History, Keyboard, LayoutGrid, Maximize2, Play, Radio, RefreshCw, Search } from 'lucide-react';
import { Channel, EpgGridItem, EpgNow, EpgProgram, AppSettings, StreamHeaders, Subscription } from '../../core/types';
import type { StreamFormat } from '../../core/stream';
import { api, isTauriRuntime } from '../../core/api';
import { VideoSurface, VideoSurfaceHandle } from '../../core/components/VideoSurface';
import { ChannelList, ChannelListHandle } from './ChannelList';
import { EpgGrid } from './EpgGrid';
import { cn, isCatchupAvailable } from '../../core/utils';

interface PlayerViewProps {
  settings: AppSettings;
  reloadToken: number;
  /** False while another page is shown; the player keeps running but keyboard shortcuts are disabled. */
  active: boolean;
  /** Incremented when another part of the app (e.g. movies) starts playing, so live playback stops. */
  stopSignal: number;
  onStatus: (status: string) => void;
}

const FILTER_ALL = '__all__';
const FILTER_FAVORITES = '__favorites__';
const FILTER_RECENT = '__recent__';
const UNCATEGORIZED = 'Uncategorized';
/** Delay before a channel picked with the arrow keys starts playing, so quick zapping does not resolve every stream. */
const ZAP_DELAY_MS = 400;

/** 'direct': built-in player via the local proxy; 'bridge': VLC remux; 'transcode': VLC with video re-encoding. */
type PlaybackMode = 'direct' | 'bridge' | 'transcode';

interface ActiveStream {
  url: string;
  label: string;
  seq: number;
  /** Identifies the channel (or archive programme) across sessions of zapping. */
  key: string;
  headers: StreamHeaders;
  mode: PlaybackMode;
}

function channelHeaders(channel: Channel): StreamHeaders {
  return { userAgent: channel.userAgent, referrer: channel.referrer };
}
const EPG_REFRESH_MS = 60_000;

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PlayerView({ settings, reloadToken, active, stopSignal, onStatus }: PlayerViewProps) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<number | ''>('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(FILTER_ALL);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [epgNow, setEpgNow] = useState<Record<string, EpgNow>>({});
  const [epgRevision, setEpgRevision] = useState(0);
  const [zapTargetId, setZapTargetId] = useState<string | null>(null);
  const [currentChannel, setCurrentChannel] = useState<Channel | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');
  const [activeStreamUrl, setActiveStreamUrl] = useState('');
  /** How the current stream reaches the embedded player, so a failure can move it to the next way. */
  const streamRef = useRef<ActiveStream | null>(null);
  const [streamMode, setStreamMode] = useState<PlaybackMode | null>(null);
  const [currentFormat, setCurrentFormat] = useState<StreamFormat | undefined>(undefined);
  /** Channels that needed VLC in this session start there directly the next time. */
  const vlcNeededRef = useRef(new Map<string, PlaybackMode>());
  const activeHeadersRef = useRef<StreamHeaders>({});
  /** Where the stream runs when it is not in the embedded player. */
  const [playingElsewhere, setPlayingElsewhere] = useState<'vlc' | 'window' | null>(null);
  const [loading, setLoading] = useState(false);
  const [epgPrograms, setEpgPrograms] = useState<EpgProgram[]>([]);
  const [epgLoading, setEpgLoading] = useState(false);
  const [showGrid, setShowGrid] = useState(false);
  /** Set while a programme from the TV archive is playing instead of the live stream. */
  const [catchup, setCatchup] = useState<{ title: string; start: number } | null>(null);
  const videoSurfaceRef = useRef<VideoSurfaceHandle | null>(null);
  const channelListRef = useRef<ChannelListHandle | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const epgScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedSubIdRef = useRef<number | ''>('');
  selectedSubIdRef.current = selectedSubId;
  const loadSeqRef = useRef(0);
  const playSeqRef = useRef(0);
  const resumedRef = useRef(false);
  const zapTimerRef = useRef<number | undefined>(undefined);
  const deferredSearch = useDeferredValue(search);

  // Scroll only the guide panel (not the whole page) so the current programme is centered.
  const nowPlayingRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    window.requestAnimationFrame(() => {
      const container = epgScrollRef.current;
      if (!container) return;
      container.scrollTo({ top: node.offsetTop - container.clientHeight / 2 + node.clientHeight / 2, behavior: 'smooth' });
    });
  }, []);


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
    let cancelled = false;
    (async () => {
      const list = await api.listSubscriptions();
      if (cancelled) return;
      setSubscriptions(list);
      const current = selectedSubIdRef.current;
      const target = (current && list.find((item) => item.id === current)) || list.find((item) => item.isDefault) || list[0];
      if (!target?.id) {
        setSelectedSubId('');
        setChannels([]);
        onStatus('No subscription configured. Add one in Subscriptions.');
        return;
      }
      setSelectedSubId(target.id);
      selectedSubIdRef.current = target.id;
      if (settings.autoLoadDefault || current === target.id) {
        const resume = !resumedRef.current && settings.resumeLastChannel;
        resumedRef.current = true;
        await handleLoadChannels(target.id, false, resume);
      }
    })().catch((err) => onStatus(String(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  useEffect(() => {
    if (!currentChannel) {
      setEpgPrograms([]);
      return;
    }
    loadEpgForChannel(currentChannel).catch(() => undefined);
    // Keep the "Live" marker up to date; the guide is cached in the backend, so this is cheap.
    const timer = window.setInterval(() => loadEpgForChannel(currentChannel, false, true).catch(() => undefined), EPG_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChannel?.id, settings.epgUrl, settings.epgTimezoneMode, settings.epgTimeOffsetMinutes, epgRevision]);

  const epgKeys = useMemo(() => channels.map((ch) => ({ id: ch.id, name: ch.name, epgId: ch.epgId })), [channels]);

  useEffect(() => {
    if (!settings.epgUrl?.trim() || epgKeys.length === 0) {
      setEpgNow({});
      return;
    }
    let cancelled = false;
    const refresh = () => {
      api.loadEpgNow(epgKeys)
        .then((map) => {
          if (!cancelled) setEpgNow(map);
        })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, EPG_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [epgKeys, settings.epgUrl, settings.epgTimezoneMode, settings.epgTimeOffsetMinutes, epgRevision]);

  const handleLoadChannels = async (id: number | '' = selectedSubIdRef.current, force = false, resume = false) => {
    if (!id) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const [result, favoriteIds, recentIds] = await Promise.all([
        api.loadChannels(Number(id), force),
        api.listFavorites(Number(id)),
        api.listRecents(Number(id)),
      ]);
      // Ignore results for a subscription the user has already switched away from.
      if (seq !== loadSeqRef.current) return;
      setChannels(result.channels);
      setFavorites(new Set(favoriteIds));
      setRecents(recentIds);
      onStatus(
        result.fromCache
          ? `Loaded ${result.channels.length} channels from cache (updated ${formatTime(result.fetchedAt)}). Use refresh to download again.`
          : `Loaded ${result.channels.length} channels.`,
      );
      if (resume && recentIds[0]) {
        const last = result.channels.find((ch) => ch.id === recentIds[0]);
        if (last) playChannel(last, Number(id)).catch(() => undefined);
      }
    } catch (err) {
      if (seq === loadSeqRef.current) onStatus(String(err));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  const loadEpgForChannel = async (channel: Channel, force = false, silent = false) => {
    if (!settings.epgUrl?.trim()) {
      setEpgPrograms([]);
      return;
    }
    if (!silent) setEpgLoading(true);
    try {
      const programs = await api.loadEpgPrograms(channel, force);
      setEpgPrograms(programs);
    } catch (err) {
      setEpgPrograms([]);
      if (!silent) onStatus(`EPG unavailable: ${String(err)}`);
    } finally {
      if (!silent) setEpgLoading(false);
    }
  };

  const refreshEpg = async () => {
    if (!currentChannel) {
      setEpgRevision((value) => value + 1);
      return;
    }
    await loadEpgForChannel(currentChannel, true);
    setEpgRevision((value) => value + 1);
  };

  // Lowercased "name group" per channel, computed once per channel list instead of on every keystroke.
  const searchIndex = useMemo(() => channels.map((ch) => `${ch.name} ${ch.group || ''}`.toLowerCase()), [channels]);

  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ch of channels) {
      const group = ch.group || UNCATEGORIZED;
      counts.set(group, (counts.get(group) || 0) + 1);
    }
    return [...counts.entries()];
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    let indices: number[];
    if (filter === FILTER_RECENT) {
      const position = new Map(channels.map((ch, index) => [ch.id, index]));
      indices = recents.map((id) => position.get(id)).filter((index): index is number => index !== undefined);
    } else if (filter === FILTER_FAVORITES) {
      indices = [];
      channels.forEach((ch, index) => favorites.has(ch.id) && indices.push(index));
    } else if (filter === FILTER_ALL) {
      indices = channels.map((_, index) => index);
    } else {
      indices = [];
      channels.forEach((ch, index) => (ch.group || UNCATEGORIZED) === filter && indices.push(index));
    }
    if (q) indices = indices.filter((index) => searchIndex[index].includes(q));
    return indices.map((index) => channels[index]);
  }, [channels, searchIndex, deferredSearch, filter, favorites, recents]);

  // If the selected group disappears after a reload, fall back to all channels.
  useEffect(() => {
    if (filter !== FILTER_ALL && filter !== FILTER_FAVORITES && filter !== FILTER_RECENT && !groups.some(([name]) => name === filter)) {
      setFilter(FILTER_ALL);
    }
  }, [groups, filter]);

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

  /**
   * Starts a resolved stream in the embedded player.
   * 'direct': built-in player through the local proxy (hls.js / mpegts.js), almost no CPU.
   * 'bridge': VLC remuxes the stream to local HLS. 'transcode': VLC also re-encodes the video.
   */
  const startStream = async (url: string, seq: number, label: string, key: string, headers: StreamHeaders = {}, mode?: PlaybackMode) => {
    setActiveStreamUrl(url);
    activeHeadersRef.current = headers;
    setPlayingElsewhere(null);
    streamRef.current = null;

    if (!isTauriRuntime()) {
      setStreamMode(null);
      setCurrentFormat(undefined);
      setCurrentUrl(url);
      onStatus(`Playing ${label}.`);
      return true;
    }

    let chosen: PlaybackMode = mode ?? (settings.playbackEngine === 'vlc' ? 'bridge' : vlcNeededRef.current.get(key) ?? 'direct');

    if (chosen === 'direct') {
      try {
        onStatus(`Connecting to ${label}...`);
        const direct = await api.prepareDirectStream(url, headers);
        if (seq !== playSeqRef.current) return false;
        streamRef.current = { url, label, seq, key, headers, mode: 'direct' };
        setStreamMode('direct');
        setCurrentFormat(direct.format);
        setCurrentUrl(direct.url);
        onStatus(`Playing ${label}.`);
        return true;
      } catch (error) {
        if (seq !== playSeqRef.current) return false;
        onStatus(`The built-in player cannot open ${label} (${String(error)}). Trying VLC...`);
        chosen = 'bridge';
      }
    }

    try {
      if (mode !== 'transcode') onStatus(`Connecting to ${label} through VLC...`);
      const bridgeUrl = await api.startVlcBridge(url, chosen === 'transcode', headers);
      if (seq !== playSeqRef.current) return false;
      streamRef.current = { url, label, seq, key, headers, mode: chosen };
      setStreamMode(chosen);
      setCurrentFormat('hls');
      setCurrentUrl(bridgeUrl);
      onStatus(`Playing ${label} through VLC${chosen === 'transcode' ? ' (converted)' : ''}.`);
      return true;
    } catch (bridgeError) {
      if (seq !== playSeqRef.current) return false;
      const message = String(bridgeError);
      setCurrentUrl('');
      setStreamMode(null);
      onStatus(message.includes('Could not start VLC bridge')
        ? `${label} cannot be played by the built-in player and VLC was not found. Install VLC or set its path in Settings.`
        : message);
      return false;
    }
  };

  /**
   * The embedded player gave up: move the stream to the next way of playing it
   * (built-in player → VLC bridge → VLC with video conversion).
   */
  const handleEmbeddedFailure = (unsupported: boolean) => {
    const current = streamRef.current;
    const next: PlaybackMode | null = !current
      ? null
      : current.mode === 'direct'
        ? 'bridge'
        : current.mode === 'bridge' && unsupported
          ? 'transcode'
          : null;
    if (!current || !next || current.seq !== playSeqRef.current) {
      onStatus('This stream format is not supported by the built-in player. Try Open in VLC.');
      return;
    }
    vlcNeededRef.current.set(current.key, next);
    onStatus(next === 'transcode' ? `Converting ${current.label} for the built-in player...` : `${current.label} needs VLC, switching...`);
    startStream(current.url, current.seq, current.label, current.key, current.headers, next).catch((error) => onStatus(String(error)));
  };

  const beginPlayback = (channel: Channel) => {
    const seq = ++playSeqRef.current;
    window.clearTimeout(zapTimerRef.current);
    setZapTargetId(null);
    setCurrentChannel(channel);
    return seq;
  };

  const playChannel = async (channel: Channel, subscriptionId: number | '' = selectedSubIdRef.current) => {
    if (!subscriptionId) return;
    const seq = beginPlayback(channel);
    setCatchup(null);
    try {
      await stopSecondaryPlayback();
      const url = await api.resolveChannelStream(Number(subscriptionId), channel);
      // A newer channel was requested while this one was resolving.
      if (seq !== playSeqRef.current) return;
      if (!(await startStream(url, seq, channel.name, channel.id, channelHeaders(channel)))) return;
      api.recordRecent(Number(subscriptionId), channel.id)
        .then(() => setRecents((prev) => [channel.id, ...prev.filter((id) => id !== channel.id)].slice(0, 30)))
        .catch(() => undefined);
    } catch (err) {
      if (seq === playSeqRef.current) onStatus(String(err));
    }
  };

  /** Replays a past programme from the channel's TV archive. Times are Unix seconds. */
  const playCatchup = async (channel: Channel, title: string, start: number, stop: number) => {
    const seq = beginPlayback(channel);
    try {
      await stopSecondaryPlayback();
      const url = await api.resolveCatchupStream(channel, start, stop);
      if (seq !== playSeqRef.current) return;
      setCatchup({ title, start });
      await startStream(url, seq, `${title} (archive)`, `${channel.id}|archive`, channelHeaders(channel));
    } catch (err) {
      if (seq === playSeqRef.current) onStatus(`Catch-up failed: ${String(err)}`);
    }
  };

  const playGridCatchup = (channel: Channel, item: EpgGridItem) => {
    setShowGrid(false);
    playCatchup(channel, item.title, item.start, item.stop).catch(() => undefined);
  };

  // Stop live playback when movies/series start playing elsewhere in the app.
  useEffect(() => {
    if (!stopSignal) return;
    playSeqRef.current += 1;
    stopEmbeddedPlayback().catch(() => undefined);
    stopSecondaryPlayback().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSignal]);

  const toggleFavorite = async (channel: Channel) => {
    if (!selectedSubId) return;
    try {
      const isFavorite = await api.toggleFavorite(Number(selectedSubId), channel.id);
      setFavorites((prev) => {
        const next = new Set(prev);
        if (isFavorite) next.add(channel.id);
        else next.delete(channel.id);
        return next;
      });
      onStatus(isFavorite ? `${channel.name} added to favorites.` : `${channel.name} removed from favorites.`);
    } catch (err) {
      onStatus(String(err));
    }
  };

  const changeSubscription = (id: number | '') => {
    setSelectedSubId(id);
    selectedSubIdRef.current = id;
    setFilter(FILTER_ALL);
    setSearch('');
    if (id) {
      handleLoadChannels(id).catch(() => undefined);
    } else {
      setChannels([]);
    }
  };

  /** Moves the selection with the keyboard and starts playback once the user stops pressing keys. */
  const zap = (delta: number) => {
    const list = filteredChannels;
    if (list.length === 0) return;
    const fromId = zapTargetId ?? currentChannel?.id;
    const index = list.findIndex((ch) => ch.id === fromId);
    const nextIndex = index < 0 ? (delta > 0 ? 0 : list.length - 1) : (index + delta + list.length) % list.length;
    const next = list[nextIndex];
    setZapTargetId(next.id);
    channelListRef.current?.scrollToIndex(nextIndex);
    onStatus(`Switching to ${next.name}...`);
    window.clearTimeout(zapTimerRef.current);
    zapTimerRef.current = window.setTimeout(() => {
      playChannel(next).catch(() => undefined);
    }, ZAP_DELAY_MS);
  };

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing = !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }
    if (typing) {
      if (event.key === 'Escape' && target === searchInputRef.current) {
        setSearch('');
        searchInputRef.current?.blur();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        zap(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        zap(-1);
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        videoSurfaceRef.current?.requestFullscreen().catch(() => undefined);
        break;
      case 'm':
      case 'M': {
        if (!videoSurfaceRef.current) break;
        const muted = videoSurfaceRef.current.toggleMute();
        onStatus(muted ? 'Sound muted.' : 'Sound on.');
        break;
      }
      case 'g':
      case 'G':
        setShowGrid((value) => !value);
        break;
      case 'a':
      case 'A': {
        const label = videoSurfaceRef.current?.cycleAudioTrack();
        onStatus(label ? `Audio: ${label}` : 'This stream has a single audio track.');
        break;
      }
      case 'c':
      case 'C': {
        const label = videoSurfaceRef.current?.cycleSubtitles();
        onStatus(label ? `Subtitles: ${label}` : 'This stream has no subtitles.');
        break;
      }
      case 'r':
      case 'R':
        if (currentChannel) playChannel(currentChannel).catch(() => undefined);
        break;
      case '/':
        event.preventDefault();
        searchInputRef.current?.focus();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  useEffect(() => () => window.clearTimeout(zapTimerRef.current), []);

  const detachPlayer = async () => {
    if (!currentUrl || !currentChannel) {
      onStatus('Start a channel before opening Picture-in-Picture.');
      return;
    }

    try {
      await videoSurfaceRef.current?.requestPictureInPicture();
      setPlayingElsewhere(null);
      return;
    } catch (err) {
      if (!isTauriRuntime()) {
        const message = err instanceof Error ? err.message : String(err);
        onStatus(`Picture-in-Picture is not available. ${message}`);
        return;
      }
    }

    // The Linux WebView has no native Picture-in-Picture: use a detached always-on-top window instead.
    try {
      await api.openPipWindow(currentUrl, currentChannel.name);
      // Stop only the embedded video; on Windows the window keeps using the running VLC bridge.
      videoSurfaceRef.current?.stop();
      setCurrentUrl('');
      setPlayingElsewhere('window');
      onStatus('Playing in a detached window. Press Esc in it or use "Play here" to bring the video back.');
    } catch (err) {
      onStatus(`Could not open the detached window. ${String(err)}`);
    }
  };

  const openExternal = async () => {
    if (!activeStreamUrl) {
      onStatus('Start a channel before opening external player.');
      return;
    }
    await api.openExternalPlayer(activeStreamUrl, activeHeadersRef.current);
    await stopEmbeddedPlayback();
    setPlayingElsewhere('vlc');
    onStatus('Opened in VLC. Embedded playback stopped.');
  };

  const emptyMessage = channels.length === 0
    ? (loading ? 'Loading channels...' : 'No channels loaded. Select a subscription and refresh.')
    : filter === FILTER_FAVORITES && favorites.size === 0
      ? 'No favorites yet. Use the star next to a channel to add it.'
      : filter === FILTER_RECENT && recents.length === 0
        ? 'No recently watched channels yet.'
        : 'No channels match this search.';

  return (
    <div className="grid h-[calc(100vh-112px)] min-h-[620px] grid-cols-[320px_minmax(0,1fr)] items-stretch gap-5">
      <section className="flex h-full min-h-0 flex-col rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-3 shadow-2xl shadow-black/20 light:border-slate-200 light:bg-white">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">Channels</h2>
            <p className="text-xs text-slate-500">
              {channels.length > 0 ? `${filteredChannels.length} of ${channels.length} channels` : 'Load, search and play streams.'}
            </p>
          </div>
          <button
            onClick={() => handleLoadChannels(selectedSubId, true)}
            title="Download the channel list again from the provider"
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10 light:border-slate-200 light:bg-slate-50 light:text-slate-700"
          >
            <RefreshCw size={18} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        <select
          className="mb-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm outline-none light:border-slate-200 light:bg-white"
          value={selectedSubId}
          onChange={(event) => changeSubscription(event.target.value ? Number(event.target.value) : '')}
        >
          <option value="">Select subscription</option>
          {subscriptions.map((sub) => (
            <option key={sub.id} value={sub.id}>{sub.name} ({sub.type.toUpperCase()})</option>
          ))}
        </select>

        <select
          className="mb-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm outline-none light:border-slate-200 light:bg-white"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={channels.length === 0}
        >
          <option value={FILTER_ALL}>All channels ({channels.length})</option>
          <option value={FILTER_FAVORITES}>★ Favorites ({favorites.size})</option>
          <option value={FILTER_RECENT}>Recently watched</option>
          {groups.map(([name, count]) => (
            <option key={name} value={name}>{name} ({count})</option>
          ))}
        </select>

        <div className="relative mb-2">
          <Search className="absolute left-3 top-3.5 text-slate-500" size={16} />
          <input
            ref={searchInputRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search channels... (Ctrl+F)"
            className="w-full rounded-xl border border-white/10 bg-slate-900 py-2.5 pl-10 pr-3 text-sm outline-none light:border-slate-200 light:bg-white"
          />
        </div>

        <ChannelList
          ref={channelListRef}
          channels={filteredChannels}
          selectedId={zapTargetId ?? currentChannel?.id}
          favorites={favorites}
          epgNow={epgNow}
          emptyMessage={emptyMessage}
          resetKey={`${selectedSubId}|${filter}|${deferredSearch}`}
          onSelect={(channel) => playChannel(channel)}
          onToggleFavorite={toggleFavorite}
        />
      </section>

      <section className="relative min-w-0">
        {showGrid && (
          <EpgGrid
            channels={filteredChannels}
            currentChannelId={currentChannel?.id}
            epgKey={`${settings.epgUrl}|${settings.epgTimezoneMode}|${settings.epgTimeOffsetMinutes}|${epgRevision}`}
            onPlayChannel={(channel) => {
              setShowGrid(false);
              playChannel(channel).catch(() => undefined);
            }}
            onPlayCatchup={playGridCatchup}
            onClose={() => setShowGrid(false)}
          />
        )}
        <div className="flex h-full min-h-0 flex-col rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/20 light:border-slate-200 light:bg-white">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black">
                {currentChannel?.name || 'Player'}
                {catchup && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-black text-emerald-300 light:text-emerald-700">
                    <History size={12} /> Archive: {catchup.title} · {new Date(catchup.start * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500">
                {streamMode === 'bridge' || streamMode === 'transcode' ? 'This channel plays through VLC. Double-click the video for fullscreen.' : 'Double-click the video for fullscreen.'}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500" title="Keyboard shortcuts">
                <Keyboard size={13} /> ↑/↓ channel · G guide · F fullscreen · M mute · A audio · C subtitles · R restart · Ctrl+F search
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {catchup && currentChannel && (
                <button onClick={() => playChannel(currentChannel)} className="flex items-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm font-bold hover:bg-emerald-400/20">
                  <Radio size={16} /> Back to live
                </button>
              )}
              <button onClick={() => setShowGrid((value) => !value)} title="Full TV guide (G)" className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold hover:bg-white/10 light:border-slate-200 light:bg-slate-50">
                <LayoutGrid size={16} /> TV Guide
              </button>
              <button onClick={() => refreshEpg()} title="Download the TV guide again" className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold hover:bg-white/10 light:border-slate-200 light:bg-slate-50">
                <CalendarDays size={16} /> EPG
              </button>
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
            {playingElsewhere ? (
              <div className="grid h-full min-h-[460px] place-items-center rounded-3xl border border-white/10 bg-black text-center text-slate-400 shadow-2xl shadow-black/30 light:border-slate-200">
                <div className="max-w-md px-6">
                  <div className="text-lg font-black text-white">{playingElsewhere === 'vlc' ? 'Playing in VLC' : 'Playing in a detached window'}</div>
                  <div className="mt-2 text-sm">
                    {playingElsewhere === 'vlc'
                      ? 'The selected stream is playing externally in VLC.'
                      : 'The video is playing in a separate always-on-top window that you can move and resize.'}
                  </div>
                  {currentChannel && (
                    <button onClick={() => playChannel(currentChannel)} className="btn-secondary mx-auto mt-4">
                      <Play size={15} /> Play here
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <VideoSurface
                ref={videoSurfaceRef}
                src={currentUrl}
                format={currentFormat}
                title={currentChannel?.name}
                autoRestart={settings.autoRestart}
                onStatus={onStatus}
                onUnsupported={() => handleEmbeddedFailure(true)}
                onFailed={streamMode === 'direct' ? () => handleEmbeddedFailure(false) : undefined}
              />
            )}
          </div>

          <div className="mt-3 rounded-3xl border border-white/10 bg-black/20 p-3 light:border-slate-200 light:bg-slate-50">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-black">TV Guide / EPG</h3>
                <p className="text-xs text-slate-500">{settings.epgUrl?.trim() ? `Programmes are matched by tvg-id or channel name. Time mode: ${settings.epgTimezoneMode || 'auto'}${(settings.epgTimezoneMode || 'auto') === 'manual' ? ` (${settings.epgTimeOffsetMinutes || 0} min)` : ''}.` : 'Set an XMLTV EPG URL in Settings.'}</p>
              </div>
              {epgLoading && <RefreshCw size={16} className="animate-spin text-cyan-300" />}
            </div>
            <div ref={epgScrollRef} className="relative max-h-40 overflow-auto pr-1">
              {!settings.epgUrl?.trim() ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-3 text-xs text-slate-500 light:border-slate-200">No EPG source configured.</div>
              ) : epgPrograms.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-3 text-xs text-slate-500 light:border-slate-200">No programme data matched this channel yet.</div>
              ) : (
                <div className="space-y-2">
                  {epgPrograms.map((program, index) => (
                    <div
                      key={`${program.channelId}-${program.start}-${index}`}
                      ref={program.isNow ? nowPlayingRef : undefined}
                      className={`rounded-2xl border p-3 text-sm transition-all ${
                        program.isNow
                          ? 'border-cyan-400 bg-cyan-400/15 shadow-[0_0_12px_rgba(34,211,238,0.25)] ring-1 ring-cyan-400/30'
                          : 'border-white/10 bg-white/[0.03] light:border-slate-200 light:bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {program.isNow && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-cyan-400 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-950">
                                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-slate-950" />
                                Live
                              </span>
                            )}
                            <span className={`truncate font-black ${program.isNow ? 'text-cyan-50 light:text-cyan-900' : ''}`}>{program.title}</span>
                          </div>
                          {program.subtitle && <div className={`truncate text-xs ${program.isNow ? 'text-cyan-200/70 light:text-cyan-700' : 'text-slate-400 light:text-slate-500'}`}>{program.subtitle}</div>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {currentChannel && !program.isNow && isCatchupAvailable(currentChannel.catchupDays, Date.parse(program.start) / 1000) && (
                            <button
                              onClick={() => playCatchup(
                                currentChannel,
                                program.title,
                                Math.floor(Date.parse(program.start) / 1000),
                                Math.floor(Date.parse(program.stop || program.start) / 1000) || Math.floor(Date.parse(program.start) / 1000) + 1800,
                              )}
                              className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-bold text-emerald-300 hover:bg-emerald-400/20 light:text-emerald-700"
                              title="Replay from the TV archive"
                            >
                              <History size={12} /> Replay
                            </button>
                          )}
                          <div className={`text-xs font-bold ${program.isNow ? 'text-cyan-300 light:text-cyan-700' : 'text-slate-400 light:text-slate-600'}`}>
                            {program.startLabel}{program.stopLabel ? ` - ${program.stopLabel}` : ''}
                          </div>
                        </div>
                      </div>
                      {program.description && <div className={`mt-1 line-clamp-2 text-xs ${program.isNow ? 'text-cyan-100/60 light:text-cyan-800/70' : 'text-slate-500'}`}>{program.description}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
