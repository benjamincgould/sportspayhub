// When the server can't start (a setting is missing or in the wrong format), say which setting,
// so it can be fixed in Vercel. These messages name settings, never their values.
export function setupErrorResponse(err) {
  console.error('Server setup problem:', err);
  const msg = String(err?.message || '');
  let text;
  if (/^(Set |APP_URL|APP_ENCRYPTION_KEY|SUPABASE_URL|SUPABASE_SECRET_KEY|DATABASE_URL)/.test(msg)) {
    text = msg;
  } else if (err?.code === 'ERR_INVALID_URL' || /invalid url/i.test(msg)) {
    text = "DATABASE_URL isn't a valid address. Check it starts with postgresql:// and has no [ ] around the password. If your database password has symbols like @ # / ? %, reset it in Supabase (Project Settings → Database) to letters and numbers only, then update DATABASE_URL.";
  } else {
    // Only the kind of error, never its details (which could include a setting's value)
    text = `Unexpected ${err?.name || 'error'}${err?.code ? ` (${String(err.code).slice(0, 40)})` : ''}. Check the Logs tab in Vercel.`;
  }
  return Response.json({ error: `Server setup problem: ${text}` }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
}
