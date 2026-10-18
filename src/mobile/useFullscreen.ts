import { useCallback, useEffect, useState } from 'react';

const LANDSCAPE = '(orientation: landscape)';

/** Turns the screen to landscape and back: natively in the Android app, through the browser APIs elsewhere. */
function lockLandscape(landscape: boolean) {
  const native = (window as Window & { TuxScreen?: { setLandscape: (landscape: boolean) => void } }).TuxScreen;
  if (native) {
    native.setLandscape(landscape);
    return;
  }
  const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
  if (landscape) {
    document.documentElement
      .requestFullscreen?.()
      .then(() => orientation.lock?.('landscape'))
      .catch(() => undefined);
  } else {
    try {
      orientation.unlock?.();
    } catch {
      // Not locked.
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  }
}

/**
 * Fullscreen for the mobile players. Turning the device sideways enters it and turning it back leaves it,
 * as before; the fullscreen button does the same without turning the device (it rotates the screen),
 * and pressing it again goes back. The rotation lock is released when the player closes.
 */
export function useFullscreen() {
  const [fullscreen, setFullscreen] = useState(() => window.matchMedia(LANDSCAPE).matches);

  useEffect(() => {
    const query = window.matchMedia(LANDSCAPE);
    const onChange = () => setFullscreen(query.matches);
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
      lockLandscape(false);
    };
  }, []);

  const toggle = useCallback(() => {
    lockLandscape(!fullscreen);
    setFullscreen(!fullscreen);
  }, [fullscreen]);

  return { fullscreen, toggle };
}
