import { useState } from 'react';

const FIT_KEY = 'tuxplayerx.mobile.videoFit';

/** "Fit" (whole picture, black bars on wide phones) or "Fill" (whole screen, edges cropped); remembered. */
export function useVideoFit(): ['contain' | 'cover', () => void] {
  const [fit, setFit] = useState<'contain' | 'cover'>(() => {
    try {
      return window.localStorage.getItem(FIT_KEY) === 'cover' ? 'cover' : 'contain';
    } catch {
      return 'contain';
    }
  });
  const toggle = () =>
    setFit((prev) => {
      const next = prev === 'cover' ? 'contain' : 'cover';
      try {
        window.localStorage.setItem(FIT_KEY, next);
      } catch {
        // A preference only.
      }
      return next;
    });
  return [fit, toggle];
}
