import { invoke } from '@tauri-apps/api/core';
import { Channel, Subscription, SubscriptionInfo, AppSettings, AppInfo } from './types';

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),
  currentPlatform: () => invoke<string>('current_platform'),
  listSubscriptions: () => invoke<Subscription[]>('list_subscriptions'),
  saveSubscription: (subscription: Subscription) => invoke<number>('save_subscription', { subscription }),
  deleteSubscription: (id: number) => invoke<void>('delete_subscription', { id }),
  setDefaultSubscription: (id: number) => invoke<void>('set_default_subscription', { id }),
  getDefaultSubscription: () => invoke<Subscription | null>('get_default_subscription'),
  refreshSubscriptionInfo: (id: number) => invoke<SubscriptionInfo>('refresh_subscription_info', { id }),
  loadChannels: (id: number) => invoke<Channel[]>('load_channels', { id }),
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
