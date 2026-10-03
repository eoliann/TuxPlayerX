import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Clapperboard, ExternalLink, Film, Play, RefreshCw, Search, Star, Tv, X } from 'lucide-react';
import { SeriesEpisode, SeriesInfo, Subscription, VodCategory, VodDetails, VodItem, VodKind, VodPlayRequest } from '../lib/types';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { VideoSurface } from './VideoSurface';

interface VodViewProps {
  reloadToken: number;
  /** Called when a movie or episode starts, so the live player can release its stream. */
  onPlaybackStart: () => void;
  onStatus: (status: string) => void;
}

interface NowPlaying {
  title: string;
  url: string;
  key: string;
}

const CARD_WIDTH = 150;
const CARD_HEIGHT = 270;
const CARD_GAP = 14;
const PROGRESS_KEY = 'tuxplayerx.vodProgress';

type ProgressMap = Record<string, { time: number; duration: number; updatedAt: number }>;

function loadProgress(): ProgressMap {
  try {
    return JSON.parse(window.localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveProgress(key: string, time: number, duration: number) {
  try {
    const all = loadProgress();
    // Finished (or barely started) items do not need a resume point.
    if (time < 30 || time > duration * 0.95) delete all[key];
    else all[key] = { time, duration, updatedAt: Date.now() };
    // Keep the 200 most recent entries.
    const trimmed = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 200));
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(trimmed));
  } catch {
    // Resume points are a convenience only.
  }
}

const formatClock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export function VodView({ reloadToken, onPlaybackStart, onStatus }: VodViewProps) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subId, setSubId] = useState<number | ''>('');
  const [kind, setKind] = useState<VodKind>('movie');
  const [categories, setCategories] = useState<VodCategory[]>([]);
  const [categoryId, setCategoryId] = useState('*');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [items, setItems] = useState<VodItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [selected, setSelected] = useState<VodItem | null>(null);
  const [details, setDetails] = useState<VodDetails | null>(null);
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [seasonIndex, setSeasonIndex] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [error, setError] = useState('');
  const requestSeq = useRef(0);

  useEffect(() => {
    api.listSubscriptions()
      .then((list) => {
        setSubscriptions(list);
        setSubId((current) => (current && list.some((s) => s.id === current) ? current : (list.find((s) => s.isDefault) || list[0])?.id ?? ''));
      })
      .catch((err) => onStatus(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  // Categories for the selected subscription and kind.
  useEffect(() => {
    if (!subId) return;
    const seq = ++requestSeq.current;
    setCategories([]);
    setCategoryId('*');
    setItems([]);
    setError('');
    api.vodCategories(Number(subId), kind)
      .then((list) => seq === requestSeq.current && setCategories(list))
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setError(String(err));
        setCategories([]);
      });
  }, [subId, kind]);

  const loadItems = async (pageNumber: number, force = false) => {
    if (!subId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.vodItems(Number(subId), kind, categoryId, pageNumber, force);
      if (seq !== requestSeq.current) return;
      setItems((prev) => (pageNumber === 1 ? result.items : [...prev, ...result.items]));
      setHasMore(result.hasMore);
      setPage(pageNumber);
      onStatus(`Loaded ${pageNumber === 1 ? result.items.length : 'more'} ${kind === 'movie' ? 'movies' : 'series'}.`);
    } catch (err) {
      if (seq === requestSeq.current) setError(String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (subId && categories.length > 0) loadItems(1).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, categories]);

  const filteredItems = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;
  }, [items, deferredSearch]);

  const filteredCategories = useMemo(() => {
    const q = categoryFilter.trim().toLowerCase();
    return q ? categories.filter((c) => c.name.toLowerCase().includes(q)) : categories;
  }, [categories, categoryFilter]);

  const openItem = (item: VodItem) => {
    setSelected(item);
    setDetails(null);
    setSeries(null);
    setSeasonIndex(0);
    if (!subId) return;
    if (item.kind === 'series') {
      api.seriesInfo(Number(subId), item).then(setSeries).catch((err) => onStatus(`Could not load episodes: ${String(err)}`));
    } else {
      api.vodDetails(Number(subId), item).then(setDetails).catch(() => setDetails({}));
    }
  };

  const play = async (title: string, request: VodPlayRequest) => {
    if (!subId) return;
    try {
      const url = await api.resolveVodStream(Number(subId), request);
      onPlaybackStart();
      setNowPlaying({ title, url, key: `${subId}|${request.kind}|${request.id}|${request.episodeNumber ?? ''}` });
      onStatus(`Playing ${title}.`);
    } catch (err) {
      onStatus(`Could not start playback: ${String(err)}`);
    }
  };

  const playMovie = (item: VodItem) => play(item.name, { kind: 'movie', id: item.id, extension: item.extension, cmd: item.cmd });
  const playEpisode = (episode: SeriesEpisode) =>
    play(`${selected?.name ?? ''} · ${episode.title}`, {
      kind: 'episode',
      id: episode.id,
      extension: episode.extension,
      cmd: episode.cmd,
      episodeNumber: episode.cmd ? episode.number : null,
    });

  const progress = useMemo(loadProgress, [nowPlaying, selected]);
  const season = series?.seasons[seasonIndex];

  return (
    <div className="grid h-[calc(100vh-112px)] min-h-[620px] grid-cols-[280px_minmax(0,1fr)] gap-5">
      <section className="flex min-h-0 flex-col rounded-[1.75rem] border border-white/10 bg-white/[0.04] p-3 light:border-slate-200 light:bg-white">
        <div className="mb-3">
          <h2 className="text-lg font-black">Movies &amp; Series</h2>
          <p className="text-xs text-slate-500">Xtream subscriptions and MAC portals.</p>
        </div>
        <select
          className="mb-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm outline-none light:border-slate-200 light:bg-white"
          value={subId}
          onChange={(event) => setSubId(event.target.value ? Number(event.target.value) : '')}
        >
          <option value="">Select subscription</option>
          {subscriptions.map((sub) => (
            <option key={sub.id} value={sub.id}>{sub.name} ({sub.type.toUpperCase()})</option>
          ))}
        </select>
        <div className="mb-2 grid grid-cols-2 gap-2">
          {(['movie', 'series'] as VodKind[]).map((value) => (
            <button
              key={value}
              onClick={() => setKind(value)}
              className={cn('flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-black', kind === value ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-100')}
            >
              {value === 'movie' ? <Film size={15} /> : <Tv size={15} />} {value === 'movie' ? 'Movies' : 'Series'}
            </button>
          ))}
        </div>
        <input value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} placeholder="Filter categories..." className="mb-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none light:border-slate-200 light:bg-white" />
        <div className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {filteredCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => setCategoryId(category.id)}
              className={cn(
                'w-full truncate rounded-xl px-3 py-2 text-left text-sm',
                categoryId === category.id ? 'bg-cyan-400/15 font-bold text-cyan-200 light:text-cyan-800' : 'hover:bg-white/5 light:hover:bg-slate-100',
              )}
            >
              {category.name}
            </button>
          ))}
          {!error && categories.length === 0 && subId && <div className="p-3 text-xs text-slate-500">Loading categories...</div>}
        </div>
      </section>

      <section className="relative flex min-h-0 flex-col rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 light:border-slate-200 light:bg-white">
        <div className="mb-3 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 text-slate-500" size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${kind === 'movie' ? 'movies' : 'series'}...`}
              className="w-full rounded-xl border border-white/10 bg-slate-900 py-2.5 pl-10 pr-3 text-sm outline-none light:border-slate-200 light:bg-white"
            />
          </div>
          <span className="shrink-0 text-xs text-slate-500">{filteredItems.length} titles</span>
          <button onClick={() => loadItems(1, true)} className="rounded-xl border border-white/10 p-2 hover:bg-white/10 light:border-slate-200" title="Reload from provider">
            <RefreshCw size={18} className={cn(loading && 'animate-spin')} />
          </button>
        </div>

        {error ? (
          <div className="grid flex-1 place-items-center text-center text-sm text-slate-400">
            <div className="max-w-md">
              <Clapperboard className="mx-auto mb-3 text-slate-600" size={36} />
              {error}
            </div>
          </div>
        ) : (
          <PosterGrid
            items={filteredItems}
            progress={progress}
            subId={subId}
            resetKey={`${subId}|${kind}|${categoryId}|${deferredSearch}`}
            onOpen={openItem}
            footer={hasMore && !deferredSearch ? (
              <button onClick={() => loadItems(page + 1)} disabled={loading} className="btn-secondary mx-auto my-4">
                {loading ? 'Loading...' : 'Load more'}
              </button>
            ) : null}
            empty={loading ? 'Loading...' : 'No titles in this category.'}
          />
        )}

        {selected && !nowPlaying && (
          <div className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-[2rem] bg-slate-950/[0.97] p-5 backdrop-blur light:bg-white/[0.98]">
            <button onClick={() => setSelected(null)} className="mb-4 flex w-fit items-center gap-2 text-sm font-bold text-slate-400 hover:text-white light:hover:text-slate-900">
              <ArrowLeft size={16} /> Back
            </button>
            <div className="flex min-h-0 flex-1 gap-6">
              <div className="w-56 shrink-0">
                <Poster src={series?.poster || selected.poster} name={selected.name} className="aspect-[2/3] w-full rounded-2xl" />
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <h2 className="text-2xl font-black">{selected.name}</h2>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-400">
                  {(details?.releaseDate || selected.year) && <span>{details?.releaseDate || selected.year}</span>}
                  {details?.duration && <span>{details.duration}</span>}
                  {(details?.rating || selected.rating) && <span className="flex items-center gap-1"><Star size={12} className="text-amber-300" /> {details?.rating || selected.rating}</span>}
                  {details?.genre && <span>{details.genre}</span>}
                </div>
                {(details?.plot || series?.plot || selected.plot) && (
                  <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300 light:text-slate-700">{details?.plot || series?.plot || selected.plot}</p>
                )}
                {details?.director && <p className="mt-2 text-xs text-slate-500">Director: {details.director}</p>}
                {details?.cast && <p className="mt-1 line-clamp-2 text-xs text-slate-500">Cast: {details.cast}</p>}

                {selected.kind === 'movie' ? (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <button onClick={() => playMovie(selected)} className="flex items-center gap-2 rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300">
                      <Play size={16} fill="currentColor" />
                      {progress[`${subId}|movie|${selected.id}|`] ? `Resume from ${formatClock(progress[`${subId}|movie|${selected.id}|`].time)}` : 'Play'}
                    </button>
                  </div>
                ) : !series ? (
                  <div className="mt-5 text-sm text-slate-500">Loading episodes...</div>
                ) : (
                  <div className="mt-5 flex min-h-0 flex-1 flex-col">
                    <div className="mb-3 flex flex-wrap gap-2">
                      {series.seasons.map((s, index) => (
                        <button key={s.number} onClick={() => setSeasonIndex(index)} className={cn('rounded-xl px-3 py-1.5 text-xs font-bold', index === seasonIndex ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-100')}>
                          {s.name}
                        </button>
                      ))}
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                      {season?.episodes.map((episode) => {
                        const saved = progress[`${subId}|episode|${episode.id}|${episode.cmd ? episode.number : ''}`];
                        return (
                          <button key={episode.id} onClick={() => playEpisode(episode)} className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-left hover:bg-white/[0.07] light:border-slate-200 light:bg-slate-50">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-400/15 text-xs font-black text-cyan-300 light:text-cyan-700">{episode.number || '•'}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold">{episode.title}</span>
                              {episode.plot && <span className="block truncate text-xs text-slate-500">{episode.plot}</span>}
                              {saved && <span className="mt-1 block h-1 overflow-hidden rounded bg-white/10"><span className="block h-full bg-cyan-400" style={{ width: `${(saved.time / saved.duration) * 100}%` }} /></span>}
                            </span>
                            {episode.duration && <span className="shrink-0 text-xs text-slate-500">{episode.duration}</span>}
                            <Play size={16} className="shrink-0 text-cyan-300" />
                          </button>
                        );
                      })}
                      {season?.episodes.length === 0 && <div className="text-sm text-slate-500">No episodes in this season.</div>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {nowPlaying && (
          <div className="absolute inset-0 z-20 flex flex-col rounded-[2rem] bg-slate-950 p-4 light:bg-white">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="truncate text-lg font-black">{nowPlaying.title}</h2>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => {
                    api.openExternalPlayer(nowPlaying.url).catch((err) => onStatus(String(err)));
                    setNowPlaying(null);
                    onStatus('Opened in VLC.');
                  }}
                  className="btn-secondary"
                >
                  <ExternalLink size={15} /> Open in VLC
                </button>
                <button onClick={() => setNowPlaying(null)} className="btn-secondary"><X size={15} /> Close</button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <VideoSurface
                src={nowPlaying.url}
                title={nowPlaying.title}
                autoRestart={false}
                initialTime={loadProgress()[nowPlaying.key]?.time}
                onProgress={(time, duration) => saveProgress(nowPlaying.key, time, duration)}
                onStatus={onStatus}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">If the video does not start, the format may not be supported by the built-in player; use Open in VLC.</p>
          </div>
        )}
      </section>
    </div>
  );
}

interface PosterGridProps {
  items: VodItem[];
  progress: ProgressMap;
  subId: number | '';
  resetKey: string;
  footer: ReactNode;
  empty: string;
  onOpen: (item: VodItem) => void;
}

/** Virtualized poster grid: only the visible rows of cards are rendered. */
function PosterGrid({ items, progress, subId, resetKey, footer, empty, onOpen }: PosterGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const columns = Math.max(1, Math.floor((size.width + CARD_GAP) / (CARD_WIDTH + CARD_GAP)));
  const rows = Math.ceil(items.length / columns);
  const rowHeight = CARD_HEIGHT + CARD_GAP;
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + size.height) / rowHeight) + 2);

  return (
    <div ref={containerRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-auto">
      {items.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500">{empty}</div>
      ) : (
        <>
          <div className="relative" style={{ height: rows * rowHeight }}>
            {Array.from({ length: lastRow - firstRow }, (_, r) => firstRow + r).flatMap((row) =>
              items.slice(row * columns, row * columns + columns).map((item, col) => {
                const saved = item.kind === 'movie' ? progress[`${subId}|movie|${item.id}|`] : undefined;
                return (
                  <button
                    key={`${item.kind}-${item.id}`}
                    onClick={() => onOpen(item)}
                    className="group absolute text-left"
                    style={{ top: row * rowHeight, left: col * (CARD_WIDTH + CARD_GAP), width: CARD_WIDTH, height: CARD_HEIGHT }}
                  >
                    <div className="relative">
                      <Poster src={item.poster} name={item.name} className="h-[225px] w-full rounded-xl transition-transform group-hover:scale-[1.03]" />
                      {item.rating && (
                        <span className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                          <Star size={9} fill="currentColor" /> {item.rating}
                        </span>
                      )}
                      {saved && (
                        <span className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded bg-black/60">
                          <span className="block h-full bg-cyan-400" style={{ width: `${(saved.time / saved.duration) * 100}%` }} />
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 line-clamp-2 text-xs font-bold leading-tight">{item.name}</div>
                    {item.year && <div className="text-[11px] text-slate-500">{item.year}</div>}
                  </button>
                );
              }),
            )}
          </div>
          {footer && <div className="flex justify-center">{footer}</div>}
        </>
      )}
    </div>
  );
}

function Poster({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className={cn('grid place-items-center bg-gradient-to-br from-slate-800 to-slate-900 p-3 text-center text-xs font-black text-slate-400 light:from-slate-200 light:to-slate-300', className)}>
        {name}
      </div>
    );
  }
  return <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cn('bg-slate-800 object-cover', className)} />;
}
