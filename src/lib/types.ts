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
  /** Days of TV archive available for catch-up. */
  catchupDays?: number | null;
  catchupType?: string | null;
  catchupSource?: string | null;
}

export interface ChannelLoadResult {
  channels: Channel[];
  fromCache: boolean;
  fetchedAt: number;
}

export interface EpgChannelKey {
  id: string;
  name: string;
  epgId?: string | null;
}

export interface EpgNow {
  title: string;
  startLabel: string;
  stopLabel?: string | null;
  progress?: number | null;
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
  resumeLastChannel: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  repository: string;
  license: string;
  downloadUrl: string;
}

export interface ImportSummary {
  addedSubscriptions: number;
  existingSubscriptions: number;
  favorites: number;
  settings: AppSettings;
}

export interface EpgGridItem {
  title: string;
  description?: string | null;
  /** Unix timestamps in seconds. */
  start: number;
  stop: number;
}

export type VodKind = 'movie' | 'series';

export interface VodCategory {
  id: string;
  name: string;
}

export interface VodItem {
  id: string;
  name: string;
  kind: VodKind;
  poster?: string | null;
  rating?: string | null;
  year?: string | null;
  plot?: string | null;
  extension?: string | null;
  cmd?: string | null;
  episodes?: number[] | null;
}

export interface VodPage {
  items: VodItem[];
  hasMore: boolean;
}

export interface VodDetails {
  plot?: string | null;
  genre?: string | null;
  cast?: string | null;
  director?: string | null;
  releaseDate?: string | null;
  duration?: string | null;
  rating?: string | null;
  backdrop?: string | null;
}

export interface SeriesEpisode {
  id: string;
  number: number;
  title: string;
  extension?: string | null;
  plot?: string | null;
  duration?: string | null;
  poster?: string | null;
  cmd?: string | null;
}

export interface SeriesSeason {
  number: number;
  name: string;
  episodes: SeriesEpisode[];
}

export interface SeriesInfo {
  name: string;
  poster?: string | null;
  plot?: string | null;
  seasons: SeriesSeason[];
}

export interface VodPlayRequest {
  kind: 'movie' | 'episode';
  id: string;
  extension?: string | null;
  cmd?: string | null;
  episodeNumber?: number | null;
}
