import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { Subscription, SubscriptionType } from '../lib/types';
import { api } from '../lib/api';
import { formatConnections, maskMac } from '../lib/utils';

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

export function SubscriptionsView({ onChanged, onStatus }: Props) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [form, setForm] = useState<Subscription>(emptyForm);
  const [search, setSearch] = useState('');

  const load = async () => {
    const list = await api.listSubscriptions();
    setSubscriptions(list);
  };

  useEffect(() => {
    load().catch((err) => onStatus(String(err)));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return subscriptions;
    return subscriptions.filter((sub) => `${sub.name} ${sub.type} ${sub.url || ''} ${sub.portalUrl || ''}`.toLowerCase().includes(q));
  }, [subscriptions, search]);

  const startAdd = (type: SubscriptionType) => {
    setEditing(null);
    setForm({ ...emptyForm, type });
  };

  const startEdit = (sub: Subscription) => {
    setEditing(sub);
    setForm({ ...emptyForm, ...sub });
  };

  const save = async () => {
    if (!form.name.trim()) return onStatus('Subscription name is required.');
    if (form.type === 'm3u' && !form.url?.trim()) return onStatus('M3U URL or file path is required.');
    if (form.type === 'mac' && (!form.portalUrl?.trim() || !form.macAddress?.trim())) return onStatus('Portal URL and MAC address are required.');
    const id = await api.saveSubscription(form);
    onStatus(`Subscription saved: ${form.name}`);
    setEditing(null);
    setForm(emptyForm);
    await load();
    onChanged();
    if (id) {
      api.refreshSubscriptionInfo(id).then(() => load()).catch(() => undefined);
    }
  };

  const remove = async (sub: Subscription) => {
    if (!sub.id) return;
    if (!confirm(`Delete subscription "${sub.name}"?`)) return;
    await api.deleteSubscription(sub.id);
    onStatus('Subscription deleted.');
    await load();
    onChanged();
  };

  const setDefault = async (sub: Subscription) => {
    if (!sub.id) return;
    await api.setDefaultSubscription(sub.id);
    onStatus(`${sub.name} is now the default subscription.`);
    await load();
    onChanged();
  };

  const refreshInfo = async (sub: Subscription) => {
    if (!sub.id) return;
    try {
      const info = await api.refreshSubscriptionInfo(sub.id);
      onStatus(`Info refreshed: ${info.status}`);
      await load();
    } catch (err) {
      onStatus(String(err));
    }
  };

  return (
    <div className="grid grid-cols-[420px_minmax(0,1fr)] gap-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 light:border-slate-200 light:bg-white">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Subscription form</h2>
            <p className="text-xs text-slate-500">Choose M3U or MAC and fill only the relevant fields.</p>
          </div>
          <button onClick={() => setForm(emptyForm)} className="rounded-2xl border border-white/10 p-2 light:border-slate-200"><X size={18} /></button>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3">
          <button onClick={() => setForm((prev) => ({ ...prev, type: 'm3u' }))} className={`rounded-2xl px-4 py-3 text-sm font-black ${form.type === 'm3u' ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-100'}`}>M3U</button>
          <button onClick={() => setForm((prev) => ({ ...prev, type: 'mac' }))} className={`rounded-2xl px-4 py-3 text-sm font-black ${form.type === 'mac' ? 'bg-cyan-400 text-slate-950' : 'bg-white/5 light:bg-slate-100'}`}>MAC</button>
        </div>

        <div className="space-y-3">
          <label className="block text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="field" placeholder="My subscription" />

          {form.type === 'm3u' ? (
            <div className="space-y-3 rounded-3xl border border-cyan-400/20 bg-cyan-400/5 p-4">
              <label className="label">M3U URL or local file</label>
              <input value={form.url || ''} onChange={(e) => setForm({ ...form, url: e.target.value })} className="field" placeholder="https://example.com/get.php?username=...&password=..." />
              <label className="label">Username (optional)</label>
              <input value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} className="field" />
              <label className="label">Password (optional)</label>
              <input type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} className="field" />
            </div>
          ) : (
            <div className="space-y-3 rounded-3xl border border-emerald-400/20 bg-emerald-400/5 p-4">
              <label className="label">Portal URL</label>
              <input value={form.portalUrl || ''} onChange={(e) => setForm({ ...form, portalUrl: e.target.value })} className="field" placeholder="https://provider.example.com/c/" />
              <label className="label">MAC address</label>
              <input value={form.macAddress || ''} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} className="field" placeholder="00:1A:79:XX:XX:XX" />
            </div>
          )}

          <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm font-semibold light:border-slate-200 light:bg-slate-50">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
            Use as default subscription
          </label>

          <button onClick={save} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-4 py-3 text-sm font-black text-slate-950 hover:bg-cyan-300">
            <Save size={16} /> {editing ? 'Save changes' : 'Add subscription'}
          </button>
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 light:border-slate-200 light:bg-white">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-black">Subscriptions</h2>
            <p className="text-xs text-slate-500">Refresh info where the provider exposes expiration and connection data.</p>
          </div>
          <button onClick={() => startAdd('m3u')} className="flex items-center gap-2 rounded-2xl bg-emerald-400 px-4 py-3 text-sm font-black text-slate-950"><Plus size={16} /> Add subscription</button>
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} className="field mb-4" placeholder="Search subscriptions..." />

        <div className="space-y-3">
          {filtered.map((sub) => (
            <div key={sub.id} className="rounded-3xl border border-white/10 bg-white/[0.03] p-4 light:border-slate-200 light:bg-slate-50">
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-black">{sub.name}</h3>
                    {sub.isDefault && <span className="rounded-full bg-cyan-400/15 px-2 py-1 text-[10px] font-black uppercase text-cyan-300 light:text-cyan-700">Default</span>}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-500">{sub.type === 'm3u' ? sub.url : `${sub.portalUrl} · ${maskMac(sub.macAddress)}`}</div>
                </div>
                <span className="rounded-full border border-white/10 px-3 py-1 text-xs font-black uppercase light:border-slate-200">{sub.type}</span>
              </div>
              <div className="mb-4 grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-2xl bg-black/20 p-3 light:bg-white"><div className="text-slate-500">Expires</div><div className="font-bold">{sub.expiresAt || 'Unknown'}</div></div>
                <div className="rounded-2xl bg-black/20 p-3 light:bg-white"><div className="text-slate-500">Connections</div><div className="font-bold">{formatConnections(sub.activeConnections, sub.maxConnections)}</div></div>
                <div className="rounded-2xl bg-black/20 p-3 light:bg-white"><div className="text-slate-500">Source</div><div className="font-bold uppercase">{sub.type}</div></div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => startEdit(sub)} className="btn-secondary">Edit</button>
                <button onClick={() => setDefault(sub)} className="btn-secondary"><CheckCircle2 size={15} /> Default</button>
                <button onClick={() => refreshInfo(sub)} className="btn-secondary"><RefreshCw size={15} /> Refresh info</button>
                <button onClick={() => refreshInfo(sub)} className="btn-secondary"><Info size={15} /> Info</button>
                <button onClick={() => remove(sub)} className="btn-danger"><Trash2 size={15} /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
