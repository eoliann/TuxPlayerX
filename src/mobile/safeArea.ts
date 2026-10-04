import type { CSSProperties } from 'react';

/**
 * Camera cutout ("notch") handling. The Android app draws under the cutout so videos fill the screen;
 * MainActivity reports the cutout size and it is exposed as --safe-top/right/bottom/left CSS variables.
 * Screens and overlays with buttons or text use SAFE_AREA_PADDING; the video itself ignores it.
 */
type NativeSafeArea = { insets: () => string };

function apply() {
  const native = (window as Window & { TuxSafeArea?: NativeSafeArea }).TuxSafeArea;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  try {
    if (native) insets = { ...insets, ...JSON.parse(native.insets()) };
  } catch {
    // Keep zero insets.
  }
  const root = document.documentElement.style;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    root.setProperty(`--safe-${side}`, `${Math.max(0, Number(insets[side]) || 0)}px`);
  }
}

export function enableSafeArea(): () => void {
  apply();
  window.addEventListener('tux-safe-area', apply);
  window.addEventListener('resize', apply);
  return () => {
    window.removeEventListener('tux-safe-area', apply);
    window.removeEventListener('resize', apply);
  };
}

/** Padding that keeps content clear of the camera cutout, on top of a base padding (a CSS length). */
export function safePadding(base = '0px'): CSSProperties {
  return {
    paddingTop: `calc(${base} + var(--safe-top, 0px))`,
    paddingRight: `calc(${base} + var(--safe-right, 0px))`,
    paddingBottom: `calc(${base} + var(--safe-bottom, 0px))`,
    paddingLeft: `calc(${base} + var(--safe-left, 0px))`,
  };
}
