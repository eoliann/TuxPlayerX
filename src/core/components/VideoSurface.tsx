import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import Hls from 'hls.js';
import { AudioLines, Captions, Check, Play, RotateCw, TriangleAlert } from 'lucide-react';
import { cn } from '../utils';
import { loadMpegts, MPEGTS_LIVE_CONFIG, streamFormat, type StreamFormat } from '../stream';

// Live-TV oriented hls.js settings, shared by the initial load and the auto-restart path.
const HLS_CONFIG: Partial<Hls['config']> = {
  lowLatencyMode: false,
  backBufferLength: 10,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferHole: 0.5,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 8,
  liveDurationInfinity: true,
  manifestLoadingMaxRetry: 4,
  manifestLoadingRetryDelay: 1000,
  manifestLoadingMaxRetryTimeout: 8000,
  fragLoadingMaxRetry: 6,
  fragLoadingRetryDelay: 1000,
  fragLoadingMaxRetryTimeout: 30000,
  levelLoadingMaxRetry: 6,
  levelLoadingRetryDelay: 1000,
  enableWorker: true,
  startFragPrefetch: true,
};

/** Full reloads attempted before giving up on a stream. */
const MAX_RESTARTS = 5;
/** Playback that runs this long after a restart counts as recovered and resets the attempt counter. */
const HEALTHY_PLAYBACK_MS = 30_000;

const MANIFEST_ERRORS = new Set<string>([
  Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
  Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
  Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
]);

const CODEC_ERRORS = new Set<string>([
  Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR,
  Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR,
  Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR,
]);

interface MediaTrack {
  index: number;
  label: string;
  lang?: string;
}

interface PlaybackPrefs {
  volume: number;
  muted: boolean;
  audioLang?: string;
  /** Preferred subtitle language; null means subtitles were explicitly turned off. */
  subtitleLang?: string | null;
}

const PREFS_KEY = 'tuxplayerx.playback';

function loadPrefs(): PlaybackPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw) return { volume: 1, muted: false, ...JSON.parse(raw) };
  } catch {
    // Storage may be unavailable; fall back to defaults.
  }
  return { volume: 1, muted: false };
}

function savePrefs(patch: Partial<PlaybackPrefs>) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Ignore storage failures; preferences are a convenience only.
  }
}

type NativeAudioTrack = { label: string; language: string; enabled: boolean };
type NativeAudioTrackList = { length: number; [index: number]: NativeAudioTrack } & EventTarget;

function nativeAudioTracks(video: HTMLVideoElement): NativeAudioTrackList | undefined {
  return (video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }).audioTracks;
}

function nativeSubtitleTracks(video: HTMLVideoElement): TextTrack[] {
  return Array.from(video.textTracks).filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
}

function trackLabel(name: string | undefined, lang: string | undefined, index: number): string {
  const label = (name || '').trim();
  const code = (lang || '').trim();
  if (label && code && !label.toLowerCase().includes(code.toLowerCase())) return `${label} (${code})`;
  return label || code.toUpperCase() || `Track ${index + 1}`;
}

interface VideoSurfaceProps {
  src: string;
  title?: string;
  autoPlay?: boolean;
  muted?: boolean;
  compact?: boolean;
  autoRestart?: boolean;
  /** Seconds to seek to once the media is loaded (used to resume movies). */
  initialTime?: number;
  /** Called about every 5 seconds during playback with the position and duration in seconds. */
  onProgress?: (time: number, duration: number) => void;
  onStatus?: (status: string) => void;
  /** Called when the WebView cannot decode the stream (e.g. HEVC); the parent may switch to a transcoded source. */
  onUnsupported?: () => void;
  /**
   * Called instead of the automatic restarts when the stream fails before it ever played,
   * so the parent can try another way (for example the VLC bridge).
   */
  onFailed?: (reason: string) => void;
  /** Playback engine; detected from the URL when omitted. */
  format?: StreamFormat;
}

export interface VideoSurfaceHandle {
  requestPictureInPicture: () => Promise<void>;
  requestFullscreen: () => Promise<void>;
  toggleMute: () => boolean;
  /** Switches to the next audio track and returns its label (undefined when there is only one). */
  cycleAudioTrack: () => string | undefined;
  /** Cycles subtitles (off → track 1 → ... → off) and returns the new label. */
  cycleSubtitles: () => string | undefined;
  stop: () => void;
}

export const VideoSurface = forwardRef<VideoSurfaceHandle, VideoSurfaceProps>(function VideoSurface(
  { src, title, autoPlay = true, muted = false, compact = false, autoRestart = true, initialTime, onProgress, onStatus, onUnsupported, onFailed, format },
  ref,
) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<{ destroy: () => void } | null>(null);
  /** Bumped whenever the engines are torn down, so a pending asynchronous attach knows it is stale. */
  const engineGenerationRef = useRef(0);
  /** True once the current source has actually played; failures after that are handled by restarts. */
  const hasPlayedRef = useRef(false);
  const fullscreenLockRef = useRef(false);
  const [restartCount, setRestartCount] = useState(0);
  const restartAttemptsRef = useRef(0);
  const lastRestartAtRef = useRef(0);
  // Callbacks and flags read from long-lived event handlers, kept current without re-creating the player.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;
  const formatRef = useRef(format);
  formatRef.current = format;
  const autoRestartRef = useRef(autoRestart);
  autoRestartRef.current = autoRestart;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const [needsUserAction, setNeedsUserAction] = useState(false);
  const [playbackError, setPlaybackError] = useState('');
  const [audioTracks, setAudioTracks] = useState<MediaTrack[]>([]);
  const [audioIndex, setAudioIndex] = useState(-1);
  const [subtitleTracks, setSubtitleTracks] = useState<MediaTrack[]>([]);
  const [subtitleIndex, setSubtitleIndex] = useState(-1);
  const [openMenu, setOpenMenu] = useState<'audio' | 'subtitles' | null>(null);

  /** Reads the available audio/subtitle tracks from hls.js or from the native media element. */
  const syncTracks = () => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (hls) {
      setAudioTracks(hls.audioTracks.map((track, index) => ({ index, label: trackLabel(track.name, track.lang, index), lang: track.lang })));
      setAudioIndex(hls.audioTrack);
      setSubtitleTracks(hls.subtitleTracks.map((track, index) => ({ index, label: trackLabel(track.name, track.lang, index), lang: track.lang })));
      setSubtitleIndex(hls.subtitleDisplay ? hls.subtitleTrack : -1);
      return;
    }
    if (!video) return;
    const audio = nativeAudioTracks(video);
    const audioList: MediaTrack[] = [];
    let enabledAudio = -1;
    for (let index = 0; audio && index < audio.length; index += 1) {
      audioList.push({ index, label: trackLabel(audio[index].label, audio[index].language, index), lang: audio[index].language });
      if (audio[index].enabled) enabledAudio = index;
    }
    setAudioTracks(audioList);
    setAudioIndex(enabledAudio);
    const subtitles = nativeSubtitleTracks(video);
    setSubtitleTracks(subtitles.map((track, index) => ({ index, label: trackLabel(track.label, track.language, index), lang: track.language })));
    setSubtitleIndex(subtitles.findIndex((track) => track.mode === 'showing'));
  };

  const selectAudioTrack = (index: number, remember = true) => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (hls) {
      hls.audioTrack = index;
    } else if (video) {
      const audio = nativeAudioTracks(video);
      for (let i = 0; audio && i < audio.length; i += 1) audio[i].enabled = i === index;
    }
    const lang = audioTracks[index]?.lang;
    if (remember && lang) savePrefs({ audioLang: lang });
    setAudioIndex(index);
    setOpenMenu(null);
  };

  const selectSubtitleTrack = (index: number, remember = true) => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleTrack = index;
      hls.subtitleDisplay = index >= 0;
    } else if (video) {
      nativeSubtitleTracks(video).forEach((track, i) => {
        track.mode = i === index ? 'showing' : 'disabled';
      });
    }
    if (remember) savePrefs({ subtitleLang: index >= 0 ? subtitleTracks[index]?.lang || null : null });
    setSubtitleIndex(index);
    setOpenMenu(null);
  };

  // Apply the remembered audio/subtitle language when a stream exposes matching tracks.
  const appliedPrefsForRef = useRef('');
  useEffect(() => {
    const key = `${src}|${audioTracks.length}|${subtitleTracks.length}`;
    if (!src || appliedPrefsForRef.current === key) return;
    appliedPrefsForRef.current = key;
    const prefs = loadPrefs();
    if (prefs.audioLang && audioTracks.length > 1) {
      const wanted = audioTracks.find((track) => track.lang?.toLowerCase() === prefs.audioLang?.toLowerCase());
      if (wanted && wanted.index !== audioIndex) selectAudioTrack(wanted.index, false);
    }
    if (prefs.subtitleLang && subtitleTracks.length > 0 && subtitleIndex < 0) {
      const wanted = subtitleTracks.find((track) => track.lang?.toLowerCase() === prefs.subtitleLang?.toLowerCase());
      if (wanted) selectSubtitleTrack(wanted.index, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, audioTracks, subtitleTracks]);

  /** Wires track events for a newly created hls.js instance. */
  const watchHlsTracks = (hls: Hls) => {
    hls.subtitleDisplay = false;
    for (const event of [
      Hls.Events.MANIFEST_PARSED,
      Hls.Events.AUDIO_TRACKS_UPDATED,
      Hls.Events.AUDIO_TRACK_SWITCHED,
      Hls.Events.SUBTITLE_TRACKS_UPDATED,
      Hls.Events.SUBTITLE_TRACK_SWITCH,
    ]) {
      hls.on(event, syncTracks);
    }
  };

  const destroyHls = () => {
    engineGenerationRef.current += 1;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    try {
      mpegtsRef.current?.destroy();
    } catch {
      // The player may already be torn down.
    }
    mpegtsRef.current = null;
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
      const name = error instanceof DOMException ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      if (name === 'AbortError') return; // A newer load replaced this one.
      if (name === 'NotAllowedError') {
        // Autoplay was blocked; a click inside the player starts it.
        setNeedsUserAction(true);
        onStatus?.('Click inside the player to start playback.');
        return;
      }
      // NotSupportedError: the format is not supported or the server sent no playable media.
      setNeedsUserAction(false);
      setPlaybackError('This stream could not be played by the built-in player (unsupported format or the server sent no video). Try Open in VLC.');
      onStatus?.(`Playback failed: ${message || name || 'unsupported stream'}`);
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
    toggleMute: () => {
      const video = videoRef.current;
      if (!video) return false;
      video.muted = !video.muted;
      return video.muted;
    },
    cycleAudioTrack: () => {
      if (audioTracks.length < 2) return undefined;
      const next = (audioIndex + 1) % audioTracks.length;
      selectAudioTrack(next);
      return audioTracks[next].label;
    },
    cycleSubtitles: () => {
      if (subtitleTracks.length === 0) return undefined;
      const next = subtitleIndex + 1 >= subtitleTracks.length ? -1 : subtitleIndex + 1;
      selectSubtitleTrack(next);
      return next < 0 ? 'Off' : subtitleTracks[next].label;
    },
    stop: stopPlayback,
  }));

  // Resume position and progress reporting (movies and episodes).
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let lastReport = 0;
    const onLoaded = () => {
      if (initialTime && initialTime > 0 && Number.isFinite(video.duration) && initialTime < video.duration - 5) {
        video.currentTime = initialTime;
      }
    };
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastReport < 5000 || !Number.isFinite(video.duration)) return;
      lastReport = now;
      onProgressRef.current?.(video.currentTime, video.duration);
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (Number.isFinite(video.duration) && video.currentTime > 0) onProgressRef.current?.(video.currentTime, video.duration);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Remember volume and mute between sessions, and keep native track lists in sync.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onVolumeChange = () => savePrefs({ volume: video.volume, muted: video.muted });
    const audio = nativeAudioTracks(video);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('loadedmetadata', syncTracks);
    video.textTracks.addEventListener('addtrack', syncTracks);
    video.textTracks.addEventListener('change', syncTracks);
    audio?.addEventListener('addtrack', syncTracks);
    audio?.addEventListener('change', syncTracks);
    return () => {
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('loadedmetadata', syncTracks);
      video.textTracks.removeEventListener('addtrack', syncTracks);
      video.textTracks.removeEventListener('change', syncTracks);
      audio?.removeEventListener('addtrack', syncTracks);
      audio?.removeEventListener('change', syncTracks);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src ? 'video' : 'empty']);

  /**
   * Creates the playback engine for `url` and wires recovery handling.
   * Returns true when the engine starts playback itself (mpegts.js attaches asynchronously).
   */
  const attachSource = (video: HTMLVideoElement, url: string): boolean => {
    const kind = formatRef.current ?? streamFormat(url);
    if (kind === 'mpegts') {
      attachMpegts(video, url);
      return true;
    }
    if (kind !== 'hls' || !Hls.isSupported()) {
      video.src = url;
      return false;
    }
    const hls = new Hls(HLS_CONFIG);
    hlsRef.current = hls;
    watchHlsTracks(hls);
    let networkRecoveries = 0;
    let mediaRecoveries = 0;
    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRecoveries = 0;
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || hlsRef.current !== hls) return;
      onStatusRef.current?.(`Playback issue: ${data.details}`);

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Without a loaded manifest startLoad() has nothing to resume, so the source must be reloaded.
        if (!MANIFEST_ERRORS.has(data.details) && networkRecoveries < 3) {
          networkRecoveries += 1;
          window.setTimeout(() => hlsRef.current === hls && hls.startLoad(), 1000 * networkRecoveries);
          return;
        }
        handleFatal(`Playback issue: ${data.details}`);
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (!CODEC_ERRORS.has(data.details) && mediaRecoveries < 2) {
          if (mediaRecoveries === 1) hls.swapAudioCodec();
          mediaRecoveries += 1;
          hls.recoverMediaError();
          return;
        }
        reportUnsupported(`Playback issue: ${data.details}`);
        return;
      }

      handleFatal(`Playback issue: ${data.details}`);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    return false;
  };

  /** Live MPEG-TS (most Xtream channels) through mpegts.js, which only repackages the stream for the WebView. */
  const attachMpegts = (video: HTMLVideoElement, url: string) => {
    const generation = engineGenerationRef.current;
    loadMpegts()
      .then((mpegts) => {
        if (generation !== engineGenerationRef.current) return;
        if (!mpegts.isSupported()) {
          reportUnsupported('This WebView cannot play MPEG-TS streams');
          return;
        }
        const player = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, MPEGTS_LIVE_CONFIG);
        mpegtsRef.current = player;
        player.on(mpegts.Events.ERROR, (type: string, details: string) => {
          if (mpegtsRef.current !== player) return;
          onStatusRef.current?.(`Playback issue: ${details}`);
          if (type === mpegts.ErrorTypes.MEDIA_ERROR) {
            reportUnsupported(`Playback issue: ${details}`);
            return;
          }
          handleFatal(`Playback issue: ${details}`);
        });
        player.attachMediaElement(video);
        player.load();
        if (autoPlayRef.current) tryPlay().catch(() => undefined);
      })
      .catch((error) => handleFatal(`Could not start the MPEG-TS player: ${String(error)}`));
  };

  /** A fatal error: before the first frame the parent may switch engines, afterwards the stream is restarted. */
  const handleFatal = (reason: string) => {
    if (!hasPlayedRef.current && onFailedRef.current) {
      destroyHls();
      onFailedRef.current(reason);
      return;
    }
    requestRestart(reason);
  };

  /** Schedules a full reload of the stream, with exponential backoff and a cap on attempts. */
  const requestRestart = (reason: string) => {
    if (!autoRestartRef.current) {
      setPlaybackError(reason);
      return;
    }
    if (restartAttemptsRef.current >= MAX_RESTARTS) {
      destroyHls();
      videoRef.current?.pause();
      setPlaybackError(`${reason}. The stream did not recover after ${MAX_RESTARTS} attempts; the channel may be offline. Press Reload to try again or use Open in VLC.`);
      onStatusRef.current?.('Stream unavailable, automatic restarts stopped.');
      return;
    }
    restartAttemptsRef.current += 1;
    setRestartCount((value) => value + 1);
  };

  /** The WebView cannot decode this stream; let the parent switch to a transcoded source if it can. */
  const reportUnsupported = (reason: string) => {
    destroyHls();
    if (onUnsupportedRef.current) {
      onStatusRef.current?.('Stream format is not supported by the built-in player, converting it...');
      onUnsupportedRef.current();
      return;
    }
    setPlaybackError(`${reason}. This stream format is not supported by the built-in player. Try Open in VLC.`);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    destroyHls();
    setRestartCount(0);
    restartAttemptsRef.current = 0;
    hasPlayedRef.current = false;
    lastRestartAtRef.current = Date.now();
    setNeedsUserAction(false);
    setPlaybackError('');
    setAudioTracks([]);
    setAudioIndex(-1);
    setSubtitleTracks([]);
    setSubtitleIndex(-1);
    setOpenMenu(null);

    video.pause();
    video.removeAttribute('src');
    video.load();

    if (!src) return;

    const prefs = loadPrefs();
    video.volume = Math.min(1, Math.max(0, prefs.volume));
    video.muted = prefs.muted;

    const startsItself = attachSource(video, src);

    if (autoPlay) {
      if (!startsItself) {
        window.setTimeout(() => {
          tryPlay().catch(() => undefined);
        }, 50);
      }
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
  }, [src, autoPlay]);

  useEffect(() => {
    if (!restartCount || !src) return;
    const video = videoRef.current;
    if (!video) return;
    const attempt = restartAttemptsRef.current;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
    onStatusRef.current?.(`Reconnecting (attempt ${attempt}/${MAX_RESTARTS})...`);
    const timer = window.setTimeout(() => {
      destroyHls();
      video.pause();
      video.removeAttribute('src');
      video.load();
      lastRestartAtRef.current = Date.now();
      if (!attachSource(video, src)) tryPlay().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restartCount, src]);

  // Remember that the current source really played, whatever the auto-restart setting.
  const hasVideo = Boolean(src);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlaying = () => {
      hasPlayedRef.current = true;
    };
    video.addEventListener('playing', onPlaying);
    return () => video.removeEventListener('playing', onPlaying);
  }, [hasVideo]);

  // Smart stall watchdog: only restart after sustained playback stall,
  // NOT on transient buffering events (which are normal in HLS).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoRestart) return;
    let lastTime = -1;
    let stalledSince = 0;
    const STALL_THRESHOLD_MS = 8000; // 8 seconds of no progress = real stall

    const watchdog = window.setInterval(() => {
      if (!video.src && !video.currentSrc) return;
      if (video.paused || video.ended) return;

      const now = Date.now();
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        stalledSince = 0;
        // After a while of healthy playback, later failures get a fresh set of restart attempts.
        if (restartAttemptsRef.current && now - lastRestartAtRef.current > HEALTHY_PLAYBACK_MS) restartAttemptsRef.current = 0;
        return;
      }
      // Time hasn't changed — track how long
      if (stalledSince === 0) {
        stalledSince = now;
        return;
      }
      if (now - stalledSince > STALL_THRESHOLD_MS) {
        stalledSince = 0;
        lastTime = -1;
        onStatusRef.current?.('Stream stalled for too long, restarting...');
        handleFatal('Stream stalled');
      }
    }, 2000);

    const onEnded = () => requestRestart('Stream ended');
    const onError = () => {
      // hls.js reports its own errors; this only covers sources played natively by the video element.
      if (hlsRef.current || mpegtsRef.current || !video.getAttribute('src')) return;
      setNeedsUserAction(false);
      if (video.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || video.error?.code === MediaError.MEDIA_ERR_DECODE) {
        reportUnsupported('The embedded WebView player could not decode this stream');
        return;
      }
      handleFatal('The embedded WebView player lost the stream');
    };
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    return () => {
      window.clearInterval(watchdog);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRestart, hasVideo]);

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

      {src && !compact && (audioTracks.length > 1 || subtitleTracks.length > 0) && (
        <div className="absolute right-4 top-4 z-10 flex gap-2">
          {audioTracks.length > 1 && (
            <TrackMenu
              icon={<AudioLines size={15} />}
              label="Audio"
              open={openMenu === 'audio'}
              onToggle={() => setOpenMenu(openMenu === 'audio' ? null : 'audio')}
              items={audioTracks}
              current={audioIndex}
              onPick={selectAudioTrack}
            />
          )}
          {subtitleTracks.length > 0 && (
            <TrackMenu
              icon={<Captions size={15} />}
              label="Subtitles"
              open={openMenu === 'subtitles'}
              onToggle={() => setOpenMenu(openMenu === 'subtitles' ? null : 'subtitles')}
              items={[{ index: -1, label: 'Off' }, ...subtitleTracks]}
              current={subtitleIndex}
              onPick={selectSubtitleTrack}
            />
          )}
        </div>
      )}

      {title && !compact && (
        <div className="pointer-events-none absolute left-4 top-4 max-w-[70%] truncate rounded-full bg-black/55 px-4 py-2 text-xs font-bold text-white backdrop-blur">{title}</div>
      )}
    </div>
  );
});

interface TrackMenuProps {
  icon: ReactNode;
  label: string;
  open: boolean;
  items: MediaTrack[];
  current: number;
  onToggle: () => void;
  onPick: (index: number) => void;
}

function TrackMenu({ icon, label, open, items, current, onToggle, onPick }: TrackMenuProps) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-bold text-white backdrop-blur hover:bg-black/80"
      >
        {icon} {label}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 max-h-64 min-w-44 overflow-auto rounded-2xl border border-white/10 bg-slate-950/95 p-1 text-sm text-white shadow-2xl backdrop-blur">
          {items.map((item) => (
            <button
              key={item.index}
              type="button"
              onClick={() => onPick(item.index)}
              className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/10', item.index === current && 'text-cyan-300')}
            >
              <Check size={14} className={item.index === current ? 'opacity-100' : 'opacity-0'} />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
