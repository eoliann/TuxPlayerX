import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function maskMac(value?: string | null): string {
  if (!value) return '';
  const clean = value.trim();
  if (clean.length < 8) return clean;
  return `${clean.slice(0, 8)}:**:**:**`;
}

export function formatConnections(active?: number | null, max?: number | null): string {
  if (active == null && max == null) return 'Unknown';
  return `${active ?? 'Unknown'} / ${max ?? 'Unknown'}`;
}
