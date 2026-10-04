import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Star, Tv } from 'lucide-react';
import { AppSettings, Channel, EpgNow, Subscription } from '../core/types';
import { api } from '../core/api';
import { cn } from '../core/utils';
import { MobilePlayer } from './MobilePlayer';

const ALL = '__all__';
const FAVORITES = '__favorites__';
const RECENT = '__recent__';
/** "Now playing" guide data is fetched only for the first rows of the visible list. */
const EPG_NOW_LIMIT = 150;
const LAST_SUBSCRIPTION_KEY = 'tuxplayerx.mobile.subscription';

interface Props {
  settings: AppSettings;
  reloadToken: number;
  onStatus: (status: string) => void;
  onOpenSubscriptions: () => void;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}

export function LiveTv({ settings, reloadToken, onStatus, onOpenSubscriptions }: Props) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionId, setSubscriptionId] = useState<number | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState(ALL);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [epgNow, setEpgNow] = useState<Record<string, EpgNow>>({});
  const [playing, setPlaying] = useState<Channel | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    api.listSubscriptions()
      .then((list) => {
        setSubscriptions(list);
        const remembered = Number(readStorage(LAST_SUBSCRIPTION_KEY));
        const pick = list.find((sub) => sub.id === remembered) ?? list.find((sub) => sub.isDefault) ?? list[0];
        setSubscriptionId(pick?.id ?? null);
      })
      .catch((error) => onStatus(String(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const loadChannels = async (id: number, force = false) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const [result, favs, recent] = await Promise.all([api.loadChannels(id, force), api.listFavorites(id), api.listRecents(id)]);
      if (seq !== loadSeq.current) return;
      setChannels(result.channels);
      setFavorites(favs);
      setRecents(recent);
      if (force) onStatus(`${result.channels.length} channels loaded.`);
    } catch (error) {
      if (seq === loadSeq.current) onStatus(String(error));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    setChannels([]);
    setFilter(ALL);
    if (subscriptionId == null) return;
    writeStorage(LAST_SUBSCRIPTION_KEY, String(subscriptionId));
    loadChannels(subscriptionId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId]);

  const groups = useMemo(() => {
    const names = new Set<string>();
    for (const channel of channels) names.add(channel.group || 'Uncategorized');
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [channels]);

  const visible = useMemo(() => {
    let list: Channel[];
    if (filter === FAVORITES) {
      const set = new Set(favorites);
      list = channels.filter((channel) => set.has(channel.id));
    } else if (filter === RECENT) {
      const byId = new Map(channels.map((channel) => [channel.id, channel]));
      list = recents.map((id) => byId.get(id)).filter((channel): channel is Channel => Boolean(channel));
    } else if (filter === ALL) {
      list = channels;
    } else {
      list = channels.filter((channel) => (channel.group || 'Uncategorized') === filter);
    }
    const query = deferredSearch.trim().toLowerCase();
    return query ? list.filter((channel) => channel.name.toLowerCase().includes(query)) : list;
  }, [channels, filter, favorites, recents, deferredSearch]);

  // "Now playing" for the first rows of the current list, refreshed every minute.
  useEffect(() => {
    if (!settings.epgUrl?.trim() || visible.length === 0) return;
    const keys = visible.slice(0, EPG_NOW_LIMIT).map((channel) => ({ id: channel.id, name: channel.name, epgId: channel.epgId }));
    let cancelled = false;
    const refresh = () =>
      api.loadEpgNow(keys)
        .then((now) => !cancelled && setEpgNow((prev) => ({ ...prev, ...now })))
        .catch(() => undefined);
    const timer = window.setTimeout(refresh, 300);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [visible, settings.epgUrl]);

  const toggleFavorite = async (channel: Channel) => {
    if (subscriptionId == null) return;
    const isFavorite = await api.toggleFavorite(subscriptionId, channel.id);
    setFavorites((prev) => (isFavorite ? [...prev, channel.id] : prev.filter((id) => id !== channel.id)));
  };

  const onPlayed = (channel: Channel) => {
    setRecents((prev) => [channel.id, ...prev.filter((id) => id !== channel.id)].slice(0, 30));
  };

  if (subscriptions.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <Tv className="mx-auto mb-4 text-slate-500" size={48} />
          <div className="text-lg font-black">No subscriptions yet</div>
          <p className="mt-2 text-sm text-slate-400">Add an M3U playlist or a MAC portal to start watching.</p>
          <button type="button" onClick={onOpenSubscriptions} className="btn-primary mx-auto mt-5">Add subscription</button>
        </div>
      </div>
    );
  }

  const favoriteSet = new Set(favorites);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-white/10 p-3 light:border-slate-200">
        <div className="flex gap-2">
          <select
            value={subscriptionId ?? ''}
            onChange={(e) => setSubscriptionId(Number(e.target.value))}
            className="field min-w-0 flex-1"
            aria-label="Subscription"
          >
            {subscriptions.map((sub) => (
              <option key={sub.id} value={sub.id}>{sub.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => subscriptionId != null && loadChannels(subscriptionId, true)}
            className="btn-secondary shrink-0 px-3"
            aria-label="Reload channels"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex gap-2">
          <div className="w-2/5 shrink-0">
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="field" aria-label="Group">
              <option value={ALL}>All channels</option>
              <option value={FAVORITES}>★ Favorites</option>
              <option value={RECENT}>Recently watched</option>
              {groups.map((group) => (
                <option key={group} value={group}>{group}</option>
              ))}
            </select>
          </div>
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="field" style={{ paddingLeft: '2.25rem' }} placeholder="Search channels" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">{loading ? 'Loading channels...' : 'No channels here.'}</div>
        ) : (
          <ul className="grid gap-1 lg:grid-cols-2">
            {visible.map((channel) => {
              const now = epgNow[channel.id];
              return (
                <li key={channel.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 64px' }}>
                  <div className="flex items-center gap-1 rounded-2xl hover:bg-white/5 light:hover:bg-slate-200/60">
                    <button type="button" onClick={() => setPlaying(channel)} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-2 text-left">
                      <ChannelLogo src={channel.logo} name={channel.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">{channel.name}</span>
                        <span className="block truncate text-xs text-slate-400">{now ? `${now.startLabel} ${now.title}` : channel.group || ''}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(channel)}
                      className={cn('shrink-0 rounded-xl p-3', favoriteSet.has(channel.id) ? 'text-amber-300' : 'text-slate-500')}
                      aria-label={favoriteSet.has(channel.id) ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      <Star size={18} fill={favoriteSet.has(channel.id) ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {playing && subscriptionId != null && (
        <MobilePlayer
          subscriptionId={subscriptionId}
          channel={playing}
          channels={visible}
          settings={settings}
          isFavorite={favoriteSet.has(playing.id)}
          onToggleFavorite={() => toggleFavorite(playing)}
          onChannelChange={setPlaying}
          onPlayed={onPlayed}
          onClose={() => setPlaying(null)}
          onStatus={onStatus}
        />
      )}
    </div>
  );
}

export function ChannelLogo({ src, name }: { src?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/10 text-sm font-black text-slate-300 light:bg-slate-200 light:text-slate-600">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-11 w-11 shrink-0 rounded-xl bg-white/5 object-contain p-1"
    />
  );
}
