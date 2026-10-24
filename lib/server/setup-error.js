// When the server can't start (a setting is missing or in the wrong format), say which setting,
// so it can be fixed in Vercel. These messages name settings, never their values.
export function setupErrorResponse(err) {
  console.error('Server setup problem:', err);
  const known = /^(Set |APP_URL|APP_ENCRYPTION_KEY|SUPABASE_SECRET_KEY|DATABASE_URL)/.test(String(err?.message));
  return Response.json(
    { error: known ? `Server setup problem: ${err.message}` : 'Server setup problem. Check the Logs tab in Vercel.' },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}
