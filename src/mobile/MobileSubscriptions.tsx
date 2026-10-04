import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { Subscription, SubscriptionType } from '../core/types';
import { api } from '../core/api';
import { cn, daysUntilExpiry, maskMac } from '../core/utils';
import { useBackHandler } from './useBackHandler';

interface Props {
  onChanged: () => void;
  onStatus: (status: string) => void;
}

const emptyForm: Subscription = {
  name: '',
  type: 'm3u',
  url: '',
  portalUrl: '',
  macAddress: '',
  username: '',
  password: '',
  isDefault: false,
};

export function MobileSubscriptions({ onChanged, onStatus }: Props) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState<Subscription | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useBackHandler(form !== null, () => setForm(null));

  const load = () =>
    api.listSubscriptions()
      .then(setSubscriptions)
      .catch((error) => onStatus(String(error)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The picked file is copied into the app's storage, so it can be read again when channels reload. */
  const importFile = async (file: File) => {
    try {
      const path = await api.importPlaylistFile(file.name, await file.text());
      setForm((prev) => prev && { ...prev, url: path, name: prev.name.trim() ? prev.name : file.name.replace(/\.(m3u8?|txt)$/i, '') });
      onStatus(`Playlist file imported: ${file.name}`);
    } catch (error) {
      onStatus(`Could not import the file. ${String(error)}`);
    }
  };

  const save = async () => {
    if (!form) return;
    if (!form.name.trim()) return onStatus('Subscription name is required.');
    if (form.type === 'm3u' && !form.url?.trim()) return onStatus('Enter a playlist URL or choose a file.');
    if (form.type === 'mac' && (!form.portalUrl?.trim() || !form.macAddress?.trim())) return onStatus('Portal URL and MAC address are required.');
    setSaving(true);
    try {
      const id = await api.saveSubscription(form);
      onStatus(`Saved: ${form.name}`);
      setForm(null);
      await load();
      onChanged();
      if (id) api.refreshSubscriptionInfo(id).then(load).catch(() => undefined);
    } catch (error) {
      onStatus(String(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (sub: Subscription) => {
    if (!sub.id || !window.confirm(`Delete "${sub.name}"?`)) return;
    await api.deleteSubscription(sub.id);
    onStatus('Subscription deleted.');
    await load();
    onChanged();
  };

  const makeDefault = async (sub: Subscription) => {
    if (!sub.id) return;
    await api.setDefaultSubscription(sub.id);
    await load();
    onChanged();
  };

  if (form) {
    const set = (patch: Partial<Subscription>) => setForm({ ...form, ...patch });
    const setType = (type: SubscriptionType) => set({ type });
    return (
      <div data-nav-scope className="mx-auto max-w-xl space-y-4 p-4">
        <h2 className="text-xl font-black">{form.id ? 'Edit subscription' : 'Add subscription'}</h2>
        <div className="grid grid-cols-2 gap-2">
          {(['m3u', 'mac'] as SubscriptionType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setType(type)}
              className={cn('rounded-2xl px-4 py-3 text-sm font-black', form.type === type ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-200')}
            >
              {type === 'm3u' ? 'M3U playlist' : 'MAC portal'}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="label">Name</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} className="field mt-2 w-full" placeholder="My TV" />
        </label>

        {form.type === 'm3u' ? (
          <>
            <label className="block">
              <span className="label">Playlist URL</span>
              <input value={form.url || ''} onChange={(e) => set({ url: e.target.value })} className="field mt-2 w-full" placeholder="https://..." inputMode="url" />
            </label>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="btn-secondary w-full justify-center">
              <FileUp size={18} /> Choose a playlist file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/x-mpegurl,application/vnd.apple.mpegurl,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importFile(file).catch(() => undefined);
                e.target.value = '';
              }}
            />
            <label className="block">
              <span className="label">Username (optional)</span>
              <input value={form.username || ''} onChange={(e) => set({ username: e.target.value })} className="field mt-2 w-full" autoCapitalize="off" />
            </label>
            <label className="block">
              <span className="label">Password (optional)</span>
              <input type="password" value={form.password || ''} onChange={(e) => set({ password: e.target.value })} className="field mt-2 w-full" />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="label">Portal URL</span>
              <input value={form.portalUrl || ''} onChange={(e) => set({ portalUrl: e.target.value })} className="field mt-2 w-full" placeholder="http://provider.example/c/" inputMode="url" />
            </label>
            <label className="block">
              <span className="label">MAC address</span>
              <input value={form.macAddress || ''} onChange={(e) => set({ macAddress: e.target.value })} className="field mt-2 w-full" placeholder="00:1A:79:..." autoCapitalize="characters" />
            </label>
          </>
        )}

        <label className="setting-row">
          <span>Use as default</span>
          <input type="checkbox" checked={form.isDefault} onChange={(e) => set({ isDefault: e.target.checked })} />
        </label>

        <div className="flex gap-2">
          <button type="button" onClick={() => setForm(null)} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="btn-primary flex-1 justify-center">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-black">Subscriptions</h2>
        <button type="button" onClick={() => setForm({ ...emptyForm })} className="btn-primary">
          <Plus size={18} /> Add
        </button>
      </div>
      {subscriptions.length === 0 && <p className="text-sm text-slate-400">No subscriptions yet. Add an M3U playlist or a MAC portal.</p>}
      {subscriptions.map((sub) => {
        const days = daysUntilExpiry(sub.expiresAt);
        return (
          <div key={sub.id} className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 light:border-slate-200 light:bg-white">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-black">
                  <span className="truncate">{sub.name}</span>
                  {sub.isDefault && <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />}
                </div>
                <div className="mt-1 truncate text-xs text-slate-400">{sub.type === 'm3u' ? sub.url : `${sub.portalUrl} · ${maskMac(sub.macAddress)}`}</div>
                {sub.expiresAt && (
                  <div className={cn('mt-1 text-xs', days !== null && days <= 7 ? 'text-amber-300' : 'text-slate-400')}>Expires: {sub.expiresAt}</div>
                )}
              </div>
              <span className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs font-black uppercase light:border-slate-200">{sub.type}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {!sub.isDefault && (
                <button type="button" onClick={() => makeDefault(sub)} className="btn-secondary">
                  <CheckCircle2 size={16} /> Default
                </button>
              )}
              <button type="button" onClick={() => setForm({ ...emptyForm, ...sub })} className="btn-secondary">
                <Pencil size={16} /> Edit
              </button>
              <button type="button" onClick={() => remove(sub)} className="btn-danger">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
