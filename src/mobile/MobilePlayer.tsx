import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Expand, History, Radio, Shrink, Star, X } from 'lucide-react';
import { AppSettings, Channel, EpgProgram } from '../core/types';
import { api } from '../core/api';
import type { StreamFormat } from '../core/stream';
import { cn, isCatchupAvailable } from '../core/utils';
import { VideoSurface, VideoSurfaceHandle } from '../core/components/VideoSurface';
import { useBackHandler } from './useBackHandler';
import { safePadding } from './safeArea';
import { useVideoFit } from './useVideoFit';

/** A past programme replayed from the channel's TV archive. Times are Unix seconds. */
export interface ArchiveProgramme {
  title: string;
  start: number;
  stop: number;
}

interface Props {
  subscriptionId: number;
  channel: Channel;
  /** When set, this programme is replayed from the archive instead of the live stream. */
  archive?: ArchiveProgramme | null;
  /** The list the channel was picked from; channel up/down moves through it. */
  channels: Channel[];
  settings: AppSettings;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onChannelChange: (channel: Channel) => void;
  /** Replays a past programme (null returns to the live stream). */
  onArchiveChange: (archive: ArchiveProgramme | null) => void;
  onPlayed: (channel: Channel) => void;
  onClose: () => void;
  onStatus: (status: string) => void;
}

/** How long the info bar stays visible over full-screen video (landscape / TV). */
const INFO_HIDE_MS = 5000;

const seconds = (iso?: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : NaN);

/** Start and stop of a guide programme in Unix seconds (stop defaults to 30 minutes). */
function programmeTimes(program: EpgProgram): [number, number] {
  const start = seconds(program.start);
  const stop = seconds(program.stop);
  return [start, Number.isFinite(stop) && stop > start ? stop : start + 1800];
}

/**
 * Full-screen player. Portrait phones show the video on top with details below; landscape phones,
 * tablets and TVs show the video full screen with an info bar that appears on tap or remote keys.
 * Remote: Up/Down or Channel +/- switch channels, OK shows the info bar, Back closes the player.
 */
export function MobilePlayer({
  subscriptionId,
  channel,
  archive,
  channels,
  settings,
  isFavorite,
  onToggleFavorite,
  onChannelChange,
  onArchiveChange,
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
  const [fit, toggleFit] = useVideoFit();

  const showInfo = () => {
    setInfoVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setInfoVisible(false), INFO_HIDE_MS);
  };

  const start = async (target: Channel, programme?: ArchiveProgramme | null) => {
    const seq = ++playSeq.current;
    setSrc('');
    try {
      const url = programme
        ? await api.resolveCatchupStream(target, programme.start, programme.stop)
        : await api.resolveChannelStream(subscriptionId, target);
      const direct = await api.prepareDirectStream(url, { userAgent: target.userAgent, referrer: target.referrer });
      if (seq !== playSeq.current) return;
      setFormat(direct.format);
      setSrc(direct.url);
      if (!programme) api.recordRecent(subscriptionId, target.id).then(() => onPlayed(target)).catch(() => undefined);
    } catch (error) {
      if (seq === playSeq.current) onStatus(`${programme ? `${programme.title} (archive)` : target.name}: ${String(error)}`);
    }
  };

  useEffect(() => {
    start(channel, archive).catch(() => undefined);
    showInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, archive?.start]);

  useEffect(() => {
    setPrograms([]);
    if (!settings.epgUrl?.trim()) return;
    api.loadEpgPrograms(channel)
      .then((list) => setPrograms(list ?? []))
      .catch(() => undefined);
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
        start(channel, archive).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, archive?.start, paused]);

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

  const nowSeconds = Date.now() / 1000;
  const current = programs.find((program) => program.isNow);
  const upcoming = programs.filter((program) => programmeTimes(program)[0] > nowSeconds).slice(0, 3);
  // Past programmes that the provider still keeps in the archive, newest first.
  const replayable = programs
    .filter((program) => {
      const [start, stop] = programmeTimes(program);
      return stop <= nowSeconds && isCatchupAvailable(channel.catchupDays, start, nowSeconds);
    })
    .reverse();

  const replay = (program: EpgProgram) => {
    const [start, stop] = programmeTimes(program);
    onArchiveChange({ title: program.title, start, stop });
  };

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      {archive && (
        <button type="button" onClick={() => onArchiveChange(null)} className="btn-primary px-3" aria-label="Back to live">
          <Radio size={18} /> Live
        </button>
      )}
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
      <button type="button" onClick={toggleFit} className="btn-secondary px-3" aria-label={fit === 'cover' ? 'Fit the whole picture' : 'Fill the screen'}>
        {fit === 'cover' ? <Shrink size={20} /> : <Expand size={20} />}
      </button>
      <button type="button" onClick={onClose} className="btn-secondary px-3" aria-label="Close player">
        <X size={20} />
      </button>
    </div>
  );

  const timeOf = (value: number) => new Date(value * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const details = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="truncate text-lg font-black">{channel.name}</span>
        {archive && <span className="shrink-0 rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-black uppercase text-amber-300">Archive</span>}
      </div>
      {archive ? (
        <div className="mt-1 text-sm">
          <span className="font-bold text-amber-300">{timeOf(archive.start)} – {timeOf(archive.stop)}</span>{' '}
          <span className="text-slate-200">{archive.title}</span>
        </div>
      ) : current ? (
        <div className="mt-1 text-sm">
          <span className="font-bold text-cyan-300">{current.startLabel}{current.stopLabel ? ` – ${current.stopLabel}` : ''}</span>{' '}
          <span className="text-slate-200">{current.title}</span>
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
          allowFullscreen={false}
          fit={fit}
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
              {archive ? `Opening ${archive.title} from the archive...` : `Connecting to ${channel.name}...`}
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
        {replayable.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Earlier · replay from the archive</div>
            {replayable.map((program) => (
              <button
                key={`${program.start}-${program.title}`}
                type="button"
                onClick={() => replay(program)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-white/5',
                  archive?.start === programmeTimes(program)[0] && 'bg-amber-400/10',
                )}
              >
                <span className="w-12 shrink-0 font-bold text-slate-400">{program.startLabel}</span>
                <span className="min-w-0 flex-1 truncate text-slate-200">{program.title}</span>
                <History size={16} className="shrink-0 text-amber-300" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Landscape / TV: info bar over the video. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 hidden bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300 landscape:block',
          infoVisible ? 'opacity-100' : 'opacity-0',
        )}
        style={{ ...safePadding('1.5rem'), paddingTop: '4rem' }}
      >
        <div className={cn('flex items-end justify-between gap-4', infoVisible && 'pointer-events-auto')}>
          {details}
          {controls}
        </div>
        {!archive && upcoming[0] && (
          <div className="mt-2 text-sm text-slate-300">
            Next: {upcoming[0].startLabel} {upcoming[0].title}
          </div>
        )}
      </div>
    </div>
  );
}
