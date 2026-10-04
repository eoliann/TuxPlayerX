import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Star, X } from 'lucide-react';
import { AppSettings, Channel, EpgProgram } from '../core/types';
import { api } from '../core/api';
import type { StreamFormat } from '../core/stream';
import { cn } from '../core/utils';
import { VideoSurface, VideoSurfaceHandle } from '../core/components/VideoSurface';
import { useBackHandler } from './useBackHandler';

interface Props {
  subscriptionId: number;
  channel: Channel;
  /** The list the channel was picked from; channel up/down moves through it. */
  channels: Channel[];
  settings: AppSettings;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onChannelChange: (channel: Channel) => void;
  onPlayed: (channel: Channel) => void;
  onClose: () => void;
  onStatus: (status: string) => void;
}

/** How long the info bar stays visible over full-screen video (landscape / TV). */
const INFO_HIDE_MS = 5000;

/**
 * Full-screen player. Portrait phones show the video on top with details below; landscape phones,
 * tablets and TVs show the video full screen with an info bar that appears on tap or remote keys.
 * Remote: Up/Down or Channel +/- switch channels, OK shows the info bar, Back closes the player.
 */
export function MobilePlayer({
  subscriptionId,
  channel,
  channels,
  settings,
  isFavorite,
  onToggleFavorite,
  onChannelChange,
  onPlayed,
  onClose,
  onStatus,
}: Props) {
  const [src, setSrc] = useState('');
  const [format, setFormat] = useState<StreamFormat | undefined>(undefined);
  const [programs, setPrograms] = useState<EpgProgram[]>([]);
  const [infoVisible, setInfoVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const surfaceRef = useRef<VideoSurfaceHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const playSeq = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);

  useBackHandler(true, onClose);

  const showInfo = () => {
    setInfoVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setInfoVisible(false), INFO_HIDE_MS);
  };

  const start = async (target: Channel) => {
    const seq = ++playSeq.current;
    setSrc('');
    try {
      const url = await api.resolveChannelStream(subscriptionId, target);
      const direct = await api.prepareDirectStream(url, { userAgent: target.userAgent, referrer: target.referrer });
      if (seq !== playSeq.current) return;
      setFormat(direct.format);
      setSrc(direct.url);
      api.recordRecent(subscriptionId, target.id).then(() => onPlayed(target)).catch(() => undefined);
    } catch (error) {
      if (seq === playSeq.current) onStatus(`${target.name}: ${String(error)}`);
    }
  };

  useEffect(() => {
    start(channel).catch(() => undefined);
    showInfo();
    setPrograms([]);
    if (settings.epgUrl?.trim()) {
      api.loadEpgPrograms(channel)
        .then((list) => setPrograms(list ?? []))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Release the provider connection while the app is in the background, and resume on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        playSeq.current += 1;
        surfaceRef.current?.stop();
        setSrc('');
        setPaused(true);
      } else if (paused) {
        setPaused(false);
        start(channel).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, paused]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const step = (delta: number) => {
    if (channels.length === 0) return;
    const index = channels.findIndex((item) => item.id === channel.id);
    const next = channels[(index + delta + channels.length) % channels.length];
    if (next && next.id !== channel.id) onChannelChange(next);
  };

  // Remote control keys while the player is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const onButton = target?.tagName === 'BUTTON';
      if (onButton && event.key === 'Enter') return; // OK presses the focused button.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Left/Right show the info bar and move between its buttons.
        showInfo();
        const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter(
          (button) => button.getBoundingClientRect().width > 0,
        );
        if (buttons.length > 0) {
          const index = onButton ? buttons.indexOf(target as HTMLButtonElement) : -1;
          const next = index < 0 ? 0 : Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1)));
          buttons[next].focus();
        }
        event.preventDefault();
        return;
      }
      switch (event.key) {
        case 'ArrowUp':
        case 'ChannelUp':
        case 'PageUp':
          step(-1);
          break;
        case 'ArrowDown':
        case 'ChannelDown':
        case 'PageDown':
          step(1);
          break;
        case 'Enter':
        case 'Info':
          showInfo();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, channels]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const now = programs.find((program) => program.isNow) ?? programs[0];
  const upcoming = programs.filter((program) => !program.isNow && program !== now).slice(0, 3);

  const controls = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => step(-1)} className="btn-secondary px-3" aria-label="Previous channel">
        <ChevronUp size={20} />
      </button>
      <button type="button" onClick={() => step(1)} className="btn-secondary px-3" aria-label="Next channel">
        <ChevronDown size={20} />
      </button>
      <button
        type="button"
        onClick={onToggleFavorite}
        className={cn('btn-secondary px-3', isFavorite && 'text-amber-300')}
        aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star size={20} fill={isFavorite ? 'currentColor' : 'none'} />
      </button>
      <button type="button" onClick={onClose} className="btn-secondary px-3" aria-label="Close player">
        <X size={20} />
      </button>
    </div>
  );

  const details = (
    <div className="min-w-0">
      <div className="truncate text-lg font-black">{channel.name}</div>
      {now ? (
        <div className="mt-1 text-sm">
          <span className="font-bold text-cyan-300">{now.startLabel}{now.stopLabel ? ` – ${now.stopLabel}` : ''}</span>{' '}
          <span className="text-slate-200">{now.title}</span>
        </div>
      ) : (
        <div className="mt-1 text-sm text-slate-400">{channel.group || ''}</div>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-nav-ignore
      className="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none landscape:block"
      onClick={showInfo}
    >
      <div className="relative aspect-video w-full shrink-0 landscape:absolute landscape:inset-0 landscape:aspect-auto">
        <VideoSurface
          ref={surfaceRef}
          src={src}
          format={format}
          compact
          autoRestart={settings.autoRestart}
          onStatus={(message) => {
            if (!message.startsWith('Playback started')) onStatus(message);
          }}
          onUnsupported={() => onStatus(`${channel.name} uses a video or audio format this device cannot play.`)}
          className="min-h-0 rounded-none border-0 shadow-none"
        />
        {!src && (
          <div className="absolute inset-0 grid place-items-center bg-black text-sm text-slate-300">
            <div className="flex items-center gap-3">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-500 border-t-cyan-300" />
              Connecting to {channel.name}...
            </div>
          </div>
        )}
      </div>

      {/* Portrait: details below the video. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 landscape:hidden">
        {details}
        {controls}
        {upcoming.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Up next</div>
            {upcoming.map((program) => (
              <div key={`${program.start}-${program.title}`} className="flex gap-3 text-sm">
                <span className="w-12 shrink-0 font-bold text-slate-400">{program.startLabel}</span>
                <span className="text-slate-200">{program.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Landscape / TV: info bar over the video. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-black/90 via-black/60 to-transparent p-6 pt-16 transition-opacity duration-300 landscape:block',
          infoVisible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className={cn('flex items-end justify-between gap-4', infoVisible && 'pointer-events-auto')}>
          {details}
          {controls}
        </div>
        {upcoming[0] && (
          <div className="mt-2 text-sm text-slate-300">
            Next: {upcoming[0].startLabel} {upcoming[0].title}
          </div>
        )}
      </div>
    </div>
  );
}
