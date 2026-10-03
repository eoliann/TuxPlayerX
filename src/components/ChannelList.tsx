import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { Channel, EpgNow } from '../lib/types';
import { cn } from '../lib/utils';

// Fixed row height (including the gap below each row) lets the list render only the visible rows,
// which keeps scrolling and searching smooth even with tens of thousands of channels.
const ROW_HEIGHT = 56;
const ROW_GAP = 6;
const OVERSCAN = 8;

export interface ChannelListHandle {
  scrollToIndex: (index: number) => void;
}

interface ChannelListProps {
  channels: Channel[];
  selectedId?: string | null;
  favorites: Set<string>;
  epgNow: Record<string, EpgNow>;
  emptyMessage: string;
  /** Changing this value scrolls the list back to the top (e.g. new search or filter). */
  resetKey: string;
  onSelect: (channel: Channel) => void;
  onToggleFavorite: (channel: Channel) => void;
}

export const ChannelList = forwardRef<ChannelListHandle, ChannelListProps>(function ChannelList(
  { channels, selectedId, favorites, epgNow, emptyMessage, resetKey, onSelect, onToggleFavorite },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // Stable callbacks so memoized rows do not re-render when the parent re-renders.
  const handlersRef = useRef({ onSelect, onToggleFavorite });
  handlersRef.current = { onSelect, onToggleFavorite };
  const stableHandlers = useRef({
    select: (channel: Channel) => handlersRef.current.onSelect(channel),
    toggleFavorite: (channel: Channel) => handlersRef.current.onToggleFavorite(channel),
  }).current;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => {
      const el = containerRef.current;
      if (!el || index < 0) return;
      const top = index * ROW_HEIGHT;
      if (top < el.scrollTop) {
        el.scrollTop = top;
      } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
      }
    },
  }));

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(channels.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div
      ref={containerRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-auto pr-1"
    >
      {channels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-500 light:border-slate-200">{emptyMessage}</div>
      ) : (
        <div className="relative" style={{ height: channels.length * ROW_HEIGHT }}>
          {channels.slice(start, end).map((channel, offset) => (
            <ChannelRow
              key={channel.id}
              top={(start + offset) * ROW_HEIGHT}
              channel={channel}
              selected={channel.id === selectedId}
              favorite={favorites.has(channel.id)}
              now={epgNow[channel.id]}
              onSelect={stableHandlers.select}
              onToggleFavorite={stableHandlers.toggleFavorite}
            />
          ))}
        </div>
      )}
    </div>
  );
});

interface ChannelRowProps {
  top: number;
  channel: Channel;
  selected: boolean;
  favorite: boolean;
  now?: EpgNow;
  onSelect: (channel: Channel) => void;
  onToggleFavorite: (channel: Channel) => void;
}

const ChannelRow = memo(function ChannelRow({ top, channel, selected, favorite, now, onSelect, onToggleFavorite }: ChannelRowProps) {
  return (
    <div
      style={{ top, height: ROW_HEIGHT - ROW_GAP }}
      className={cn(
        'group absolute inset-x-0 flex items-center gap-1 overflow-hidden rounded-xl border pl-2 pr-1 transition-colors',
        selected
          ? 'border-cyan-400/50 bg-cyan-400/15'
          : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07] light:border-slate-200 light:bg-slate-50 light:hover:bg-slate-100',
      )}
    >
      <button type="button" onClick={() => onSelect(channel)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
        <ChannelLogo src={channel.logo} name={channel.name} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[13px] font-bold">{channel.name}</div>
          {now ? (
            <div className="truncate text-[11px] text-cyan-300/80 light:text-cyan-700" title={`${now.startLabel}${now.stopLabel ? ` - ${now.stopLabel}` : ''} ${now.title}`}>
              {now.title}
            </div>
          ) : (
            <div className="truncate text-[11px] text-slate-500">{channel.group || 'Uncategorized'}</div>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => onToggleFavorite(channel)}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        className={cn(
          'shrink-0 rounded-lg p-1.5 transition-opacity',
          favorite ? 'text-amber-300 light:text-amber-500' : 'text-slate-500 opacity-0 hover:text-amber-300 group-hover:opacity-100 focus:opacity-100',
        )}
      >
        <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
      </button>
      {now?.progress != null && (
        <div className="pointer-events-none absolute inset-x-2 bottom-1 h-0.5 overflow-hidden rounded bg-white/10 light:bg-slate-200">
          <div className="h-full bg-cyan-400/70" style={{ width: `${Math.round(now.progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
});

const ChannelLogo = memo(function ChannelLogo({ src, name }: { src?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    const initials = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase() || 'TV';
    return (
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-800 text-[11px] font-black text-cyan-300 light:bg-slate-200 light:text-cyan-700">
        {initials}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-lg bg-slate-800/60 object-contain p-0.5 light:bg-slate-200"
    />
  );
});
