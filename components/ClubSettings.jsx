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
  const [charges, setCharges] = useState([]);

  // Payment requests from the app provider (set-up fees, one-off charges)
  useEffect(() => { api('/api/club/charges').then(setCharges).catch(() => {}); }, [club.id, club.status]);

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
  const price = club.subscription?.priceNzd;
  const setupFee = club.subscription?.setupFeeNzd || 0;
  const priceText = price != null ? `$${Number(price).toFixed(2)} a month` : 'a monthly fee';
  const setupText = setupFee > 0 ? ` + $${Number(setupFee).toFixed(2)} set-up` : '';
  const openCharges = charges.filter((c) => c.status === 'open');
  const paidCharges = charges.filter((c) => c.status === 'paid');
  const payCharge = (url) => {
    if (!/^https:\/\//.test(String(url))) { showFlash("Couldn't open the secure Stripe page. Please try again."); return; }
    window.location.href = url;
  };

  return (
    <div className="space-y-4">
      {/* ---------- Subscription ---------- */}
      <div className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><CreditCard size={14} /> Club Subscription</h3>
        {status === 'preview' && (
          <>
            <p className="text-xs text-slate-600">You're previewing the app with sample data. Subscribe for {priceText} to start using it with your own club{setupFee > 0 ? `, plus a one-off set-up fee of $${Number(setupFee).toFixed(2)} with the first payment` : ''}. You can cancel any time.</p>
            <button type="button" onClick={() => goTo('/api/club/subscribe', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>{busy ? 'Opening secure checkout…' : `Subscribe · ${priceText}${setupText}`}</button>
          </>
        )}
        {status === 'active' && (
          <>
            <p className="text-xs text-slate-600">Subscribed at {priceText}{renews ? ` · ${club.subscription.cancelAtPeriodEnd ? 'ends' : 'renews'} on ${renews}` : ''}.</p>
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
            <button type="button" onClick={() => goTo('/api/club/subscribe', setBusy, showFlash, onRefresh)} disabled={busy !== ''} className={`w-full ${btn}`}>Resubscribe · {priceText}{setupText}</button>
          </>
        )}
        {status === 'comped' && <p className="text-xs text-emerald-700">Your club has free access from the app provider. Nothing to pay.</p>}
        {status === 'suspended' && <p className="text-xs text-rose-700">Your club's access has been switched off. Please contact the app provider.</p>}
      </div>

      {/* ---------- Payment requests from the app provider ---------- */}
      {charges.length > 0 && (
        <div className={card}>
          <h3 className="font-semibold text-sm flex items-center gap-1.5"><CreditCard size={14} /> Payments to the App Provider</h3>
          {openCharges.length > 0 && <p className="text-xs text-slate-600">You've been sent {openCharges.length === 1 ? 'a payment request' : `${openCharges.length} payment requests`}.</p>}
          {openCharges.map((c) => (
            <div key={c.id} className="p-2.5 rounded-lg border border-amber-200 bg-amber-50 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{c.description}</p>
                  <p className="text-[11px] text-slate-500">${Number(c.amountNzd).toFixed(2)} · sent {new Date(c.createdAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}{c.reference ? ` · ref ${c.reference}` : ''}</p>
                </div>
                {c.payUrl && <button type="button" onClick={() => payCharge(c.payUrl)} className={`${btn} shrink-0`}>Pay ${Number(c.amountNzd).toFixed(2)} by card</button>}
              </div>
              {c.bank && (
                <div className="text-[11px] text-slate-700 bg-white rounded-md border border-amber-100 p-2 space-y-0.5">
                  <p className="font-semibold">{c.payUrl ? 'Or pay by bank transfer' : 'Pay by bank transfer'}</p>
                  <p>Account name: <span className="font-medium select-all">{c.bank.accountName}</span></p>
                  <p>Account number: <span className="font-mono font-medium select-all">{c.bank.accountNumber}</span></p>
                  <p>Reference: <span className="font-mono font-medium select-all">{c.reference}</span></p>
                  {c.bank.instructions && <p className="text-slate-500">{c.bank.instructions}</p>}
                </div>
              )}
            </div>
          ))}
          {paidCharges.length > 0 && (
            <ul className="text-[11px] text-slate-500 space-y-0.5">
              {paidCharges.slice(0, 5).map((c) => <li key={c.id}>✓ {c.description} · ${Number(c.amountNzd).toFixed(2)} paid {c.paidAt ? new Date(c.paidAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</li>)}
            </ul>
          )}
        </div>
      )}

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

// ---------- How parents pay the club (coach and treasurer) ----------

export function PaymentMethodsCard({ club, onClubChange, showFlash, demo = false }) {
  const p = club.payments || {};
  const [form, setForm] = useState({
    card: p.card !== false, bank: Boolean(p.bank), defaultMethod: p.defaultMethod === 'card' ? 'card' : 'bank',
    bankAccountName: p.bank?.accountName || '', bankAccountNumber: p.bank?.accountNumber || '', instructions: p.bank?.instructions || '',
  });
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (demo) { // the sales demo: change the pretend club only, nothing is sent
      const bank = form.bank ? { accountName: form.bankAccountName || `${club.name} Inc`, accountNumber: form.bankAccountNumber || '12-3456-0123456-00', instructions: form.instructions } : null;
      onClubChange({ ...club, payments: { ...club.payments, card: form.card, bank, defaultMethod: form.defaultMethod } });
      showFlash('Payment options saved (demo)');
      return;
    }
    setSaving(true);
    try {
      const res = await api('/api/club/payment-methods', { method: 'PUT', body: form });
      onClubChange({ ...club, payments: { ...club.payments, ...res.payments } });
      showFlash('Payment options saved');
    } catch (err) {
      showFlash(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className={card}>
      <h3 className="font-semibold text-sm flex items-center gap-1.5"><CreditCard size={14} /> How Parents Pay</h3>
      <p className="text-xs text-slate-500">You decide how each family pays; parents can't change it. Brothers and sisters share one payment and one reference.</p>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={form.card} onChange={(e) => setForm({ ...form, card: e.target.checked })} />
        <span className="text-xs">
          <span className="font-semibold text-sm text-slate-800">Card, through Stripe</span>
          <span className="block text-slate-500">Automatic and marked paid by itself. Stripe keeps a small fee from each payment (about 2.7% + 30c).{!club.payments?.connected ? ' Needs your club\'s Stripe account connected (below).' : ''}</span>
        </span>
      </label>

      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.checked })} />
        <span className="text-xs">
          <span className="font-semibold text-sm text-slate-800">Bank transfer</span>
          <span className="block text-slate-500">No fees. Parents see your account and a reference for their family, and can set up a free automatic payment in their banking app. You tick payments off as they arrive.</span>
        </span>
      </label>

      {form.bank && (
        <div className="space-y-2 pl-6">
          <label className="block text-xs text-slate-500">Account name
            <input required maxLength={80} value={form.bankAccountName} onChange={(e) => setForm({ ...form, bankAccountName: e.target.value })} placeholder="e.g. Riverside Rugby Club Inc" className={field} />
          </label>
          <label className="block text-xs text-slate-500">Account number
            <input required inputMode="numeric" value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} placeholder="12-3456-0123456-00" className={field} />
          </label>
          <label className="block text-xs text-slate-500">Note for parents (optional)
            <input maxLength={200} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="e.g. Please use your family reference" className={field} />
          </label>
        </div>
      )}

      {form.card && form.bank && (
        <label className="block text-xs text-slate-500">New families pay by
          <select value={form.defaultMethod} onChange={(e) => setForm({ ...form, defaultMethod: e.target.value })} className={field}>
            <option value="bank">Bank transfer</option>
            <option value="card">Card (Stripe)</option>
          </select>
          <span className="block text-[11px] text-slate-400 mt-1">You can change any family in Finance → Payment Reconciliation.</span>
        </label>
      )}

      {!form.card && !form.bank && <p className="text-xs text-amber-700">Choose at least one way to pay.</p>}
      <button type="submit" disabled={saving || (!form.card && !form.bank)} className={`w-full ${btn}`}>{saving ? 'Saving…' : 'Save payment options'}</button>
    </form>
  );
}
