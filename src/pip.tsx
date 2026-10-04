import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import Hls from 'hls.js';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import './styles/globals.css';
import { loadMpegts, MPEGTS_LIVE_CONFIG, streamFormat } from './lib/stream';

declare global {
  interface Window {
    __setPipSource?: (url: string, title: string) => void;
    __cleanupPip?: () => void;
  }
}

function PipApp() {
  const params = new URLSearchParams(window.location.search);
  const [src, setSrc] = useState(params.get('src') || '');
  const [title, setTitle] = useState(params.get('title') || 'TuxPlayerX');
  const [needsUserAction, setNeedsUserAction] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<{ destroy: () => void } | null>(null);
  const generationRef = useRef(0);

  const cleanup = () => {
    generationRef.current += 1;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    hlsRef.current?.destroy();
    hlsRef.current = null;
    try {
      mpegtsRef.current?.destroy();
    } catch {
      // Already torn down.
    }
    mpegtsRef.current = null;
  };

  useEffect(() => {
    window.__cleanupPip = cleanup;
    return () => {
      delete window.__cleanupPip;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeWindow = async () => {
    cleanup();
    const fallback = window.setTimeout(() => {
      window.close();
    }, 800);
    try {
      await invoke('close_pip_window');
      window.clearTimeout(fallback);
    } catch {
      window.clearTimeout(fallback);
      window.close();
    }
  };

  const play = async () => {
    const video = videoRef.current;
    if (!video || !src) return;
    try {
      await video.play();
      setNeedsUserAction(false);
    } catch {
      setNeedsUserAction(true);
    }
  };

  useEffect(() => {
    window.__setPipSource = (url: string, newTitle: string) => {
      setSrc(url);
      setTitle(newTitle || 'TuxPlayerX');
      document.title = newTitle ? `TuxPlayerX - ${newTitle}` : 'TuxPlayerX PiP';
    };
    document.title = title ? `TuxPlayerX - ${title}` : 'TuxPlayerX PiP';
  }, [title]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeWindow().catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', cleanup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    cleanup();
    setNeedsUserAction(false);

    if (!src) return;

    const format = streamFormat(src);
    if (format === 'mpegts') {
      const generation = generationRef.current;
      loadMpegts()
        .then((mpegts) => {
          if (generation !== generationRef.current || !mpegts.isSupported()) return;
          const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: src }, MPEGTS_LIVE_CONFIG);
          mpegtsRef.current = player;
          player.attachMediaElement(video);
          player.load();
          play().catch(() => undefined);
        })
        .catch(() => undefined);
      return cleanup;
    }

    if (format === 'hls' && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: false, backBufferLength: 10 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }

    window.setTimeout(() => {
      play().catch(() => undefined);
    }, 50);

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {src ? (
        <video
          ref={videoRef}
          className="h-full w-full bg-black object-contain"
          autoPlay
          playsInline
          controls={false}
          onClick={togglePlayback}
          onDoubleClick={() => videoRef.current?.requestFullscreen?.()}
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-black text-center text-xs text-white/45">
          No stream loaded
        </div>
      )}

      <button
        type="button"
        onClick={closeWindow}
        className="absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-full bg-black/70 text-white shadow-xl backdrop-blur hover:bg-red-500"
        title="Close detached video"
      >
        <X size={18} />
      </button>

      {needsUserAction && src && (
        <button
          type="button"
          onClick={play}
          className="absolute inset-0 z-10 grid place-items-center bg-black/70 text-white"
        >
          <span className="rounded-2xl border border-white/15 bg-white/10 px-6 py-4 text-sm font-black shadow-2xl backdrop-blur">
            Click to start video
          </span>
        </button>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('pip-root') as HTMLElement).render(<PipApp />);
