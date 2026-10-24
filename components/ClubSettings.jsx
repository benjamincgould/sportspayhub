import React, { useState, useEffect } from 'react';
import { Palette, CreditCard, Check, Image as ImageIcon, Trash2, ExternalLink } from './icons';
import { api } from './api';
import { BRAND_COLOURS, applyBrandColour } from './brand';

const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100 space-y-3 text-sm';
const field = 'w-full mt-1 p-2 border border-slate-200 rounded-lg text-sm bg-white';
const btn = 'py-2.5 px-3 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1';
const chip = (on) => `px-2.5 py-1 rounded-full text-[11px] font-medium border ${on ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`;

const SPORTS = ['Swimming', 'Football', 'Rugby', 'Netball', 'Basketball', 'Hockey', 'Cricket', 'Athletics', 'Gymnastics', 'Tennis', 'Dance', 'Martial arts', 'Cycling', 'Rowing', 'Other'];
const GROUP_WORDS = ['Squad', 'Team', 'Group', 'Class', 'Crew'];
const MEMBER_WORDS = ['Athlete', 'Player', 'Swimmer', 'Member', 'Student'];

// Shrinks an uploaded logo to at most 256px and saves it as PNG (or WebP if PNG is too big)
function resizeLogo(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('Choose a PNG, JPG or WebP image.')); return; }
    if (file.size > 8 * 1024 * 1024) { reject(new Error('That image is very large. Choose one under 8 MB.')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file doesn't look like an image."));
      img.onload = () => {
        const scale = Math.min(1, 256 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL('image/png');
        if (url.length > 260000) url = canvas.toDataURL('image/webp', 0.85);
        if (url.length > 260000) { reject(new Error('That logo is still too detailed. Try a simpler image.')); return; }
        resolve(url);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Opens the Stripe page the server prepares. (The click-through demo has no Stripe, so its
// pretend server finishes straight away and sends a message instead of a page.)
const goTo = async (path, setBusy, showFlash, onRefresh) => {
  setBusy(path);
  try {
    const res = await api(path, { method: 'POST' });
    if (res.url) {
      if (!/^https:\/\//.test(String(res.url))) throw new Error("Couldn't open the secure Stripe page. Please try again.");
      window.location.href = res.url;
      return;
    }
    showFlash(res.message || 'Done');
    onRefresh?.();
  } catch (err) {
    showFlash(err.message);
  }
  setBusy('');
};

export function ClubSettings({ club, onClubChange, showFlash, onRefresh }) {
  const b = club.branding;
  const [form, setForm] = useState({ name: club.name, sport: club.sport, group: b.group, member: b.member, colour: b.colour, logo: b.logo });
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [price, setPrice] = useState(null);

  useEffect(() => { api('/api/platform').then((p) => setPrice(p.priceNzd)).catch(() => {}); }, []);

  const dirty = form.name !== club.name || form.sport !== club.sport || form.group !== b.group || form.member !== b.member || form.colour !== b.colour || form.logo !== b.logo;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { name: form.name, sport: form.sport, group: form.group, member: form.member, colour: form.colour };
      if (form.logo !== b.logo) body.logo = form.logo;
      const res = await api('/api/club', { method: 'PUT', body });
      onClubChange(res.club);
      applyBrandColour(res.club.branding.colour);
      showFlash('Club details saved');
    } catch (err) {
      showFlash(err.message);
    } finally {
      setSaving(false);
    }
  };

  const pickLogo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { setForm((f) => ({ ...f, logo: null })); const logo = await resizeLogo(file); setForm((f) => ({ ...f, logo })); }
    catch (err) { showFlash(err.message); }
  };

  const status = club.status;
  const renews = club.subscription?.renewsOn ? new Date(`${club.subscription.renewsOn}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const priceText = price ? `$${Number(price).toFixed(2)} a month` : 'a monthly fee';

  return (
    <div className="space-y-4">
      {/* ---------- Subscription ---------- */}
      <div className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><CreditCard size={14} /> Club Subscription</h3>
        {status === 'preview' && (
          <>
            <p className="text-xs text-slate-600">You're previewing the app with sample data. Subscribe for {priceText} to start using it with your own club. You can cancel any time.</p>
            <button type="button" onClick={() => goTo('/api/club/subscribe', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>{busy ? 'Opening secure checkout…' : `Subscribe · ${priceText}`}</button>
          </>
        )}
        {status === 'active' && (
          <>
            <p className="text-xs text-slate-600">Subscribed{renews ? ` · ${club.subscription.cancelAtPeriodEnd ? 'ends' : 'renews'} on ${renews}` : ''}.</p>
            {club.subscription?.hasBillingAccount && <button type="button" onClick={() => goTo('/api/club/billing', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn} bg-slate-800`}>Manage billing, card and invoices</button>}
          </>
        )}
        {status === 'past_due' && (
          <>
            <p className="text-xs text-amber-700">Your last payment didn't go through. Update your card to keep using the app.</p>
            <button type="button" onClick={() => goTo('/api/club/billing', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>Update card</button>
          </>
        )}
        {status === 'canceled' && (
          <>
            <p className="text-xs text-slate-600">Your subscription has ended, so the app is look-only. Your club's data is kept.</p>
            <button type="button" onClick={() => goTo('/api/club/subscribe', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>Resubscribe · {priceText}</button>
          </>
        )}
        {status === 'comped' && <p className="text-xs text-emerald-700">Your club has free access from the app provider. Nothing to pay.</p>}
        {status === 'suspended' && <p className="text-xs text-rose-700">Your club's access has been switched off. Please contact the app provider.</p>}
      </div>

      {/* ---------- Parent payments (Stripe Connect) ---------- */}
      {club.canUse && (
        <div className={card}>
          <h3 className="font-semibold text-sm flex items-center gap-1.5"><ExternalLink size={14} /> Online Payments from Parents</h3>
          {club.payments?.connected ? (
            <p className="text-xs text-emerald-700">On. Parents can pay fees and passes by card, and the money goes straight into your club's own Stripe account.</p>
          ) : (
            <>
              <p className="text-xs text-slate-600">Connect your club's own Stripe account so parents can pay fees and passes by card. The money goes into your club's bank account, not ours. Stripe asks for your club's details and bank account.</p>
              <button type="button" onClick={() => goTo('/api/club/connect', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>
                {busy === '/api/club/connect' ? 'Opening Stripe…' : club.payments?.started ? 'Finish setting up payments' : 'Connect Stripe'}
              </button>
            </>
          )}
        </div>
      )}

      {/* ---------- Name, words, colour, logo ---------- */}
      <form onSubmit={save} className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><Palette size={14} /> Club Details & Look</h3>
        <label className="block text-xs text-slate-500">Club name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} className={field} required />
        </label>
        <label className="block text-xs text-slate-500">Sport
          <select value={SPORTS.includes(form.sport) ? form.sport : 'Other'} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={field}>
            {SPORTS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>

        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">What do you call your groups?</p>
          <div className="flex flex-wrap gap-1.5">
            {GROUP_WORDS.map((w) => <button key={w} type="button" onClick={() => setForm({ ...form, group: w })} className={chip(form.group === w)}>{w}</button>)}
          </div>
          <input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} maxLength={24} aria-label="Word for groups" className={field} />
        </div>
        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">What do you call your members?</p>
          <div className="flex flex-wrap gap-1.5">
            {MEMBER_WORDS.map((w) => <button key={w} type="button" onClick={() => setForm({ ...form, member: w })} className={chip(form.member === w)}>{w}</button>)}
          </div>
          <input value={form.member} onChange={(e) => setForm({ ...form, member: e.target.value })} maxLength={24} aria-label="Word for members" className={field} />
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">Colour</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Club colour">
            {BRAND_COLOURS.map((c) => (
              <button key={c.name} type="button" role="radio" aria-checked={form.colour === c.name} aria-label={c.label} title={c.label}
                onClick={() => setForm({ ...form, colour: c.name })}
                className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${form.colour === c.name ? 'border-slate-800' : 'border-white shadow'}`}
                style={{ backgroundColor: c.swatch }}>
                {form.colour === c.name && <Check size={14} className="text-white" />}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-slate-500">Logo (PNG, JPG or WebP)</p>
          <div className="flex items-center gap-3">
            {form.logo
              ? <img src={form.logo} alt="Club logo" className="w-14 h-14 object-contain rounded-lg border border-slate-200 bg-white" />
              : <div className="w-14 h-14 rounded-lg border border-dashed border-slate-300 flex items-center justify-center text-slate-400"><ImageIcon size={20} /></div>}
            <label className="px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold cursor-pointer">
              {form.logo ? 'Change' : 'Upload logo'}
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickLogo} className="sr-only" />
            </label>
            {form.logo && <button type="button" onClick={() => setForm({ ...form, logo: null })} className="p-2 text-rose-600" aria-label="Remove logo"><Trash2 size={14} /></button>}
          </div>
        </div>

        <button type="submit" disabled={saving || !dirty || !form.name.trim()} className={`w-full ${btn}`}>{saving ? 'Saving…' : 'Save club details'}</button>
      </form>
    </div>
  );
}
