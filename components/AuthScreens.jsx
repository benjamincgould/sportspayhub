import React, { useState, useEffect, useRef, useContext, createContext } from 'react';
import { Shield, Eye, EyeOff, Copy, Check, ChevronLeft, KeyRound, LogOut, Smartphone, Users, Mail } from './icons';
import { api, onSignedOut } from './api';
import { applyBrandColour } from './brand';

// The platform's name and sign-up options, loaded once from the server
const PlatformContext = createContext({ name: 'Club App', sports: [], signupOpen: true, priceNzd: null });

// ---------- Shared bits ----------

const inputCls = 'w-full mt-1 p-2.5 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const primaryBtn = 'w-full py-3 bg-indigo-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2';
const linkBtn = 'text-sm text-indigo-700 font-medium underline-offset-2 hover:underline';

const copyToClipboard = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

function AuthShell({ title, subtitle, children, onBack, club = null }) {
  const platform = useContext(PlatformContext);
  return (
    <div className="min-h-full flex flex-col bg-slate-50 text-slate-800 font-sans max-w-md mx-auto border-x border-slate-200">
      <header className="bg-indigo-600 text-white px-5 pt-8 pb-6">
        <p className="text-xs uppercase tracking-wider text-indigo-200 font-medium flex items-center gap-1.5">
          {club?.logo ? <img src={club.logo} alt="" className="w-6 h-6 rounded bg-white object-contain" /> : <Shield size={12} />}
          {club?.name || platform.name}
        </p>
        <h1 className="text-xl font-bold mt-2">{title}</h1>
        {subtitle && <p className="text-sm text-indigo-100 mt-1">{subtitle}</p>}
      </header>
      <main className="flex-1 p-5 space-y-4">
        {onBack && <button type="button" onClick={onBack} className="text-sm text-slate-600 flex items-center gap-1"><ChevronLeft size={16} /> Back to sign in</button>}
        {children}
      </main>
    </div>
  );
}

const Alert = ({ tone = 'error', children }) => (
  <div role={tone === 'error' ? 'alert' : 'status'} className={`text-sm rounded-lg p-3 ${tone === 'error' ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'}`}>
    {children}
  </div>
);

function PasswordInput({ id, value, onChange, autoComplete, label }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">{label}</label>
      <div className="relative">
        <input id={id} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} className={`${inputCls} pr-11`} required maxLength={128} />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 mt-0.5 p-1.5 text-slate-500" aria-label={show ? 'Hide password' : 'Show password'}>
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
    </div>
  );
}

const CodeInput = ({ id, value, onChange, recovery }) => (
  <input
    id={id} value={value} onChange={(e) => onChange(recovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
    inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" autoFocus
    placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
    className={`${inputCls} text-center text-2xl tracking-[0.4em] font-mono`} maxLength={recovery ? 12 : 6} required
  />
);

// ---------- Sign in ----------

function LoginScreen({ notice, initialEmail, onResult, onForgot, onSignup }) {
  const [email, setEmail] = useState(initialEmail || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      onResult(await api('/api/auth/login', { method: 'POST', body: { email, password } }));
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Parents, coaches and club staff sign in here.">
      {notice && <Alert tone="info">{notice}</Alert>}
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="login-email" className="text-sm font-medium text-slate-700">Email address</label>
          <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={inputCls} required maxLength={254} />
        </div>
        <PasswordInput id="login-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={busy} className={primaryBtn}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="flex justify-between items-center">
        <button type="button" onClick={() => onForgot(email)} className={linkBtn}>Forgot password?</button>
        <span className="text-xs text-slate-400">Families get an invite from their club</span>
      </div>
      {onSignup && (
        <div className="pt-4 border-t border-slate-200 space-y-2">
          <p className="text-sm text-slate-600">Run a sports club? Set up your own club app.</p>
          <button type="button" onClick={onSignup} className="w-full py-3 bg-white border border-indigo-300 text-indigo-700 rounded-xl text-sm font-semibold">Create your club</button>
        </div>
      )}
    </AuthShell>
  );
}

function SignupScreen({ onBack }) {
  const platform = useContext(PlatformContext);
  const sports = platform.sports?.length ? platform.sports : ['Swimming', 'Football', 'Rugby', 'Netball', 'Other'];
  const [form, setForm] = useState({ clubName: '', sport: '', name: '', email: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      setMessage((await api('/api/signup', { method: 'POST', body: form })).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your club" subtitle="Look around for free with sample data. Subscribe when you're ready to use it." onBack={onBack}>
      {message ? (
        <div className="space-y-3">
          <Alert tone="info">{message}</Alert>
          <p className="text-sm text-slate-600">Open the link in that email to choose your password. You'll then set up two-step verification, so have your phone ready.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="signup-club" className="text-sm font-medium text-slate-700">Club name</label>
            <input id="signup-club" value={form.clubName} onChange={set('clubName')} className={inputCls} required maxLength={80} autoComplete="organization" />
          </div>
          <div>
            <label htmlFor="signup-sport" className="text-sm font-medium text-slate-700">Sport</label>
            <select id="signup-sport" value={form.sport} onChange={set('sport')} className={inputCls} required>
              <option value="" disabled>Choose…</option>
              {sports.map((sp) => <option key={sp}>{sp}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="signup-name" className="text-sm font-medium text-slate-700">Your name</label>
            <input id="signup-name" value={form.name} onChange={set('name')} className={inputCls} required maxLength={80} autoComplete="name" />
          </div>
          <div>
            <label htmlFor="signup-email" className="text-sm font-medium text-slate-700">Your email</label>
            <input id="signup-email" type="email" value={form.email} onChange={set('email')} className={inputCls} required maxLength={254} autoComplete="email" />
          </div>
          {platform.priceNzd && <p className="text-xs text-slate-500">Free to look around. ${Number(platform.priceNzd).toFixed(2)} a month per club to use it, cancel any time.</p>}
          {error && <Alert>{error}</Alert>}
          <button type="submit" disabled={busy} className={primaryBtn}>{busy ? 'Creating…' : 'Create club'}</button>
          <p className="text-[11px] text-slate-400">You'll be the club's first coach. We'll email you a link to confirm your address before anything else.</p>
        </form>
      )}
    </AuthShell>
  );
}

function ForgotScreen({ initialEmail, onBack }) {
  const [email, setEmail] = useState(initialEmail || '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      setMessage((await api('/api/auth/forgot', { method: 'POST', body: { email } })).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one." onBack={onBack}>
      {message ? <Alert tone="info">{message}</Alert> : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="forgot-email" className="text-sm font-medium text-slate-700">Email address</label>
            <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" className={inputCls} required />
          </div>
          {error && <Alert>{error}</Alert>}
          <button type="submit" disabled={busy} className={primaryBtn}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </AuthShell>
  );
}

// ---------- Two-step verification ----------

function MfaVerifyScreen({ user, onDone, onRestart }) {
  const platform = useContext(PlatformContext);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      onDone(await api('/api/auth/2fa/verify', { method: 'POST', body: { code, recovery } }));
    } catch (err) {
      if (err.signedOut) return onRestart(err.message);
      setError(err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Enter your code" subtitle={`Signing in as ${user.email}`} onBack={() => onRestart('')}>
      <form onSubmit={submit} className="space-y-4">
        <label htmlFor="mfa-code" className="text-sm text-slate-600 block">
          {recovery ? 'Enter one of the recovery codes you saved when you set up two-step verification.' : `Open your authenticator app and enter the 6-digit code for ${platform.name}.`}
        </label>
        <CodeInput id="mfa-code" value={code} onChange={setCode} recovery={recovery} />
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={busy || (!recovery && code.length !== 6)} className={primaryBtn}>{busy ? 'Checking…' : 'Continue'}</button>
      </form>
      <button type="button" onClick={() => { setRecovery(!recovery); setCode(''); setError(''); }} className={linkBtn}>
        {recovery ? 'Use my authenticator app instead' : "Lost your phone? Use a recovery code"}
      </button>
    </AuthShell>
  );
}

// QR code drawn locally (the key never leaves the page); falls back to the typed key if unavailable
function QrCode({ text }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let cancelled = false;
    import('qrcode')
      .then((m) => (m.default || m).toDataURL(text, { margin: 1, width: 200, errorCorrectionLevel: 'M' }))
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [text]);
  return src ? <img src={src} alt="QR code to scan with your authenticator app" width="200" height="200" className="mx-auto rounded-lg border border-slate-200 bg-white" /> : null;
}

export function MfaSetup({ intro, onDone, onCancel, onRestart }) {
  const platform = useContext(PlatformContext);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api('/api/auth/2fa/setup', { method: 'POST' })
      .then(setSetup)
      .catch((err) => (err.signedOut && onRestart ? onRestart(err.message) : setError(err.message)));
  }, [onRestart]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api('/api/auth/2fa/confirm', { method: 'POST', body: { code } });
      onDone(res.user, res.recoveryCodes);
    } catch (err) {
      if (err.signedOut && onRestart) return onRestart(err.message);
      setError(err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const grouped = setup?.secret.match(/.{1,4}/g).join(' ');
  return (
    <div className="space-y-4">
      {intro}
      <ol className="space-y-4 text-sm text-slate-700">
        <li>
          <p className="font-semibold">1. Get an authenticator app</p>
          <p className="text-slate-500">Google Authenticator, Microsoft Authenticator or 1Password all work. They're free.</p>
        </li>
        <li className="space-y-2">
          <p className="font-semibold">2. Add {platform.name} to it</p>
          {setup ? (
            <>
              <QrCode text={setup.uri} />
              <p className="text-slate-500">Scan the code, or on this phone <a href={setup.uri} className="text-indigo-700 font-medium">open your authenticator app</a>, or type this key:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 p-2 bg-slate-100 rounded-lg text-sm font-mono tracking-wide select-all break-all">{grouped}</code>
                <button type="button" onClick={async () => setCopied(await copyToClipboard(setup.secret))} className="p-2 bg-slate-100 rounded-lg" aria-label="Copy key">
                  {copied ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} />}
                </button>
              </div>
            </>
          ) : !error && <p className="text-slate-400">Preparing your key…</p>}
        </li>
        <li>
          <p className="font-semibold">3. Enter the 6-digit code it shows</p>
        </li>
      </ol>
      <form onSubmit={submit} className="space-y-3">
        <CodeInput id="mfa-setup-code" value={code} onChange={setCode} />
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={busy || !setup || code.length !== 6} className={primaryBtn}>{busy ? 'Checking…' : 'Turn on two-step verification'}</button>
        {onCancel && <button type="button" onClick={onCancel} className="w-full py-2 text-sm text-slate-600">Cancel</button>}
      </form>
    </div>
  );
}

export function RecoveryCodes({ codes, onContinue, continueLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">If you lose your phone, each of these codes lets you sign in once. Save them somewhere safe, like a password manager. You won't see them again.</p>
      <ul className="grid grid-cols-2 gap-2 p-3 bg-slate-100 rounded-xl font-mono text-sm select-all">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <button type="button" onClick={async () => setCopied(await copyToClipboard(codes.join('\n')))} className="w-full py-2.5 bg-slate-200 text-slate-800 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
        {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy codes</>}
      </button>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5" />
        I've saved these codes somewhere safe
      </label>
      <button type="button" disabled={!saved} onClick={onContinue} className={primaryBtn}>{continueLabel}</button>
    </div>
  );
}

// ---------- Invite & reset links ----------

function SetPasswordScreen({ token, onDone }) {
  const [info, setInfo] = useState(null);
  const [linkError, setLinkError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(null);

  useEffect(() => {
    api('/api/auth/token', { method: 'POST', body: { token } })
      .then((res) => { setInfo(res); setName(res.name || ''); if (res.club?.colour) applyBrandColour(res.club.colour); })
      .catch((err) => setLinkError(err.message));
  }, [token]);

  const longEnough = password.length >= 12;
  const matches = password.length > 0 && password === confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (!longEnough || !matches) return;
    setBusy(true); setError('');
    try {
      const res = await api('/api/auth/accept', { method: 'POST', body: { token, password, name } });
      setFinished(res.email);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (linkError) {
    return (
      <AuthShell title="Link not working" onBack={() => onDone(null)}>
        <Alert>{linkError}</Alert>
      </AuthShell>
    );
  }
  if (!info) return <AuthShell title="Checking your link…" />;

  if (finished) {
    return (
      <AuthShell title="Password saved" club={info.club}>
        <Alert tone="info">Your password is set for {finished}.</Alert>
        {info.kind === 'invite' && info.mfaRequired && <p className="text-sm text-slate-600">When you sign in, you'll set up two-step verification. Have your phone ready.</p>}
        <button type="button" onClick={() => onDone(finished)} className={primaryBtn}>Sign in</button>
      </AuthShell>
    );
  }

  const isInvite = info.kind === 'invite';
  return (
    <AuthShell title={isInvite ? (info.club ? `Welcome to ${info.club.name}` : 'Welcome to the club app') : 'Choose a new password'} subtitle={info.email} club={info.club}>
      <form onSubmit={submit} className="space-y-4">
        {isInvite && (
          <div>
            <label htmlFor="set-name" className="text-sm font-medium text-slate-700">Your name</label>
            <input id="set-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={inputCls} maxLength={80} />
          </div>
        )}
        {/* Hidden username field so password managers save the right email */}
        <input type="email" value={info.email} autoComplete="username" readOnly hidden />
        <PasswordInput id="set-password" label="New password" value={password} onChange={setPassword} autoComplete="new-password" />
        <PasswordInput id="set-confirm" label="Type it again" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <ul className="text-xs space-y-1">
          <li className={longEnough ? 'text-emerald-700' : 'text-slate-500'}>{longEnough ? '✓' : '•'} At least 12 characters. Three or four random words is easy to remember and hard to guess.</li>
          <li className={matches ? 'text-emerald-700' : 'text-slate-500'}>{matches ? '✓' : '•'} Both entries match</li>
        </ul>
        {error && <Alert>{error}</Alert>}
        <button type="submit" disabled={busy || !longEnough || !matches} className={primaryBtn}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
    </AuthShell>
  );
}

// ---------- First-time set-up: the platform owner's account ----------
// Open /#/setup once, with OWNER_SETUP_SECRET from the server settings. It closes for good once
// an owner account exists.

function OwnerSetupScreen({ onBack }) {
  const [available, setAvailable] = useState(null);
  const [form, setForm] = useState({ secret: '', name: '', email: '' });
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => { api('/api/setup/owner').then((r) => setAvailable(r.available)).catch(() => setAvailable(false)); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      setDone(await api('/api/setup/owner', { method: 'POST', body: form }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (available === null) return <AuthShell title="Loading…" />;
  if (!available && !done) {
    return (
      <AuthShell title="Set-up is closed" onBack={onBack}>
        <Alert tone="info">The owner account already exists, or set-up hasn't been switched on. Sign in instead.</Alert>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create the owner account" subtitle="One-time set-up for the person running the platform" onBack={onBack}>
      {done ? (
        <div className="space-y-3">
          <Alert tone="info">{done.emailed ? `We've emailed ${form.email} a link to choose your password.` : 'Email isn\'t set up, so use this link to choose your password:'}</Alert>
          {done.inviteUrl && <code className="block p-2 bg-slate-100 rounded-lg text-xs break-all select-all">{done.inviteUrl}</code>}
          <p className="text-sm text-slate-600">After choosing a password you'll set up two-step verification. Then remove OWNER_SETUP_SECRET from your settings.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="setup-secret" className="text-sm font-medium text-slate-700">Set-up code (OWNER_SETUP_SECRET)</label>
            <input id="setup-secret" type="password" value={form.secret} onChange={set('secret')} className={inputCls} required autoComplete="off" />
          </div>
          <div>
            <label htmlFor="setup-name" className="text-sm font-medium text-slate-700">Your name</label>
            <input id="setup-name" value={form.name} onChange={set('name')} className={inputCls} maxLength={80} autoComplete="name" />
          </div>
          <div>
            <label htmlFor="setup-email" className="text-sm font-medium text-slate-700">Your email</label>
            <input id="setup-email" type="email" value={form.email} onChange={set('email')} className={inputCls} required maxLength={254} autoComplete="email" />
          </div>
          {error && <Alert>{error}</Alert>}
          <button type="submit" disabled={busy} className={primaryBtn}>{busy ? 'Creating…' : 'Create owner account'}</button>
        </form>
      )}
    </AuthShell>
  );
}

// ---------- The gate in front of the app ----------

const readLinkFromHash = () => {
  if (window.location.hash === '#/setup') return { kind: 'setup' };
  const m = window.location.hash.match(/^#\/(invite|reset)\/([\w-]{20,100})$/);
  return m ? { kind: m[1], token: m[2] } : null;
};

export function AuthGate({ children }) {
  const [session, setSession] = useState({ loading: true, stage: null, user: null });
  const [view, setView] = useState('login'); // 'login' | 'forgot' | 'signup'
  const [platform, setPlatform] = useState({ name: 'Club App', sports: [], signupOpen: true, priceNzd: null });
  const [notice, setNotice] = useState('');
  const [prefill, setPrefill] = useState('');
  const [link, setLink] = useState(null);
  const [newCodes, setNewCodes] = useState(null);

  useEffect(() => {
    // Take any invite/reset token out of the address bar straight away, so it isn't left in history.
    // Also catch links opened while the app is already showing in this tab.
    const takeLink = () => {
      const found = readLinkFromHash();
      if (!found) return;
      setLink(found);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    takeLink();
    window.addEventListener('hashchange', takeLink);
    api('/api/platform').then(setPlatform).catch(() => {});
    api('/api/auth/session')
      .then((s) => setSession({ loading: false, stage: s.stage, user: s.user || null }))
      .catch((err) => { setSession({ loading: false, stage: null, user: null }); setNotice(err.message); });
    onSignedOut(() => {
      setSession({ loading: false, stage: null, user: null });
      setNotice('You were signed out. This happens after a period without activity, or if your password was changed. Please sign in again.');
    });
    return () => window.removeEventListener('hashchange', takeLink);
  }, []);

  const restart = (message) => {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setSession({ loading: false, stage: null, user: null });
    setNotice(message || '');
  };

  const signOut = async (everywhere = false) => {
    try { await api(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST' }); } catch { /* signed out anyway */ }
    setSession({ loading: false, stage: null, user: null });
    setNotice(everywhere ? 'You have been signed out on all devices.' : 'You have signed out.');
  };

  const handleLogin = (res) => {
    setNotice('');
    setSession({ loading: false, stage: res.stage, user: res.user });
  };

  // Signed-out screens use the platform's colour; the club's colour returns after sign-in
  useEffect(() => { if (session.stage !== 'full' && !link) applyBrandColour('indigo'); }, [session.stage, link]);

  const screen = renderScreen();
  return <PlatformContext.Provider value={platform}>{screen}</PlatformContext.Provider>;

  function renderScreen() {
  if (link?.kind === 'setup') return <OwnerSetupScreen onBack={() => setLink(null)} />;
  if (link) {
    return <SetPasswordScreen token={link.token} onDone={(email) => { setLink(null); setView('login'); setPrefill(email || ''); setNotice(email ? 'Sign in with your new password.' : ''); }} />;
  }
  if (session.loading) return <AuthShell title="Loading…" />;

  if (session.stage === 'mfa') {
    return <MfaVerifyScreen user={session.user} onRestart={restart} onDone={(res) => {
      // A recovery code removes the lost authenticator: staff add their new phone straight away
      setSession({ loading: false, stage: res.stage, user: res.user });
      const left = res.recoveryCodesLeft;
      setNotice(res.notice || (left !== undefined && left <= 2 ? `You have ${left} recovery code${left === 1 ? '' : 's'} left. Make new ones in Settings.` : ''));
    }} />;
  }

  if (session.stage === 'mfa_setup') {
    return (
      <AuthShell title="Set up two-step verification" subtitle={session.user.email} onBack={() => restart('')}>
        <MfaSetup
          intro={<>
            {notice && <Alert tone="info">{notice}</Alert>}
            <p className="text-sm text-slate-600">Staff accounts can see medical and payment details, so they need a code from your phone as well as a password.</p>
          </>}
          onRestart={restart}
          onDone={(user, codes) => { setNotice(''); setNewCodes(codes); setSession({ loading: false, stage: 'full', user }); }}
        />
      </AuthShell>
    );
  }

  if (session.stage === 'full' && newCodes) {
    return (
      <AuthShell title="Save your recovery codes" subtitle="Two-step verification is on">
        <RecoveryCodes codes={newCodes} onContinue={() => setNewCodes(null)} continueLabel="Go to the app" />
      </AuthShell>
    );
  }

  if (session.stage === 'full') {
    return children({ user: session.user, signOut, updateUser: (user) => setSession((s) => ({ ...s, user })) });
  }

  if (view === 'forgot') return <ForgotScreen initialEmail={prefill} onBack={() => setView('login')} />;
  if (view === 'signup') return <SignupScreen onBack={() => setView('login')} />;
  return (
    <LoginScreen notice={notice} initialEmail={prefill} onResult={handleLogin}
      onForgot={(email) => { setPrefill(email); setView('forgot'); }}
      onSignup={platform.signupOpen ? () => setView('signup') : null} />
  );
  }
}

// ---------- Settings: my account ----------

export function AccountSecurity({ user, onUserChange, signOut, showFlash }) {
  const [name, setName] = useState(user.name || '');
  const [nameBusy, setNameBusy] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [mode, setMode] = useState(null); // null | 'setup' | 'codes' | 'disable' | 'newcodes'
  const [codes, setCodes] = useState(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const saveName = async (e) => {
    e.preventDefault();
    setNameBusy(true);
    try {
      const res = await api('/api/auth/profile', { method: 'POST', body: { name } });
      onUserChange(res.user);
      setName(res.user.name);
      showFlash('Name saved');
    } catch (err) {
      showFlash(err.message);
    } finally {
      setNameBusy(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) { setPwError("The new passwords don't match."); return; }
    setPwBusy(true); setPwError('');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: pw.current, next: pw.next } });
      setPw({ current: '', next: '', confirm: '' });
      showFlash('Password changed. Other devices have been signed out.');
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwBusy(false);
    }
  };

  const withPassword = async (path, after) => {
    setError('');
    try {
      const res = await api(path, { method: 'POST', body: { password } });
      setPassword('');
      after(res);
    } catch (err) {
      setError(err.message);
    }
  };

  const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100 space-y-3 text-sm';
  return (
    <div className="space-y-4">
      <div className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><KeyRound size={14} /> Your Account</h3>
        <p className="text-xs text-slate-500">Signed in as <span className="font-medium text-slate-700">{user.email}</span> ({user.role})</p>
        <form onSubmit={saveName} className="space-y-2">
          <label htmlFor="acct-name" className="text-sm font-medium text-slate-700">Your name</label>
          <div className="flex gap-2">
            <input id="acct-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className={`${inputCls} mt-0 flex-1`} />
            <button type="submit" disabled={nameBusy || !name.trim() || name.trim() === user.name} className="px-3 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">{nameBusy ? 'Saving…' : 'Save'}</button>
          </div>
          <p className="text-[11px] text-slate-400">This is how the club sees you in the app. Your email stays the same.</p>
        </form>
        <p className="text-sm font-medium text-slate-700 pt-2 border-t border-slate-100">Change password</p>
        <form onSubmit={changePassword} className="space-y-2">
          <input type="email" value={user.email} autoComplete="username" readOnly hidden />
          <PasswordInput id="acct-current" label="Current password" value={pw.current} onChange={(v) => setPw({ ...pw, current: v })} autoComplete="current-password" />
          <PasswordInput id="acct-next" label="New password (12+ characters)" value={pw.next} onChange={(v) => setPw({ ...pw, next: v })} autoComplete="new-password" />
          <PasswordInput id="acct-confirm" label="New password again" value={pw.confirm} onChange={(v) => setPw({ ...pw, confirm: v })} autoComplete="new-password" />
          {pwError && <Alert>{pwError}</Alert>}
          <button type="submit" disabled={pwBusy || !pw.current || pw.next.length < 12} className="w-full py-2.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-50">{pwBusy ? 'Saving…' : 'Change password'}</button>
        </form>
      </div>

      <div className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><Smartphone size={14} /> Two-Step Verification</h3>
        <p className="text-xs text-slate-500">
          {user.mfaEnabled
            ? `On. You'll need a code from your authenticator app when you sign in.${user.mfaRequired ? ' Required for staff accounts.' : ''}`
            : 'Off. Turning it on means a stolen password alone can\'t get into your account.'}
        </p>

        {mode === null && (
          <div className="flex flex-wrap gap-2">
            {!user.mfaEnabled && <button type="button" onClick={() => setMode('setup')} className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold">Turn on</button>}
            {user.mfaEnabled && <button type="button" onClick={() => setMode('newcodes')} className="px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Make new recovery codes</button>}
            {user.mfaEnabled && !user.mfaRequired && <button type="button" onClick={() => setMode('disable')} className="px-3 py-2 bg-slate-100 text-rose-700 rounded-lg text-xs font-semibold">Turn off</button>}
          </div>
        )}

        {mode === 'setup' && (
          <MfaSetup onCancel={() => setMode(null)} onDone={(u, c) => { onUserChange(u); setCodes(c); setMode('codes'); }} />
        )}
        {mode === 'codes' && codes && <RecoveryCodes codes={codes} onContinue={() => { setCodes(null); setMode(null); showFlash('Two-step verification is on'); }} continueLabel="Done" />}

        {(mode === 'disable' || mode === 'newcodes') && (
          <form onSubmit={(e) => {
            e.preventDefault();
            if (mode === 'disable') withPassword('/api/auth/2fa/disable', (res) => { onUserChange(res.user); setMode(null); showFlash('Two-step verification is off'); });
            else withPassword('/api/auth/2fa/recovery-codes', (res) => { setCodes(res.recoveryCodes); setMode('codes'); });
          }} className="space-y-2">
            <input type="email" value={user.email} autoComplete="username" readOnly hidden />
            <PasswordInput id="acct-confirm-pw" label="Enter your password to continue" value={password} onChange={setPassword} autoComplete="current-password" />
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-2">
              <button type="submit" className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold">{mode === 'disable' ? 'Turn off' : 'Make new codes'}</button>
              <button type="button" onClick={() => { setMode(null); setPassword(''); setError(''); }} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
            </div>
          </form>
        )}
      </div>

      <div className={card}>
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><LogOut size={14} /> Sign Out</h3>
        {user.idleMinutes <= 60 && <p className="text-xs text-slate-500">For safety, staff accounts sign out automatically after {user.idleMinutes} minutes without activity.</p>}
        <div className="flex gap-2">
          <button type="button" onClick={() => signOut(false)} className="flex-1 py-2.5 bg-slate-800 text-white rounded-lg text-xs font-semibold">Sign out</button>
          <button type="button" onClick={() => signOut(true)} className="flex-1 py-2.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Sign out everywhere</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Settings: team & family access (staff) ----------

const ACTION_LABELS = {
  login_success: 'Signed in', login_failed: 'Failed sign-in', logout: 'Signed out', logout_all: 'Signed out everywhere',
  mfa_failed: 'Wrong 2-step code', recovery_code_used: 'Used a recovery code', account_locked: 'Account locked',
  '2fa_enabled': 'Turned on 2-step', '2fa_disabled': 'Turned off 2-step', recovery_codes_replaced: 'New recovery codes',
  password_changed: 'Changed password', reset_requested: 'Asked for reset link', password_reset: 'Reset password',
  invite_sent: 'Sent invite', invite_resent: 'Re-sent invite', invite_accepted: 'Accepted invite', parent_linked: 'Linked parent',
  reset_link_created: 'Made reset link', account_disabled: 'Switched off account', account_enabled: 'Switched on account',
  '2fa_reset_by_coach': 'Reset 2-step for someone', parent_links_changed: 'Changed linked athletes',
  athlete_created: 'Added athlete', athlete_updated: 'Edited athlete', profile_updated: 'Parent updated details',
  plan_changed: 'Changed plan', squad_created: 'Added squad', squad_deleted: 'Deleted squad', transaction_added: 'Added transaction',
  checkout_started: 'Started payment', admin_created_from_server: 'Coach created from server',
};

export function TeamAccess({ me, athletes, showFlash, inviteRequest, onInviteHandled, words = { member: 'Athlete', members: 'Athletes' } }) {
  const isCoach = me.role === 'coach';
  const [users, setUsers] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(null);
  const [result, setResult] = useState(null); // { email, url, emailed }
  const [confirm, setConfirm] = useState(null); // `${action}-${id}`
  const [linking, setLinking] = useState(null); // { id, athleteIds }
  const [renaming, setRenaming] = useState(null); // { id, name }
  const [log, setLog] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = () => api('/api/users').then(setUsers).catch((err) => setLoadError(err.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (inviteRequest) { setForm({ role: 'parent', email: '', name: '', athleteIds: [], ...inviteRequest }); onInviteHandled?.(); }
  }, [inviteRequest, onInviteHandled]);

  const athleteName = (id) => athletes.find((a) => a.id === id)?.name || `${words.member} ${id}`;

  const sendInvite = async (e) => {
    e.preventDefault();
    try {
      const res = await api('/api/users/invite', { method: 'POST', body: form });
      setResult({ email: form.email, url: res.inviteUrl, emailed: res.emailed, linked: res.linked });
      setForm(null);
      load();
    } catch (err) {
      showFlash(err.message);
    }
  };

  const linkFor = async (u) => {
    try {
      const res = await api(`/api/users/${u.id}/reset-link`, { method: 'POST' });
      setResult({ email: u.email, url: res.url, emailed: res.emailed, kind: res.kind });
    } catch (err) { showFlash(err.message); }
  };

  const twoTap = async (key, fn) => {
    if (confirm !== key) { setConfirm(key); return; }
    setConfirm(null);
    try { await fn(); load(); } catch (err) { showFlash(err.message); }
  };

  const saveName = async () => {
    try {
      await api(`/api/users/${renaming.id}/name`, { method: 'PUT', body: { name: renaming.name } });
      setRenaming(null);
      load();
      showFlash('Name updated');
    } catch (err) { showFlash(err.message); }
  };

  const saveLinks = async () => {
    try {
      await api(`/api/users/${linking.id}/athletes`, { method: 'PUT', body: { athleteIds: linking.athleteIds } });
      setLinking(null);
      load();
      showFlash('Linked athletes updated');
    } catch (err) { showFlash(err.message); }
  };

  const AthletePicker = ({ value, onChange }) => (
    <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg p-2 space-y-1">
      {[...athletes].sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
        <label key={a.id} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={value.includes(a.id)} onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((x) => x !== a.id))} />
          {a.name}
        </label>
      ))}
    </div>
  );

  const statusChip = (u) => {
    if (u.status === 'disabled') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">Switched off</span>;
    if (u.status === 'invited') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">{u.inviteActive ? 'Invited' : 'Invite expired'}</span>;
    if (u.locked) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">Locked</span>;
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">Active</span>;
  };

  const groups = (isCoach ? ['coach', 'treasurer', 'parent'] : ['parent']).map((role) => ({ role, list: users.filter((u) => u.role === role) }));
  const card = 'bg-white p-4 rounded-xl shadow-sm border border-slate-100 space-y-3 text-sm';
  const field = 'w-full mt-1 p-2 border border-slate-200 rounded-lg text-sm bg-white';

  return (
    <div className={card}>
      <div className="flex justify-between items-center">
        <h3 className="font-semibold text-sm flex items-center gap-1.5"><Users size={14} /> Team & Family Access</h3>
        {isCoach && !form && <button type="button" onClick={() => { setResult(null); setForm({ role: 'parent', email: '', name: '', athleteIds: [] }); }} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1"><Mail size={12} /> Invite</button>}
      </div>
      {loadError && <Alert>{loadError}</Alert>}

      {form && (
        <form onSubmit={sendInvite} className="p-3 bg-slate-50 rounded-lg space-y-2">
          <p className="text-xs font-semibold text-slate-700">Invite someone</p>
          <label className="block text-xs text-slate-500">Email
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={field} />
          </label>
          <label className="block text-xs text-slate-500">Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} />
          </label>
          {isCoach && (
            <label className="block text-xs text-slate-500">Access
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={field}>
                <option value="parent">Parent / guardian — their own children only</option>
                <option value="treasurer">Treasurer — payments, reports, contact details</option>
                <option value="coach">Coach — everything, including medical details</option>
              </select>
            </label>
          )}
          {form.role === 'parent' && (
            <div className="text-xs text-slate-500">Which {words.members.toLowerCase()} are theirs? Tick all their children.
              <AthletePicker value={form.athleteIds} onChange={(ids) => setForm({ ...form, athleteIds: ids })} />
            </div>
          )}
          {form.role !== 'parent' && <p className="text-[11px] text-amber-700">Staff will set up two-step verification the first time they sign in.</p>}
          <div className="flex gap-2">
            <button type="submit" className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-semibold">Send invite</button>
            <button type="button" onClick={() => setForm(null)} className="flex-1 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
          </div>
        </form>
      )}

      {result && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
          {result.linked ? <p>{result.email} already has an account, so the {words.members.toLowerCase()} were added to it. Nothing else to do.</p> : !result.url ? (
            <p>
              {result.kind === 'reset'
                ? `We've emailed ${result.email} a link to choose a new password. For their safety, only they receive it. It works for 1 hour.`
                : `We've emailed ${result.email} their invite. It works for 3 days.`}
              {!result.emailed && ' If it doesn\'t arrive, check the email address is right.'}
            </p>
          ) : (
            <>
              <p>{`Email isn't set up yet, so send ${result.email} this link yourself. It works once, for 3 days.`}</p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 p-2 bg-white rounded border border-emerald-200 break-all select-all font-mono text-[11px]">{result.url}</code>
                <button type="button" onClick={async () => setCopied(await copyToClipboard(result.url))} className="p-2 bg-white rounded border border-emerald-200" aria-label="Copy link">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
              </div>
              <p className="text-[11px] text-emerald-800">Only send it to the person it's for. Anyone with the link can set the password.</p>
            </>
          )}
          <button type="button" onClick={() => { setResult(null); setCopied(false); }} className="text-emerald-900 font-semibold">Done</button>
        </div>
      )}

      {groups.map(({ role, list }) => (
        <section key={role} className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 pt-1">{role === 'parent' ? 'Families' : role === 'coach' ? 'Coaches' : 'Treasurer'} · {list.length}</p>
          {list.length === 0 && <p className="text-xs text-slate-400">No accounts yet.</p>}
          {list.map((u) => (
            <div key={u.id} className="py-2 border-t border-slate-50 space-y-1.5">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{u.name || u.email}</p>
                  <p className="text-xs text-slate-400 truncate">{u.email}</p>
                  {role === 'parent' && (
                    <p className="text-xs text-slate-500">
                      {u.athleteIds.length ? `${u.athleteIds.length === 1 ? 'Child' : `${u.athleteIds.length} children`}: ${u.athleteIds.map(athleteName).join(', ')}` : `No ${words.members.toLowerCase()} linked yet`}
                    </p>
                  )}
                  <p className="text-[11px] text-slate-400">{u.lastLoginAt ? `Last signed in ${new Date(u.lastLoginAt).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}` : 'Never signed in'}{u.mfaEnabled ? ' · 2-step on' : ''}</p>
                </div>
                {statusChip(u)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {u.status !== 'disabled' && <button type="button" onClick={() => linkFor(u)} className="text-[11px] bg-slate-100 text-slate-700 px-2 py-1 rounded-md font-medium">{u.status === 'invited' ? 'Re-send invite' : 'Email a password reset'}</button>}
                {isCoach && role === 'parent' && <button type="button" onClick={() => { setRenaming(null); setLinking({ id: u.id, athleteIds: u.athleteIds }); }} className="text-[11px] bg-slate-100 text-slate-700 px-2 py-1 rounded-md font-medium">Add or remove children</button>}
                {(isCoach || role === 'parent') && <button type="button" onClick={() => { setLinking(null); setRenaming({ id: u.id, name: u.name || '' }); }} className="text-[11px] bg-slate-100 text-slate-700 px-2 py-1 rounded-md font-medium">Edit name</button>}
                {isCoach && u.id !== me.id && u.mfaEnabled && (
                  <button type="button" onClick={() => twoTap(`mfa-${u.id}`, () => api(`/api/users/${u.id}/reset-2fa`, { method: 'POST' }).then(() => showFlash('Two-step reset. They\'ll set it up again when they sign in.')))} className={`text-[11px] px-2 py-1 rounded-md font-medium ${confirm === `mfa-${u.id}` ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-700'}`}>
                    {confirm === `mfa-${u.id}` ? 'Tap again to reset 2-step' : 'Lost phone: reset 2-step'}
                  </button>
                )}
                {isCoach && u.id !== me.id && (
                  <button type="button" onClick={() => twoTap(`status-${u.id}`, () => api(`/api/users/${u.id}/status`, { method: 'POST', body: { status: u.status === 'disabled' ? 'active' : 'disabled' } }))} className={`text-[11px] px-2 py-1 rounded-md font-medium ${confirm === `status-${u.id}` ? 'bg-rose-600 text-white' : 'bg-slate-100 text-rose-700'}`}>
                    {confirm === `status-${u.id}` ? 'Tap again to confirm' : u.status === 'disabled' ? 'Switch on' : 'Switch off'}
                  </button>
                )}
                {isCoach && u.id !== me.id && u.status !== 'active' && (
                  <button type="button" onClick={() => twoTap(`delete-${u.id}`, () => api(`/api/users/${u.id}`, { method: 'DELETE' }).then(() => showFlash(u.status === 'invited' ? 'Invite cancelled' : 'Account deleted')))} className={`text-[11px] px-2 py-1 rounded-md font-medium ${confirm === `delete-${u.id}` ? 'bg-rose-600 text-white' : 'bg-slate-100 text-rose-700'}`}>
                    {confirm === `delete-${u.id}` ? 'Tap again: delete for good' : u.status === 'invited' ? 'Cancel invite' : 'Delete account'}
                  </button>
                )}
              </div>
              {renaming && renaming.id === u.id && (
                <div className="flex gap-2 p-2 bg-slate-50 rounded-lg">
                  <input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} maxLength={80} aria-label={`Name for ${u.email}`} className={`${field} mt-0 flex-1`} />
                  <button type="button" onClick={saveName} disabled={!renaming.name.trim()} className="px-3 bg-indigo-600 text-white rounded-lg text-xs font-semibold disabled:opacity-40">Save</button>
                  <button type="button" onClick={() => setRenaming(null)} className="px-3 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                </div>
              )}
              {linking && linking.id === u.id && (
                <div className="space-y-2 p-2 bg-slate-50 rounded-lg">
                  <p className="text-[11px] text-slate-500">Tick every child this parent should see. Siblings can share one parent account.</p>
                  <AthletePicker value={linking.athleteIds} onChange={(ids) => setLinking({ ...linking, athleteIds: ids })} />
                  <div className="flex gap-2">
                    <button type="button" onClick={saveLinks} className="flex-1 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold">Save</button>
                    <button type="button" onClick={() => setLinking(null)} className="flex-1 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}

      {isCoach && (
        <div className="pt-1">
          <button type="button" onClick={() => (log ? setLog(null) : api('/api/audit').then(setLog).catch((err) => showFlash(err.message)))} className="text-xs text-indigo-700 font-medium">
            {log ? 'Hide activity log' : 'Show activity log'}
          </button>
          {log && (
            <ul className="mt-2 max-h-64 overflow-y-auto text-[11px] divide-y divide-slate-50">
              {log.slice(0, 100).map((e) => (
                <li key={e.id} className="py-1.5 flex justify-between gap-2">
                  <span className="min-w-0">
                    <span className={`font-medium ${['login_failed', 'mfa_failed', 'account_locked'].includes(e.action) ? 'text-rose-700' : 'text-slate-700'}`}>{ACTION_LABELS[e.action] || e.action}</span>
                    <span className="text-slate-400"> · {e.userEmail || e.detail?.email || 'unknown'}</span>
                  </span>
                  <span className="text-slate-400 shrink-0">{new Date(e.at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
