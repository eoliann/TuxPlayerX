import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, History, Play, RefreshCw, X } from 'lucide-react';
import { Channel, EpgGridItem } from '../lib/types';
import { api } from '../lib/api';
import { cn, isCatchupAvailable } from '../lib/utils';

const ROW_HEIGHT = 52;
const HEADER_HEIGHT = 36;
const CHANNEL_COLUMN = 190;
const PX_PER_MINUTE = 4;
const WINDOW_HOURS = 12;
const SHIFT_HOURS = 3;
const OVERSCAN = 6;

interface EpgGridProps {
  channels: Channel[];
  currentChannelId?: string | null;
  /** Changes when the EPG source or time settings change, so cached cells are reloaded. */
  epgKey: string;
  onPlayChannel: (channel: Channel) => void;
  onPlayCatchup: (channel: Channel, item: EpgGridItem) => void;
  onClose: () => void;
}

interface Selection {
  channel: Channel;
  item: EpgGridItem;
}

function windowStartFor(date: Date): number {
  // Start half an hour before "now", aligned to the half hour, so the current programmes are visible.
  const seconds = Math.floor(date.getTime() / 1000);
  return Math.floor(seconds / 1800) * 1800 - 1800;
}

const timeLabel = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (seconds: number) => new Date(seconds * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

export function EpgGrid({ channels, currentChannelId, epgKey, onPlayChannel, onPlayCatchup, onClose }: EpgGridProps) {
  const [from, setFrom] = useState(() => windowStartFor(new Date()));
  const to = from + WINDOW_HOURS * 3600;
  const [cells, setCells] = useState<Record<string, EpgGridItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestedRef = useRef<Set<string>>(new Set());

  const timelineWidth = WINDOW_HOURS * 60 * PX_PER_MINUTE;
  const xFor = (seconds: number) => ((seconds - from) / 60) * PX_PER_MINUTE;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // A new time window or EPG source invalidates everything that was loaded.
  useEffect(() => {
    setCells({});
    requestedRef.current = new Set();
  }, [from, epgKey]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setScroll((prev) => ({ ...prev, height: el.clientHeight })));
    observer.observe(el);
    setScroll({ top: el.scrollTop, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Scroll to "now" and to the playing channel when the guide opens or the window moves.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, xFor(Date.now() / 1000) - 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);
  useEffect(() => {
    const el = containerRef.current;
    const index = channels.findIndex((ch) => ch.id === currentChannelId);
    if (el && index > 0) el.scrollTop = Math.max(0, index * ROW_HEIGHT - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstRow = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(channels.length, Math.ceil((scroll.top + scroll.height) / ROW_HEIGHT) + OVERSCAN);
  const visibleChannels = useMemo(() => channels.slice(firstRow, lastRow), [channels, firstRow, lastRow]);

  // Load programmes only for the rows on screen (debounced while scrolling).
  useEffect(() => {
    const missing = visibleChannels.filter((ch) => !requestedRef.current.has(ch.id));
    if (missing.length === 0) return;
    const timer = window.setTimeout(() => {
      missing.forEach((ch) => requestedRef.current.add(ch.id));
      setLoading(true);
      api.loadEpgGrid(missing.map((ch) => ({ id: ch.id, name: ch.name, epgId: ch.epgId })), from, to)
        .then((result) => setCells((prev) => ({ ...prev, ...result })))
        .catch(() => missing.forEach((ch) => requestedRef.current.delete(ch.id)))
        .finally(() => setLoading(false));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [visibleChannels, from, to, epgKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const activate = (channel: Channel, item: EpgGridItem) => {
    if (item.start <= now && now < item.stop) {
      onPlayChannel(channel);
    } else if (isCatchupAvailable(channel.catchupDays, item.start, now)) {
      onPlayCatchup(channel, item);
    } else {
      setSelection({ channel, item });
    }
  };

  const hours = Array.from({ length: WINDOW_HOURS * 2 }, (_, i) => from + i * 1800);
  const nowX = xFor(now);
  const selected = selection?.item;

  return (
    <div className="absolute inset-0 z-20 flex flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/[0.97] p-4 shadow-2xl backdrop-blur light:border-slate-200 light:bg-white/[0.98]">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black">TV Guide</h2>
          <p className="text-xs text-slate-500">
            {dayLabel(from)} {timeLabel(from)} – {timeLabel(to)} · Click a programme on air to watch it
            {channels.some((ch) => ch.catchupDays) ? ', or a past one marked with the archive icon to replay it.' : '.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading && <RefreshCw size={16} className="animate-spin text-cyan-300" />}
          <button onClick={() => setFrom((value) => value - SHIFT_HOURS * 3600)} className="btn-secondary" title="Earlier"><ChevronLeft size={15} /> {SHIFT_HOURS}h</button>
          <button onClick={() => setFrom(windowStartFor(new Date()))} className="btn-secondary">Now</button>
          <button onClick={() => setFrom((value) => value + SHIFT_HOURS * 3600)} className="btn-secondary" title="Later">{SHIFT_HOURS}h <ChevronRight size={15} /></button>
          <button onClick={onClose} className="rounded-xl border border-white/10 p-2 hover:bg-white/10 light:border-slate-200" title="Close guide (Esc)"><X size={18} /></button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
        className="relative min-h-0 flex-1 overflow-auto rounded-2xl border border-white/10 light:border-slate-200"
      >
        <div style={{ width: CHANNEL_COLUMN + timelineWidth, height: HEADER_HEIGHT + channels.length * ROW_HEIGHT }} className="relative">
          {/* Time header */}
          <div className="sticky top-0 z-20 flex" style={{ height: HEADER_HEIGHT, width: CHANNEL_COLUMN + timelineWidth }}>
            <div className="sticky left-0 z-30 shrink-0 border-b border-r border-white/10 bg-slate-950 light:border-slate-200 light:bg-white" style={{ width: CHANNEL_COLUMN }} />
            <div className="relative border-b border-white/10 bg-slate-950 light:border-slate-200 light:bg-white" style={{ width: timelineWidth }}>
              {hours.map((t) => (
                <div key={t} className="absolute top-0 h-full border-l border-white/10 pl-2 pt-2 text-[11px] font-bold text-slate-400 light:border-slate-200" style={{ left: xFor(t) }}>
                  {timeLabel(t)}
                </div>
              ))}
            </div>
          </div>

          {/* Now marker */}
          {nowX >= 0 && nowX <= timelineWidth && (
            <div className="pointer-events-none absolute z-10 w-0.5 bg-red-500/80" style={{ left: CHANNEL_COLUMN + nowX, top: HEADER_HEIGHT, bottom: 0 }} />
          )}

          {visibleChannels.map((channel, offset) => {
            const row = firstRow + offset;
            const items = cells[channel.id] || [];
            return (
              <div key={channel.id} className="absolute left-0 flex" style={{ top: HEADER_HEIGHT + row * ROW_HEIGHT, height: ROW_HEIGHT, width: CHANNEL_COLUMN + timelineWidth }}>
                <button
                  onClick={() => onPlayChannel(channel)}
                  className={cn(
                    'sticky left-0 z-10 flex shrink-0 items-center gap-2 border-b border-r border-white/10 bg-slate-950 px-3 text-left text-xs font-bold hover:bg-slate-900 light:border-slate-200 light:bg-white light:hover:bg-slate-50',
                    channel.id === currentChannelId && 'text-cyan-300 light:text-cyan-700',
                  )}
                  style={{ width: CHANNEL_COLUMN }}
                  title={`Watch ${channel.name}`}
                >
                  {channel.logo && <img src={channel.logo} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-6 w-6 shrink-0 object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} />}
                  <span className="truncate">{channel.name}</span>
                  {!!channel.catchupDays && <History size={12} className="shrink-0 text-emerald-400" aria-label="TV archive" />}
                </button>
                <div className="relative border-b border-white/5 light:border-slate-100" style={{ width: timelineWidth }}>
                  {items.length === 0 && requestedRef.current.has(channel.id) && !loading && (
                    <div className="absolute inset-y-0 flex items-center text-[11px] text-slate-600" style={{ left: Math.max(8, Math.min(timelineWidth - 120, nowX - 60)) }}>
                      No guide data
                    </div>
                  )}
                  {items.map((item) => {
                    const left = Math.max(0, xFor(item.start));
                    const right = Math.min(timelineWidth, xFor(item.stop));
                    if (right <= left) return null;
                    const live = item.start <= now && now < item.stop;
                    const replay = !live && isCatchupAvailable(channel.catchupDays, item.start, now);
                    const past = item.stop <= now;
                    return (
                      <button
                        key={`${item.start}-${item.title}`}
                        onClick={() => activate(channel, item)}
                        onMouseEnter={() => setSelection({ channel, item })}
                        className={cn(
                          'absolute inset-y-1 flex flex-col justify-center gap-0.5 overflow-hidden rounded-lg border px-2 text-left text-[11px] leading-[14px] transition-colors',
                          live
                            ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-50 hover:bg-cyan-400/30 light:text-cyan-950'
                            : replay
                              ? 'border-emerald-400/30 bg-emerald-400/10 hover:bg-emerald-400/20'
                              : past
                                ? 'border-white/5 bg-white/[0.02] text-slate-500'
                                : 'border-white/10 bg-white/[0.05] hover:bg-white/10 light:border-slate-200 light:bg-slate-50',
                          selected === item && 'ring-1 ring-cyan-300',
                        )}
                        style={{ left: left + 1, width: Math.max(2, right - left - 2) }}
                        title={`${timeLabel(item.start)}–${timeLabel(item.stop)} ${item.title}`}
                      >
                        <span className="flex items-center gap-1 truncate font-bold">
                          {replay && <History size={11} className="shrink-0 text-emerald-400" />}
                          <span className="truncate">{item.title}</span>
                        </span>
                        <span className="truncate opacity-70">{timeLabel(item.start)}–{timeLabel(item.stop)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {channels.length === 0 && <div className="p-6 text-center text-sm text-slate-500">No channels to show. Load a subscription first.</div>}
      </div>

      <div className="mt-3 min-h-[64px] rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-sm light:border-slate-200 light:bg-slate-50">
        {selection ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-black">{selection.item.title}</div>
              <div className="text-xs text-slate-400">
                {selection.channel.name} · {dayLabel(selection.item.start)} {timeLabel(selection.item.start)}–{timeLabel(selection.item.stop)}
              </div>
              {selection.item.description && <div className="mt-1 line-clamp-2 text-xs text-slate-500">{selection.item.description}</div>}
            </div>
            {(selection.item.start <= now && now < selection.item.stop) ? (
              <button onClick={() => onPlayChannel(selection.channel)} className="btn-secondary shrink-0"><Play size={15} /> Watch live</button>
            ) : isCatchupAvailable(selection.channel.catchupDays, selection.item.start, now) ? (
              <button onClick={() => onPlayCatchup(selection.channel, selection.item)} className="btn-secondary shrink-0"><History size={15} /> Replay</button>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-slate-500">Hover a programme to see its details.</div>
        )}
      </div>
    </div>
  );
}
