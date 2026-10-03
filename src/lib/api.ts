import { invoke } from '@tauri-apps/api/core';
import { Channel, ChannelLoadResult, EpgChannelKey, EpgNow, EpgProgram, Subscription, SubscriptionInfo, AppSettings, AppInfo } from './types';

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),
  currentPlatform: () => invoke<string>('current_platform'),
  listSubscriptions: () => invoke<Subscription[]>('list_subscriptions'),
  saveSubscription: (subscription: Subscription) => invoke<number>('save_subscription', { subscription }),
  deleteSubscription: (id: number) => invoke<void>('delete_subscription', { id }),
  setDefaultSubscription: (id: number) => invoke<void>('set_default_subscription', { id }),
  getDefaultSubscription: () => invoke<Subscription | null>('get_default_subscription'),
  refreshSubscriptionInfo: (id: number) => invoke<SubscriptionInfo>('refresh_subscription_info', { id }),
  loadChannels: (id: number, force = false) => invoke<ChannelLoadResult>('load_channels', { id, force }),
  loadEpgPrograms: (channel: Channel, force = false) => invoke<EpgProgram[]>('load_epg_programs', { channel, force }),
  loadEpgNow: (channels: EpgChannelKey[]) => invoke<Record<string, EpgNow>>('load_epg_now', { channels }),
  listFavorites: (subscriptionId: number) => invoke<string[]>('list_favorites', { subscriptionId }),
  toggleFavorite: (subscriptionId: number, channelId: string) => invoke<boolean>('toggle_favorite', { subscriptionId, channelId }),
  listRecents: (subscriptionId: number) => invoke<string[]>('list_recents', { subscriptionId }),
  recordRecent: (subscriptionId: number, channelId: string) => invoke<void>('record_recent', { subscriptionId, channelId }),
  resolveChannelStream: (subscriptionId: number, channel: Channel) =>
    invoke<string>('resolve_channel_stream', { subscriptionId, channel }),
  getSettings: () => invoke<AppSettings>('get_settings'),
  saveSettings: (settings: AppSettings) => invoke<void>('save_settings', { settings }),
  openPipWindow: (url: string, title: string) => invoke<void>('open_pip_window', { url, title }),
  closePipWindow: () => invoke<void>('close_pip_window'),
  openExternalPlayer: (url: string) => invoke<void>('open_external_player', { url }),
  openDetachedExternalPlayer: (url: string) => invoke<void>('open_detached_external_player', { url }),
  startVlcBridge: (url: string) => invoke<string>('start_vlc_bridge', { url }),
  stopVlcBridge: () => invoke<void>('stop_vlc_bridge'),
  stopExternalPlayer: () => invoke<void>('stop_external_player'),
  shutdownPlayback: () => invoke<void>('shutdown_playback'),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
};

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}
