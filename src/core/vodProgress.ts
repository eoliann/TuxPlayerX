/** Resume points for movies and episodes, kept per device in local storage (shared by desktop and Android). */

const PROGRESS_KEY = 'tuxplayerx.vodProgress';

export type ProgressMap = Record<string, { time: number; duration: number; updatedAt: number }>;

export function loadProgress(): ProgressMap {
  try {
    return JSON.parse(window.localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveProgress(key: string, time: number, duration: number) {
  try {
    const all = loadProgress();
    // Finished (or barely started) items do not need a resume point.
    if (time < 30 || time > duration * 0.95) delete all[key];
    else all[key] = { time, duration, updatedAt: Date.now() };
    // Keep the 200 most recent entries.
    const trimmed = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 200));
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(trimmed));
  } catch {
    // Resume points are a convenience only.
  }
}

export const formatClock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** Identifies a movie or episode of a subscription in the resume map. */
export function progressKey(subscriptionId: number | string, kind: 'movie' | 'episode', id: string, episodeNumber?: number | null) {
  return `${subscriptionId}|${kind}|${id}|${episodeNumber ?? ''}`;
}
