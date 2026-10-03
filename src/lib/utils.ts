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

/** Whole days from today until an expiry date like "2026-10-06" (negative when expired); null when unknown/unlimited. */
export function daysUntilExpiry(expiresAt?: string | null): number | null {
  const match = expiresAt?.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const expiry = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
}

export const EXPIRY_WARNING_DAYS = 7;

/** True when a programme that started at `start` (Unix seconds) can be replayed from the channel's TV archive. */
export function isCatchupAvailable(catchupDays: number | null | undefined, start: number, nowSeconds = Date.now() / 1000): boolean {
  if (!catchupDays || catchupDays <= 0) return false;
  return start < nowSeconds - 60 && start > nowSeconds - catchupDays * 86_400;
}
