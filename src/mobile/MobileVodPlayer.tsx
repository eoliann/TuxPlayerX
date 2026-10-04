import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Rewind, FastForward, X } from 'lucide-react';
import type { StreamFormat } from '../core/stream';
import { cn } from '../core/utils';
import { formatClock, loadProgress, saveProgress } from '../core/vodProgress';
import { VideoSurface, VideoSurfaceHandle } from '../core/components/VideoSurface';
import { useBackHandler } from './useBackHandler';

export interface VodPlayback {
  title: string;
  url: string;
  format: StreamFormat;
  /** Resume map key (see progressKey). */
  key: string;
}

interface Props {
  playback: VodPlayback;
  onClose: () => void;
  onStatus: (status: string) => void;
}

const SEEK_SECONDS = 10;
const BAR_HIDE_MS = 4000;

/**
 * Full-screen movie / episode player. Touch: the video's own controls. TV remote: OK pauses or resumes,
 * Left / Right seek 10 seconds (Rewind / Fast-forward keys 30 seconds), Back closes. The position is saved for resuming.
 */
export function MobileVodPlayer({ playback, onClose, onStatus }: Props) {
  const surfaceRef = useRef<VideoSurfaceHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [barVisible, setBarVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [position, setPosition] = useState<{ time: number; duration: number } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [initialTime] = useState(() => loadProgress()[playback.key]?.time);

  useBackHandler(true, onClose);

  const showBar = () => {
    setBarVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarVisible(false), BAR_HIDE_MS);
  };

  useEffect(() => {
    rootRef.current?.focus();
    showBar();
    return () => window.clearTimeout(hideTimer.current);
  }, []);

  // Pause when the app goes to the background; the position is kept.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && !paused) {
        surfaceRef.current?.togglePause();
        setPaused(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [paused]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'BUTTON' && event.key === 'Enter') return;
      const seek = (seconds: number) => {
        const time = surfaceRef.current?.seekBy(seconds);
        if (time !== undefined) setPosition((prev) => (prev ? { ...prev, time } : prev));
      };
      switch (event.key) {
        case 'Enter':
        case ' ':
        case 'MediaPlayPause':
          setPaused(surfaceRef.current?.togglePause() ?? false);
          break;
        case 'ArrowLeft':
          seek(-SEEK_SECONDS);
          break;
        case 'ArrowRight':
          seek(SEEK_SECONDS);
          break;
        case 'MediaRewind':
          seek(-30);
          break;
        case 'MediaFastForward':
          seek(30);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          break;
        default:
          return;
      }
      showBar();
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const progressPercent = position && position.duration > 0 ? (position.time / position.duration) * 100 : 0;

  return (
    <div ref={rootRef} tabIndex={-1} data-nav-ignore className="fixed inset-0 z-50 bg-black text-white outline-none" onClick={showBar}>
      <VideoSurface
        ref={surfaceRef}
        src={playback.url}
        format={playback.format}
        compact
        autoRestart={false}
        initialTime={initialTime}
        onProgress={(time, duration) => {
          saveProgress(playback.key, time, duration);
          setPosition({ time, duration });
        }}
        onStatus={(message) => {
          if (!message.startsWith('Playback started')) onStatus(message);
        }}
        onUnsupported={() => onStatus(`${playback.title} uses a video or audio format this device cannot play.`)}
        className="min-h-0 rounded-none border-0 shadow-none"
      />
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 to-transparent p-4 pb-12 transition-opacity duration-300',
          barVisible ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className={cn('flex items-center gap-3', barVisible && 'pointer-events-auto')}>
          <button type="button" onClick={onClose} className="rounded-full bg-white/10 p-2" aria-label="Close player">
            <X size={20} />
          </button>
          <div className="min-w-0 flex-1 truncate text-base font-black">{playback.title}</div>
        </div>
        {position && (
          <div className="mt-3 flex items-center gap-3 text-xs text-slate-300">
            <span className="flex items-center gap-1">
              {paused ? <Pause size={14} /> : <Play size={14} />}
              {formatClock(position.time)} / {formatClock(position.duration)}
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded bg-white/20">
              <span className="block h-full bg-cyan-400" style={{ width: `${progressPercent}%` }} />
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <Rewind size={14} /> <FastForward size={14} /> {SEEK_SECONDS}s
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
