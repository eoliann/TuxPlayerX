/**
 * D-pad navigation for Android TV remotes (and keyboards): the arrow keys move focus to the
 * nearest focusable element in that direction. Touch devices are unaffected.
 * Elements inside `[data-nav-ignore]` handle the arrow keys themselves (the full-screen player).
 */

type Direction = 'up' | 'down' | 'left' | 'right';

const KEYS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return getComputedStyle(element).visibility !== 'hidden';
}

/** Distance from `from` to `to` in `direction`, or null when `to` is not in that direction. */
function score(from: DOMRect, to: DOMRect, direction: Direction): number | null {
  // Gap between the two boxes across the direction of travel; 0 when they overlap (same column / row).
  const gap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => Math.max(0, bStart - aEnd, aStart - bEnd);
  let primary: number;
  let cross: number;
  switch (direction) {
    case 'up':
      primary = from.top - to.bottom;
      cross = gap(from.left, from.right, to.left, to.right);
      break;
    case 'down':
      primary = to.top - from.bottom;
      cross = gap(from.left, from.right, to.left, to.right);
      break;
    case 'left':
      primary = from.left - to.right;
      cross = gap(from.top, from.bottom, to.top, to.bottom);
      break;
    default:
      primary = to.left - from.right;
      cross = gap(from.top, from.bottom, to.top, to.bottom);
  }
  // Allow slight overlap so items in tight grids are still reachable.
  if (primary < -Math.min(from.height, from.width) / 2) return null;
  // Among equally close boxes prefer the one best aligned with the current element.
  const alignment = direction === 'up' || direction === 'down'
    ? Math.abs(from.left - to.left)
    : Math.abs(from.top + from.height / 2 - (to.top + to.height / 2));
  return Math.max(primary, 0) + cross * 2 + alignment * 0.05;
}

function handleKey(event: KeyboardEvent) {
  const direction = KEYS[event.key];
  if (!direction || event.defaultPrevented) return;
  const active = document.activeElement as HTMLElement | null;
  if (active?.closest('[data-nav-ignore]')) return;
  // Let text fields move the caret left and right.
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && (direction === 'left' || direction === 'right')) return;
  // Select lists open with OK (Enter); the arrows only move focus, as on a TV.

  // An open dialog or sheet marks itself with data-nav-scope so focus stays inside it.
  const scopes = document.querySelectorAll<HTMLElement>('[data-nav-scope]');
  const scope = scopes.length > 0 ? scopes[scopes.length - 1] : document.body;
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element !== active && !element.closest('[data-nav-ignore]') && isVisible(element),
  );
  if (candidates.length === 0) return;

  if (!active || active === document.body || !scope.contains(active)) {
    candidates[0].focus();
    event.preventDefault();
    return;
  }

  const from = active.getBoundingClientRect();
  const pick = (pool: HTMLElement[]) => {
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const candidate of pool) {
      const value = score(from, candidate.getBoundingClientRect(), direction);
      if (value !== null && value < bestScore) {
        bestScore = value;
        best = candidate;
      }
    }
    return best;
  };
  // Inside a scrolling list ([data-nav-group]) keep moving through the list while it has items that way,
  // even when the next item is still below the visible area.
  const group = active.closest<HTMLElement>('[data-nav-group]');
  const best = (group && pick(candidates.filter((candidate) => group.contains(candidate)))) || pick(candidates);
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    event.preventDefault();
  }
}

export function enableSpatialNavigation(): () => void {
  window.addEventListener('keydown', handleKey);
  return () => window.removeEventListener('keydown', handleKey);
}
