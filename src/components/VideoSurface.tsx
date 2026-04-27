import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Play, RotateCw, TriangleAlert } from 'lucide-react';

interface VideoSurfaceProps {
  src: string;
  title?: string;
  autoPlay?: boolean;
  muted?: boolean;
  compact?: boolean;
  autoRestart?: boolean;
  onStatus?: (status: string) => void;
}

export interface VideoSurfaceHandle {
  requestPictureInPicture: () => Promise<void>;
  requestFullscreen: () => Promise<void>;
  stop: () => void;
}

export const VideoSurface = forwardRef<VideoSurfaceHandle, VideoSurfaceProps>(function VideoSurface(
  { src, title, autoPlay = true, muted = false, compact = false, autoRestart = true, onStatus },
  ref,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fullscreenLockRef = useRef(false);
  const [restartCount, setRestartCount] = useState(0);
  const [needsUserAction, setNeedsUserAction] = useState(false);
  const [playbackError, setPlaybackError] = useState('');

  const destroyHls = () => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
  };

  const stopPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const doc = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
      if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) {
        doc.exitPictureInPicture().catch(() => undefined);
      }
    } catch {
      // Ignore browser-specific PiP cleanup failures.
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    destroyHls();
  };

  const tryPlay = async () => {
    const video = videoRef.current;
    if (!video || !src) return;
    try {
      setPlaybackError('');
      await video.play();
      setNeedsUserAction(false);
      onStatus?.('Playback started.');
    } catch (error) {
      setNeedsUserAction(true);
      const message = error instanceof Error ? error.message : String(error);
      onStatus?.(`Playback requires user interaction. ${message || ''}`.trim());
    }
  };

  const requestNativePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video || !src) {
      throw new Error('Start a channel before opening Picture-in-Picture.');
    }

    const doc = document as Document & {
      pictureInPictureEnabled?: boolean;
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    const videoWithPip = video as HTMLVideoElement & {
      disablePictureInPicture?: boolean;
      requestPictureInPicture?: () => Promise<unknown>;
    };

    if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) {
      await doc.exitPictureInPicture();
      onStatus?.('Picture-in-Picture closed.');
      return;
    }

    if (!doc.pictureInPictureEnabled || !videoWithPip.requestPictureInPicture) {
      throw new Error('Native Picture-in-Picture is not available in this WebView.');
    }

    videoWithPip.disablePictureInPicture = false;
    if (video.paused) {
      await tryPlay();
    }
    await videoWithPip.requestPictureInPicture();
    onStatus?.('Picture-in-Picture opened.');
  };

  const requestSmoothFullscreen = async () => {
    if (fullscreenLockRef.current) return;
    fullscreenLockRef.current = true;
    window.setTimeout(() => {
      fullscreenLockRef.current = false;
    }, 900);

    const target = wrapperRef.current || videoRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen({ navigationUI: 'hide' as any });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatus?.(`Fullscreen could not be changed. ${message}`);
    }
  };

  useImperativeHandle(ref, () => ({
    requestPictureInPicture: requestNativePictureInPicture,
    requestFullscreen: requestSmoothFullscreen,
    stop: stopPlayback,
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    destroyHls();
    setRestartCount(0);
    setNeedsUserAction(false);
    setPlaybackError('');

    video.pause();
    video.removeAttribute('src');
    video.load();

    if (!src) return;

    const lower = src.toLowerCase();
    const isHls = lower.includes('.m3u8') || lower.includes('m3u8');

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 12,
        manifestLoadingRetryDelay: 500,
        fragLoadingMaxRetry: 12,
        fragLoadingRetryDelay: 500,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const issue = `Playback issue: ${data.details}`;
        if (data.fatal) {
          onStatus?.(issue);
          setPlaybackError(issue);
          if (autoRestart) {
            setRestartCount((value) => value + 1);
          }
        }
      });
    } else {
      video.src = src;
    }

    if (autoPlay) {
      window.setTimeout(() => {
        tryPlay().catch(() => undefined);
      }, 50);
    } else {
      setNeedsUserAction(true);
    }

    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      destroyHls();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, autoPlay, autoRestart]);

  useEffect(() => {
    if (!restartCount || !src) return;
    const video = videoRef.current;
    if (!video) return;
    const timer = window.setTimeout(() => {
      onStatus?.('Restarting stalled stream...');
      const current = src;
      destroyHls();
      video.pause();
      video.removeAttribute('src');
      video.load();
      window.setTimeout(() => {
        if (current.toLowerCase().includes('.m3u8') && Hls.isSupported()) {
          const hls = new Hls({
            lowLatencyMode: true,
            backBufferLength: 30,
            manifestLoadingMaxRetry: 12,
            manifestLoadingRetryDelay: 500,
            fragLoadingMaxRetry: 12,
            fragLoadingRetryDelay: 500,
          });
          hlsRef.current = hls;
          hls.loadSource(current);
          hls.attachMedia(video);
        } else {
          video.src = current;
        }
        tryPlay().catch(() => undefined);
      }, 250);
    }, 900);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartCount, src, onStatus]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoRestart) return;
    const onProblem = () => setRestartCount((value) => value + 1);
    const onError = () => {
      setPlaybackError('The embedded WebView player could not play this stream. If the same channel works in VLC, use Open in VLC or the local VLC bridge.');
      setNeedsUserAction(false);
      onProblem();
    };
    video.addEventListener('stalled', onProblem);
    video.addEventListener('ended', onProblem);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('stalled', onProblem);
      video.removeEventListener('ended', onProblem);
      video.removeEventListener('error', onError);
    };
  }, [autoRestart]);

  const userActionOverlay = src && needsUserAction;
  const errorOverlay = src && playbackError && !needsUserAction;

  return (
    <div ref={wrapperRef} className="relative h-full min-h-[260px] overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-black/30 light:border-slate-200">
      {src ? (
        <video
          ref={videoRef}
          className="h-full w-full bg-black object-contain"
          controls
          autoPlay={autoPlay}
          muted={muted}
          playsInline
          onClick={() => needsUserAction && tryPlay()}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            requestSmoothFullscreen().catch(() => undefined);
          }}
        />
      ) : (
        <div className="grid h-full min-h-[320px] place-items-center bg-slate-950 text-center text-slate-500">
          <div>
            <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-3xl bg-white/5">
              <RotateCw size={28} />
            </div>
            <div className="text-sm font-semibold">No channel selected</div>
            <div className="mt-1 text-xs">Load a subscription and select a channel.</div>
          </div>
        </div>
      )}

      {userActionOverlay && (
        <button
          type="button"
          onClick={tryPlay}
          className="absolute inset-0 grid place-items-center bg-black/70 text-white backdrop-blur-sm"
        >
          <span className="flex flex-col items-center gap-3 rounded-3xl border border-white/15 bg-white/10 px-8 py-6 shadow-2xl">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-cyan-400 text-slate-950">
              <Play size={28} fill="currentColor" />
            </span>
            <span className="text-sm font-black">Click to start playback</span>
            <span className="max-w-sm text-center text-xs text-white/65">Windows WebView may block autoplay until you click inside the player.</span>
          </span>
        </button>
      )}

      {errorOverlay && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-2xl border border-amber-400/25 bg-amber-950/80 p-4 text-sm text-amber-50 shadow-xl backdrop-blur">
          <div className="flex gap-3">
            <TriangleAlert className="mt-0.5 shrink-0" size={18} />
            <div>
              <div className="font-black">Embedded playback issue</div>
              <div className="mt-1 text-xs text-amber-100/80">{playbackError}</div>
            </div>
          </div>
        </div>
      )}

      {title && !compact && (
        <div className="pointer-events-none absolute left-4 top-4 max-w-[70%] truncate rounded-full bg-black/55 px-4 py-2 text-xs font-bold text-white backdrop-blur">{title}</div>
      )}
    </div>
  );
});
