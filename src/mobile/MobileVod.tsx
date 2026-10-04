import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, Clapperboard, Film, Play, RefreshCw, Search, Star, Tv } from 'lucide-react';
import { SeriesEpisode, SeriesInfo, Subscription, VodCategory, VodDetails, VodItem, VodKind, VodPlayRequest } from '../core/types';
import { api } from '../core/api';
import { cn } from '../core/utils';
import { formatClock, loadProgress, progressKey } from '../core/vodProgress';
import { useBackHandler } from './useBackHandler';
import { safePadding } from './safeArea';
import { MobileVodPlayer, type VodPlayback } from './MobileVodPlayer';

interface Props {
  reloadToken: number;
  onStatus: (status: string) => void;
}

const ALL_CATEGORIES = '*';
const CARD_MIN_WIDTH = 112;
const CARD_GAP = 10;
/** Text under each poster (title + year). */
const CARD_TEXT_HEIGHT = 44;
const OVERSCAN_ROWS = 2;

/** Movies and series for Xtream subscriptions and MAC portals: categories, poster grid, details and playback. */
export function MobileVod({ reloadToken, onStatus }: Props) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionId, setSubscriptionId] = useState<number | null>(null);
  const [kind, setKind] = useState<VodKind>('movie');
  const [categories, setCategories] = useState<VodCategory[]>([]);
  const [categoryId, setCategoryId] = useState(ALL_CATEGORIES);
  const [items, setItems] = useState<VodItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [selected, setSelected] = useState<VodItem | null>(null);
  const [playback, setPlayback] = useState<VodPlayback | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    api.listSubscriptions()
      .then((list) => {
        setSubscriptions(list);
        setSubscriptionId((current) => (current && list.some((sub) => sub.id === current) ? current : (list.find((sub) => sub.isDefault) ?? list[0])?.id ?? null));
      })
      .catch((err) => onStatus(String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  useEffect(() => {
    if (subscriptionId == null) return;
    const seq = ++requestSeq.current;
    setCategories([]);
    setCategoryId(ALL_CATEGORIES);
    setItems([]);
    setError('');
    api.vodCategories(subscriptionId, kind)
      .then((list) => seq === requestSeq.current && setCategories(list))
      .catch((err) => seq === requestSeq.current && setError(String(err)));
  }, [subscriptionId, kind]);

  const loadItems = async (pageNumber: number, force = false) => {
    if (subscriptionId == null) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.vodItems(subscriptionId, kind, categoryId, pageNumber, force);
      if (seq !== requestSeq.current) return;
      setItems((prev) => (pageNumber === 1 ? result.items : [...prev, ...result.items]));
      setHasMore(result.hasMore);
      setPage(pageNumber);
    } catch (err) {
      if (seq === requestSeq.current) setError(String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (subscriptionId != null && categories.length > 0) loadItems(1).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, categories]);

  const filtered = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return query ? items.filter((item) => item.name.toLowerCase().includes(query)) : items;
  }, [items, deferredSearch]);

  const play = async (title: string, request: VodPlayRequest) => {
    if (subscriptionId == null) return;
    try {
      const url = await api.resolveVodStream(subscriptionId, request);
      const direct = await api.prepareDirectStream(url);
      setPlayback({
        title,
        url: direct.url,
        format: direct.format,
        key: progressKey(subscriptionId, request.kind, request.id, request.episodeNumber),
      });
    } catch (err) {
      onStatus(`Could not start playback: ${String(err)}`);
    }
  };

  if (subscriptions.length === 0) {
    return <div className="p-8 text-center text-sm text-slate-400">Add a subscription to browse movies and series.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-white/10 p-3 light:border-slate-200">
        <div className="flex gap-2">
          <select value={subscriptionId ?? ''} onChange={(e) => setSubscriptionId(Number(e.target.value))} className="field min-w-0 flex-1" aria-label="Subscription">
            {subscriptions.map((sub) => (
              <option key={sub.id} value={sub.id}>{sub.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => loadItems(1, true)} className="btn-secondary shrink-0 px-3" aria-label="Reload from provider">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['movie', 'series'] as VodKind[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setKind(value)}
              className={cn('flex items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-sm font-black', kind === value ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-200')}
            >
              {value === 'movie' ? <Film size={16} /> : <Tv size={16} />} {value === 'movie' ? 'Movies' : 'Series'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="w-2/5 shrink-0">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="field" aria-label="Category">
              {categories.length === 0 && <option value={ALL_CATEGORIES}>{error ? 'No categories' : 'Loading...'}</option>}
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="field" style={{ paddingLeft: '2.25rem' }} placeholder={kind === 'movie' ? 'Search movies' : 'Search series'} />
          </div>
        </div>
      </div>

      {error ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-slate-400">
          <div>
            <Clapperboard className="mx-auto mb-3 text-slate-600" size={36} />
            {error}
          </div>
        </div>
      ) : (
        <PosterGrid
          subscriptionId={subscriptionId ?? 0}
          items={filtered}
          resetKey={`${subscriptionId}|${kind}|${categoryId}|${deferredSearch}`}
          loading={loading}
          onOpen={setSelected}
          onNearEnd={() => {
            if (hasMore && !loading && !deferredSearch) loadItems(page + 1).catch(() => undefined);
          }}
        />
      )}

      {selected && subscriptionId != null && (
        <VodDetailsSheet
          subscriptionId={subscriptionId}
          item={selected}
          onClose={() => setSelected(null)}
          onPlay={play}
          playbackKey={playback?.key}
        />
      )}

      {playback && <MobileVodPlayer playback={playback} onClose={() => setPlayback(null)} onStatus={onStatus} />}
    </div>
  );
}

interface PosterGridProps {
  subscriptionId: number;
  items: VodItem[];
  resetKey: string;
  loading: boolean;
  onOpen: (item: VodItem) => void;
  onNearEnd: () => void;
}

/** Poster grid that only renders the rows on screen (providers can list tens of thousands of titles). */
function PosterGrid({ subscriptionId, items, resetKey, loading, onOpen, onNearEnd }: PosterGridProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 360, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const innerWidth = Math.max(0, size.width - 16);
  const columns = Math.max(2, Math.floor((innerWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  const cardWidth = (innerWidth - CARD_GAP * (columns - 1)) / columns;
  const rowHeight = cardWidth * 1.5 + CARD_TEXT_HEIGHT + CARD_GAP;
  const rowCount = Math.ceil(items.length / columns);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN_ROWS);

  // Fetch the next page shortly before the end of the list is reached.
  useEffect(() => {
    if (rowCount > 0 && lastRow >= rowCount - 1) onNearEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastRow, rowCount]);

  const progress = useMemo(loadProgress, [items]);
  const visible = items.slice(firstRow * columns, lastRow * columns);

  return (
    <div ref={ref} data-nav-group onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto px-2 pt-2">
      {items.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-400">{loading ? 'Loading...' : 'No titles in this category.'}</div>
      ) : (
        <div className="relative" style={{ height: rowCount * rowHeight }}>
          {visible.map((item, index) => {
            const position = firstRow * columns + index;
            const row = Math.floor(position / columns);
            const column = position % columns;
            const saved = item.kind === 'movie' ? progress[progressKey(subscriptionId, 'movie', item.id)] : undefined;
            return (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                onClick={() => onOpen(item)}
                className="absolute rounded-2xl p-0 text-left"
                style={{ top: row * rowHeight, left: column * (cardWidth + CARD_GAP), width: cardWidth }}
              >
                <Poster src={item.poster} name={item.name} className="w-full rounded-2xl" style={{ height: cardWidth * 1.5 }} />
                {saved && (
                  <span className="mt-1 block h-1 overflow-hidden rounded bg-white/10">
                    <span className="block h-full bg-cyan-400" style={{ width: `${(saved.time / saved.duration) * 100}%` }} />
                  </span>
                )}
                <span className="mt-1 block truncate text-xs font-bold">{item.name}</span>
                <span className="block truncate text-[11px] text-slate-400">{[item.year, item.rating && `★ ${item.rating}`].filter(Boolean).join(' · ')}</span>
              </button>
            );
          })}
        </div>
      )}
      {loading && items.length > 0 && <div className="py-4 text-center text-xs text-slate-400">Loading more...</div>}
    </div>
  );
}

interface DetailsProps {
  subscriptionId: number;
  item: VodItem;
  playbackKey?: string;
  onClose: () => void;
  onPlay: (title: string, request: VodPlayRequest) => void;
}

function VodDetailsSheet({ subscriptionId, item, playbackKey, onClose, onPlay }: DetailsProps) {
  const [details, setDetails] = useState<VodDetails | null>(null);
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [seasonIndex, setSeasonIndex] = useState(0);
  const [failed, setFailed] = useState('');
  const playRef = useRef<HTMLButtonElement | null>(null);

  useBackHandler(true, onClose);

  useEffect(() => {
    if (item.kind === 'series') {
      api.seriesInfo(subscriptionId, item).then(setSeries).catch((err) => setFailed(`Could not load episodes: ${String(err)}`));
    } else {
      api.vodDetails(subscriptionId, item).then(setDetails).catch(() => setDetails({}));
    }
    window.setTimeout(() => playRef.current?.focus(), 50);
  }, [subscriptionId, item]);

  // Re-read resume points after the player closes.
  const progress = useMemo(loadProgress, [playbackKey, item]);
  const movieSaved = progress[progressKey(subscriptionId, 'movie', item.id)];
  const season = series?.seasons[seasonIndex];

  const playEpisode = (episode: SeriesEpisode) =>
    onPlay(`${item.name} · ${episode.title}`, {
      kind: 'episode',
      id: episode.id,
      extension: episode.extension,
      cmd: episode.cmd,
      episodeNumber: episode.cmd ? episode.number : null,
    });

  return (
    <div data-nav-scope className="fixed inset-0 z-40 overflow-y-auto bg-slate-950 light:bg-slate-100" style={safePadding('1rem')}>
      <button type="button" onClick={onClose} className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-400">
        <ArrowLeft size={18} /> Back
      </button>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Poster src={series?.poster || item.poster} name={item.name} className="mx-auto aspect-[2/3] w-40 shrink-0 rounded-2xl sm:mx-0 sm:w-52" />
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-black">{item.name}</h2>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-400">
            {(details?.releaseDate || item.year) && <span>{details?.releaseDate || item.year}</span>}
            {details?.duration && <span>{details.duration}</span>}
            {(details?.rating || item.rating) && (
              <span className="flex items-center gap-1"><Star size={12} className="text-amber-300" /> {details?.rating || item.rating}</span>
            )}
            {details?.genre && <span>{details.genre}</span>}
          </div>
          {(details?.plot || series?.plot || item.plot) && <p className="mt-3 text-sm leading-relaxed text-slate-300 light:text-slate-700">{details?.plot || series?.plot || item.plot}</p>}
          {details?.director && <p className="mt-2 text-xs text-slate-500">Director: {details.director}</p>}
          {details?.cast && <p className="mt-1 line-clamp-2 text-xs text-slate-500">Cast: {details.cast}</p>}

          {item.kind === 'movie' && (
            <button
              ref={playRef}
              type="button"
              onClick={() => onPlay(item.name, { kind: 'movie', id: item.id, extension: item.extension, cmd: item.cmd })}
              className="btn-primary mt-4"
            >
              <Play size={18} fill="currentColor" /> {movieSaved ? `Resume from ${formatClock(movieSaved.time)}` : 'Play'}
            </button>
          )}
        </div>
      </div>

      {item.kind === 'series' && (
        <div className="mt-5">
          {failed && <div className="text-sm text-amber-300">{failed}</div>}
          {!series && !failed && <div className="text-sm text-slate-400">Loading episodes...</div>}
          {series && (
            <>
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {series.seasons.map((s, index) => (
                  <button
                    key={s.number}
                    ref={index === 0 ? playRef : undefined}
                    type="button"
                    onClick={() => setSeasonIndex(index)}
                    className={cn('shrink-0 rounded-xl px-3 py-2 text-xs font-bold', index === seasonIndex ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-200')}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                {season?.episodes.map((episode) => {
                  const saved = progress[progressKey(subscriptionId, 'episode', episode.id, episode.cmd ? episode.number : null)];
                  return (
                    <button
                      key={episode.id}
                      type="button"
                      onClick={() => playEpisode(episode)}
                      className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-left light:border-slate-200 light:bg-white"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-cyan-400/15 text-xs font-black text-cyan-300 light:text-cyan-700">{episode.number || '•'}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold">{episode.title}</span>
                        {saved && (
                          <span className="mt-1 block h-1 overflow-hidden rounded bg-white/10">
                            <span className="block h-full bg-cyan-400" style={{ width: `${(saved.time / saved.duration) * 100}%` }} />
                          </span>
                        )}
                      </span>
                      {episode.duration && <span className="shrink-0 text-xs text-slate-500">{episode.duration}</span>}
                      <Play size={16} className="shrink-0 text-cyan-300" />
                    </button>
                  );
                })}
                {season?.episodes.length === 0 && <div className="text-sm text-slate-500">No episodes in this season.</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Poster({ src, name, className, style }: { src?: string | null; name: string; className?: string; style?: CSSProperties }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={cn('grid place-items-center bg-white/5 p-2 text-center text-xs font-bold text-slate-400 light:bg-slate-200', className)} style={style}>
        {name}
      </span>
    );
  }
  return <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className={cn('bg-white/5 object-cover', className)} style={style} />;
}
