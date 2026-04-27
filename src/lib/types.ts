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
}

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  repository: string;
  license: string;
  downloadUrl: string;
}
