import { useEffect, useRef } from 'react';
import { onBackButtonPress } from '@tauri-apps/api/app';
import type { PluginListener } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../core/api';

/**
 * Android Back button (phone or TV remote) handling for open layers such as the player or a form.
 * Layers form a stack; Back closes the topmost one. While no layer is open the app does not listen,
 * so Back keeps its normal Android behaviour (leaving the app).
 * Escape does the same in a desktop browser preview.
 */
const stack: { close: () => void }[] = [];
let listener: Promise<PluginListener | null> | null = null;

function closeTop() {
  stack[stack.length - 1]?.close();
}

function syncListener() {
  if (!isTauriRuntime()) return;
  if (stack.length > 0 && !listener) {
    listener = onBackButtonPress(closeTop).catch(() => null);
  } else if (stack.length === 0 && listener) {
    const pending = listener;
    listener = null;
    pending.then((registered) => registered?.unregister()).catch(() => undefined);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (stack.length > 0 && (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack')) {
      event.preventDefault();
      closeTop();
    }
  });
}

export function useBackHandler(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!active) return;
    const entry = { close: () => onBackRef.current() };
    stack.push(entry);
    syncListener();
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      syncListener();
    };
  }, [active]);
}
