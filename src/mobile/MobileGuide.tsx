import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, History, RefreshCw, X } from 'lucide-react';
import { Channel, EpgGridItem } from '../core/types';
import { api } from '../core/api';
import { cn, isCatchupAvailable } from '../core/utils';
import { useBackHandler } from './useBackHandler';
import { safePadding } from './safeArea';

interface Props {
  channels: Channel[];
  currentChannelId?: string | null;
  onPlay: (channel: Channel) => void;
  onReplay: (channel: Channel, item: EpgGridItem) => void;
  onClose: () => void;
}

const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 32;
const PX_PER_MINUTE = 3.5;
const WINDOW_HOURS = 8;
const SHIFT_HOURS = 2;
const OVERSCAN_ROWS = 4;

/** Half an hour before now, aligned to the half hour, so the programmes on air are in view. */
function windowStartFor(date: Date): number {
  const value = Math.floor(date.getTime() / 1000);
  return Math.floor(value / 1800) * 1800 - 1800;
}

const timeLabel = (value: number) => new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (value: number) => new Date(value * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Full TV guide: channels down, time across. Only the rows on screen are drawn and loaded.
 * Tap (or OK) a programme on air to watch it, a past one with the archive icon to replay it.
 * TV remote: the arrows move between programmes, Back closes the guide.
 */
export function MobileGuide({ channels, currentChannelId, onPlay, onReplay, onClose }: Props) {
  const [from, setFrom] = useState(() => windowStartFor(new Date()));
  const to = from + WINDOW_HOURS * 3600;
  const [cells, setCells] = useState<Record<string, EpgGridItem[]>>({});
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [selected, setSelected] = useState<{ channel: Channel; item: EpgGridItem } | null>(null);
  const [view, setView] = useState({ top: 0, height: 600, width: 360 });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const requested = useRef<Set<string>>(new Set());

  useBackHandler(true, onClose);

  // Channel names take a third of a phone screen, a fixed column on wider screens.
  const channelColumn = Math.min(200, Math.max(104, Math.round(view.width * 0.3)));
  const timelineWidth = WINDOW_HOURS * 60 * PX_PER_MINUTE;
  const xFor = (value: number) => ((value - from) / 60) * PX_PER_MINUTE;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCells({});
    requested.current = new Set();
  }, [from]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight, width: element.clientWidth });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    // Open on the playing channel.
    const index = channels.findIndex((channel) => channel.id === currentChannelId);
    if (index > 0) element.scrollTop = Math.max(0, index * ROW_HEIGHT - element.clientHeight / 2);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show "now" near the left edge whenever the time window changes.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = Math.max(0, xFor(Date.now() / 1000) - 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const firstRow = Math.max(0, Math.floor((view.top - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(channels.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  const rows = useMemo(() => channels.slice(firstRow, lastRow), [channels, firstRow, lastRow]);

  // Load programmes for the rows on screen, a moment after scrolling stops.
  useEffect(() => {
    const missing = rows.filter((channel) => !requested.current.has(channel.id));
    if (missing.length === 0) return;
    const timer = window.setTimeout(() => {
      missing.forEach((channel) => requested.current.add(channel.id));
      setLoading(true);
      api.loadEpgGrid(missing.map((channel) => ({ id: channel.id, name: channel.name, epgId: channel.epgId })), from, to)
        .then((result) => setCells((prev) => ({ ...prev, ...(result ?? {}) })))
        .catch(() => missing.forEach((channel) => requested.current.delete(channel.id)))
        .finally(() => setLoading(false));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [rows, from, to]);

  const activate = (channel: Channel, item: EpgGridItem) => {
    if (item.start <= now && now < item.stop) onPlay(channel);
    else if (isCatchupAvailable(channel.catchupDays, item.start, now)) onReplay(channel, item);
    else setSelected({ channel, item });
  };

  const halfHours = Array.from({ length: WINDOW_HOURS * 2 }, (_, index) => from + index * 1800);
  const nowX = xFor(now);

  return (
    <div data-nav-scope className="fixed inset-0 z-40 flex flex-col bg-slate-950 light:bg-slate-100" style={safePadding()}>
      <div className="flex items-center gap-2 border-b border-white/10 p-3 light:border-slate-200">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-black">TV Guide</div>
          <div className="truncate text-xs text-slate-400">
            {dayLabel(from)} · {timeLabel(from)} – {timeLabel(to)}
            {loading && <RefreshCw size={12} className="ml-2 inline animate-spin" />}
          </div>
        </div>
        <button type="button" onClick={() => setFrom((value) => value - SHIFT_HOURS * 3600)} className="btn-secondary px-3" aria-label="Earlier">
          <ChevronLeft size={18} />
        </button>
        <button type="button" onClick={() => setFrom(windowStartFor(new Date()))} className="btn-secondary px-3 text-xs">Now</button>
        <button type="button" onClick={() => setFrom((value) => value + SHIFT_HOURS * 3600)} className="btn-secondary px-3" aria-label="Later">
          <ChevronRight size={18} />
        </button>
        <button type="button" onClick={onClose} className="btn-secondary px-3" aria-label="Close guide">
          <X size={18} />
        </button>
      </div>

      <div
        ref={scrollRef}
        data-nav-group
        onScroll={(e) => {
          const element = e.currentTarget;
          setView((prev) => (prev.top === element.scrollTop ? prev : { ...prev, top: element.scrollTop }));
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="relative" style={{ width: channelColumn + timelineWidth, height: HEADER_HEIGHT + channels.length * ROW_HEIGHT }}>
          {/* Time header, kept at the top while scrolling down. */}
          <div className="sticky top-0 z-20 flex bg-slate-950 light:bg-slate-100" style={{ height: HEADER_HEIGHT }}>
            <div className="sticky left-0 z-10 shrink-0 bg-slate-950 light:bg-slate-100" style={{ width: channelColumn }} />
            <div className="relative" style={{ width: timelineWidth }}>
              {halfHours.map((value) => (
                <span key={value} className="absolute top-2 text-[11px] font-bold text-slate-400" style={{ left: xFor(value) + 4 }}>
                  {timeLabel(value)}
                </span>
              ))}
            </div>
          </div>

          {now >= from && now < to && (
            <div className="pointer-events-none absolute bottom-0 z-10 w-0.5 bg-cyan-400/80" style={{ top: HEADER_HEIGHT, left: channelColumn + nowX }} />
          )}

          {rows.map((channel, index) => {
            const row = firstRow + index;
            const items = cells[channel.id] ?? [];
            const isCurrent = channel.id === currentChannelId;
            return (
              <div key={channel.id} className="absolute left-0 flex" style={{ top: HEADER_HEIGHT + row * ROW_HEIGHT, height: ROW_HEIGHT, width: channelColumn + timelineWidth }}>
                <div
                  className={cn(
                    'sticky left-0 z-10 flex shrink-0 items-center gap-2 border-b border-r border-white/5 bg-slate-950 px-2 light:border-slate-200 light:bg-slate-100',
                    isCurrent && 'text-cyan-300',
                  )}
                  style={{ width: channelColumn }}
                >
                  {channel.logo && <img src={channel.logo} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-md object-contain" />}
                  <span className="line-clamp-2 text-xs font-bold leading-tight">{channel.name}</span>
                </div>
                <div className="relative border-b border-white/5 light:border-slate-200" style={{ width: timelineWidth }}>
                  {items.map((item) => {
                    const left = xFor(Math.max(item.start, from));
                    const width = xFor(Math.min(item.stop, to)) - left;
                    if (width <= 0) return null;
                    const onAir = item.start <= now && now < item.stop;
                    const past = item.stop <= now;
                    const replayable = past && isCatchupAvailable(channel.catchupDays, item.start, now);
                    return (
                      <button
                        key={`${item.start}-${item.title}`}
                        type="button"
                        onClick={() => activate(channel, item)}
                        className={cn(
                          'absolute top-1 bottom-1 overflow-hidden rounded-lg border px-2 text-left',
                          onAir
                            ? 'border-cyan-400/50 bg-cyan-400/15'
                            : past
                              ? 'border-white/5 bg-white/[0.03] text-slate-500 light:border-slate-200 light:bg-white/60'
                              : 'border-white/10 bg-white/[0.06] light:border-slate-200 light:bg-white',
                        )}
                        style={{ left: left + 1, width: Math.max(width - 2, 18) }}
                      >
                        <span className="flex items-center gap-1 truncate text-xs font-bold">
                          {replayable && <History size={11} className="shrink-0 text-amber-300" />}
                          <span className="truncate">{item.title}</span>
                        </span>
                        <span className="block truncate text-[10px] text-slate-400">{timeLabel(item.start)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="border-t border-white/10 p-3 text-sm light:border-slate-200">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-black">{selected.item.title}</div>
              <div className="text-xs text-slate-400">
                {selected.channel.name} · {dayLabel(selected.item.start)} {timeLabel(selected.item.start)} – {timeLabel(selected.item.stop)}
              </div>
              {selected.item.description && <p className="mt-1 line-clamp-3 text-xs text-slate-300">{selected.item.description}</p>}
              <p className="mt-1 text-[11px] text-slate-500">
                {selected.item.start > now ? 'Not on air yet.' : 'This channel keeps no archive for this programme.'}
              </p>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="btn-secondary shrink-0 px-2" aria-label="Close details">
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
