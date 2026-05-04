export type SubscriptionType = 'm3u' | 'mac';

export interface Subscription {
  id?: number;
  name: string;
  type: SubscriptionType;
  url?: string | null;
  portalUrl?: string | null;
  macAddress?: string | null;
  username?: string | null;
  password?: string | null;
  isDefault: boolean;
  expiresAt?: string | null;
  activeConnections?: number | null;
  maxConnections?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  streamUrl: string;
  logo?: string | null;
  group?: string | null;
  rawCmd?: string | null;
  epgId?: string | null;
}

export interface EpgProgram {
  channelId: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  start: string;
  stop?: string | null;
  startLabel: string;
  stopLabel?: string | null;
  isNow: boolean;
}

export interface SubscriptionInfo {
  status: string;
  expiresAt?: string | null;
  activeConnections?: number | null;
  maxConnections?: number | null;
  message?: string | null;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  networkCacheMs: number;
  autoLoadDefault: boolean;
  autoRestart: boolean;
  externalPlayerCommand: string;
  epgUrl: string;
  epgTimezoneMode: 'auto' | 'local' | 'manual';
  epgTimeOffsetMinutes: number;
}

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  repository: string;
  license: string;
  downloadUrl: string;
}
