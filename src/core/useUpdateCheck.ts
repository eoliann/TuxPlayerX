import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { UpdateInfo } from './types';

const DISMISSED_KEY = 'tuxplayerx.dismissedUpdate';
const FIRST_CHECK_DELAY_MS = 5_000;
const RECHECK_MS = 12 * 3_600_000;

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Looks for a newer release of this edition shortly after startup and every 12 hours while the app runs.
 * `update` is set only for a newer version the user has not dismissed; `checkNow` is the manual check.
 */
export function useUpdateCheck(enabled: boolean) {
  const [latest, setLatest] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!enabled) return;
    const check = () => api.checkForUpdate().then(setLatest).catch(() => undefined);
    const first = window.setTimeout(check, FIRST_CHECK_DELAY_MS);
    const repeat = window.setInterval(check, RECHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(repeat);
    };
  }, [enabled]);

  const checkNow = useCallback(async () => {
    const info = await api.checkForUpdate();
    setLatest(info);
    // Asking explicitly shows the notice again even for a version dismissed earlier.
    if (info.available) setDismissed('');
    return info;
  }, []);

  const dismiss = useCallback(() => {
    if (!latest) return;
    setDismissed(latest.latestVersion);
    try {
      window.localStorage.setItem(DISMISSED_KEY, latest.latestVersion);
    } catch {
      // Ignore storage failures; the notice then only stays hidden until restart.
    }
  }, [latest]);

  const update = latest?.available && latest.latestVersion !== dismissed ? latest : null;
  return { update, checkNow, dismiss };
}
