import type MpegtsDefault from 'mpegts.js';

export type StreamFormat = 'hls' | 'mpegts' | 'native';
type Mpegts = typeof MpegtsDefault;

/** Picks the playback engine from the URL path (the local proxy and the VLC bridge name their paths accordingly). */
export function streamFormat(url: string): StreamFormat {
  let path = url.toLowerCase();
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // Not an absolute URL; look at the raw string.
  }
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.ts')) return 'mpegts';
  return url.toLowerCase().includes('m3u8') ? 'hls' : 'native';
}

let mpegtsLoader: Promise<Mpegts> | null = null;

/** mpegts.js is only downloaded and parsed the first time an MPEG-TS stream is played. */
export function loadMpegts(): Promise<Mpegts> {
  mpegtsLoader ??= import('mpegts.js').then(({ default: mpegts }) => {
    mpegts.LoggingControl.applyConfig({ enableAll: false, enableError: true, enableWarn: false, enableInfo: false, enableDebug: false, enableVerbose: false });
    return mpegts;
  });
  return mpegtsLoader;
}

/** Live MPEG-TS settings: small buffers, old data dropped, playback kept close to the live edge. */
export const MPEGTS_LIVE_CONFIG = {
  enableWorker: true,
  enableStashBuffer: true,
  stashInitialSize: 384 * 1024,
  isLive: true,
  lazyLoad: false,
  liveSync: true,
  liveSyncMaxLatency: 8,
  liveSyncTargetLatency: 4,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 30,
  autoCleanupMinBackwardDuration: 10,
  fixAudioTimestampGap: true,
};
