import React, { useState, useEffect } from 'react';
import { Shield, LogOut, Plus, Gift, Ban, RotateCcw, Copy, Check, Search } from './icons';
import { api } from './api';
import { AccountSecurity } from './AuthScreens';

// The platform owner's screen: every club, its subscription, free access and switching clubs off.
// It deliberately shows no member names, contact details or medical information.

const STATUS = {
  preview: ['Previewing', 'bg-slate-100 text-slate-600'],
  active: ['Paying', 'bg-emerald-50 text-emerald-700'],
  comped: ['Free', 'bg-indigo-50 text-indigo-700'],
  past_due: ['Payment failed', 'bg-amber-50 text-amber-700'],
  canceled: ['Cancelled', 'bg-slate-200 text-slate-600'],
  suspended: ['Switched off', 'bg-rose-50 text-rose-700'],
};
const SPORTS = ['Swimming', 'Football', 'Rugby', 'Netball', 'Basketball', 'Hockey', 'Cricket', 'Athletics', 'Gymnastics', 'Tennis', 'Dance', 'Martial arts', 'Cycling', 'Rowing', 'Other'];
const field = 'w-full mt-1 p-2 border border-slate-200 rounded-lg text-sm bg-white';
const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100';

export function OwnerConsole({ user, signOut, updateUser }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [form, setForm] = useState(null);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('clubs');
  const [deleting, setDeleting] = useState(null); // { id, name, typed }

  const showFlash = (m) => { setFlash(m); setTimeout(() => setFlash(''), 3500); };
  const load = () => api('/api/owner/clubs').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const setAccess = async (club, access) => {
    const key = `${access}-${club.id}`;
    if (access !== 'free' && confirm !== key) { setConfirm(key); return; }
    setConfirm(null);
    try {
      await api(`/api/owner/clubs/${club.id}/access`, { method: 'POST', body: { access } });
      showFlash(access === 'free' ? `${club.name} now has free access` : access === 'suspend' ? `${club.name} is switched off` : `${club.name} is back on its normal subscription`);
      load();
    } catch (e) { showFlash(e.message); }
  };

  const deleteClub = async () => {
    try {
      await api(`/api/owner/clubs/${deleting.id}/delete`, { method: 'POST', body: { confirmName: deleting.typed } });
      showFlash(`${deleting.name} and all its data have been deleted`);
      setDeleting(null);
      load();
    } catch (e) { showFlash(e.message); }
  };

  const createClub = async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/owner/clubs', { method: 'POST', body: form });
      setCreated({ email: form.email, url: res.inviteUrl, emailed: res.emailed });
      setForm(null);
      load();
    } catch (err) { showFlash(err.message); }
  };

  const clubs = (data?.clubs || []).filter((c) => !query || `${c.name} ${c.sport} ${c.contact?.email || ''}`.toLowerCase().includes(query.toLowerCase()));
  const counts = (data?.clubs || []).reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});
  const monthly = (counts.active || 0) * (data?.priceNzd || 0);

  return (
    <div className="relative flex flex-col h-screen bg-slate-50 text-slate-800 font-sans max-w-md mx-auto shadow-2xl overflow-hidden border border-slate-200">
      <header className="bg-slate-900 text-white px-5 py-4 flex justify-between items-center">
        <div>
          <h1 className="font-bold text-lg flex items-center gap-1.5"><Shield size={18} /> Owner Console</h1>
          <p className="text-xs text-slate-300">{user.name || user.email}</p>
        </div>
        <button type="button" onClick={() => signOut(false)} className="bg-slate-700 p-2 rounded-full" aria-label="Sign out" title="Sign out"><LogOut size={20} /></button>
      </header>
      {flash && <div className="absolute top-20 left-4 right-4 z-20 bg-slate-900 text-white text-xs px-3 py-2 rounded-lg shadow-lg flex items-center gap-2"><Check size={14} /> {flash}</div>}

      <div className="flex border-b border-slate-200 bg-white">
        {[['clubs', 'Clubs'], ['account', 'My account']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`flex-1 py-2.5 text-sm font-medium ${tab === k ? 'text-slate-900 border-b-2 border-slate-900' : 'text-slate-500'}`}>{label}</button>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto p-4 space-y-3">
        {tab === 'account' && <AccountSecurity user={user} onUserChange={updateUser} signOut={signOut} showFlash={showFlash} />}

        {tab === 'clubs' && (
          <>
            {error && <div className="text-sm text-rose-700 bg-rose-50 p-3 rounded-lg">{error}</div>}
            <div className="grid grid-cols-3 gap-2">
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Paying</p><p className="text-lg font-bold text-emerald-600">{counts.active || 0}</p></div>
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Free</p><p className="text-lg font-bold text-indigo-600">{counts.comped || 0}</p></div>
              <div className={`${card} p-3`}><p className="text-[11px] text-slate-400">Previewing</p><p className="text-lg font-bold text-slate-700">{counts.preview || 0}</p></div>
            </div>
            <p className="text-[11px] text-slate-400 px-1">About ${monthly.toFixed(2)} a month from paying clubs at ${Number(data?.priceNzd || 0).toFixed(2)} each (before Stripe fees).</p>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clubs" aria-label="Search clubs" className="w-full pl-8 pr-3 py-2 border border-slate-200 rounded-lg text-sm bg-white" />
              </div>
              {!form && <button type="button" onClick={() => { setCreated(null); setForm({ clubName: '', sport: 'Swimming', name: '', email: '', free: true }); }} className="px-3 bg-slate-900 text-white rounded-lg text-xs font-semibold flex items-center gap-1"><Plus size={12} /> Set up a club</button>}
            </div>

            {form && (
              <form onSubmit={createClub} className={`${card} space-y-2`}>
                <p className="text-sm font-semibold">Set up a club for someone</p>
                <label className="block text-xs text-slate-500">Club name<input required value={form.clubName} onChange={(e) => setForm({ ...form, clubName: e.target.value })} className={field} /></label>
                <label className="block text-xs text-slate-500">Sport
                  <select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={field}>{SPORTS.map((s) => <option key={s}>{s}</option>)}</select>
                </label>
                <label className="block text-xs text-slate-500">Coach's name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} /></label>
                <label className="block text-xs text-slate-500">Coach's email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={field} /></label>
                <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={form.free} onChange={(e) => setForm({ ...form, free: e.target.checked })} /> Free access (no subscription needed)</label>
                <div className="flex gap-2">
                  <button type="submit" className="flex-1 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold">Create club & invite coach</button>
                  <button type="button" onClick={() => setForm(null)} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                </div>
              </form>
            )}

            {created && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
                <p>{created.emailed ? `Invite emailed to ${created.email}. You can also send this link:` : `Send ${created.email} this link. It works once, for 3 days.`}</p>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 p-2 bg-white rounded border border-emerald-200 break-all select-all font-mono text-[11px]">{created.url}</code>
                  <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(created.url); setCopied(true); } catch { /* select it instead */ } }} className="p-2 bg-white rounded border border-emerald-200" aria-label="Copy link">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                </div>
                <button type="button" onClick={() => { setCreated(null); setCopied(false); }} className="font-semibold">Done</button>
              </div>
            )}

            {data && clubs.length === 0 && <p className="text-sm text-slate-500 text-center py-6">{query ? 'No clubs match.' : 'No clubs yet. They appear here as soon as someone signs up.'}</p>}
            {clubs.map((c) => {
              const [label, cls] = STATUS[c.status] || [c.status, 'bg-slate-100 text-slate-600'];
              return (
                <div key={c.id} className={`${card} space-y-2`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{c.name}</p>
                      <p className="text-xs text-slate-500">{c.sport} · {c.athletes} members · {c.users} accounts</p>
                      <p className="text-xs text-slate-400 truncate">{c.contact ? `${c.contact.name || 'Coach'} · ${c.contact.email}` : 'No coach yet'}</p>
                      <p className="text-[11px] text-slate-400">Joined {new Date(c.createdAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}{c.renewsOn ? ` · renews ${c.renewsOn}` : ''}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${cls}`}>{label}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.status !== 'comped' && <button type="button" onClick={() => setAccess(c, 'free')} className="text-[11px] bg-indigo-50 text-indigo-700 px-2 py-1 rounded-md font-medium flex items-center gap-1"><Gift size={11} /> Give free access</button>}
                    {['comped', 'suspended'].includes(c.status) && (
                      <button type="button" onClick={() => setAccess(c, 'normal')} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${confirm === `normal-${c.id}` ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>
                        <RotateCcw size={11} /> {confirm === `normal-${c.id}` ? 'Tap again: back to paying' : 'Back to normal subscription'}
                      </button>
                    )}
                    <button type="button" onClick={() => setDeleting({ id: c.id, name: c.name, typed: '' })} className="text-[11px] px-2 py-1 rounded-md font-medium bg-slate-100 text-rose-700">Delete club…</button>
                    {c.status !== 'suspended' && (
                      <button type="button" onClick={() => setAccess(c, 'suspend')} className={`text-[11px] px-2 py-1 rounded-md font-medium flex items-center gap-1 ${confirm === `suspend-${c.id}` ? 'bg-rose-600 text-white' : 'bg-slate-100 text-rose-700'}`}>
                        <Ban size={11} /> {confirm === `suspend-${c.id}` ? 'Tap again to switch off' : 'Switch off'}
                      </button>
                    )}
                  </div>
                  {deleting && deleting.id === c.id && (
                    <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg space-y-2">
                      <p className="text-xs text-rose-900">This permanently deletes {c.name}: every account, member, medical record, group, booking and ledger entry. Their subscription is cancelled. It can't be undone.</p>
                      <label className="block text-xs text-rose-900">Type <b>{c.name}</b> to confirm
                        <input value={deleting.typed} onChange={(e) => setDeleting({ ...deleting, typed: e.target.value })} className={field} aria-label="Club name to confirm" />
                      </label>
                      <div className="flex gap-2">
                        <button type="button" onClick={deleteClub} disabled={deleting.typed !== c.name} className="flex-1 py-2 bg-rose-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">Delete for good</button>
                        <button type="button" onClick={() => setDeleting(null)} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
