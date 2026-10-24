// Talks to the club server. Same-site only: the session cookie travels automatically,
// and every change carries the X-Club-Request header the server requires.

export class ApiError extends Error {
  constructor(message, status, signedOut = false) {
    super(message);
    this.status = status;
    this.signedOut = signedOut;
  }
}

let signedOutHandler = null;
export const onSignedOut = (fn) => { signedOutHandler = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Club-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Couldn't reach the club server. Check your internet connection and try again.", 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty reply */ }
  if (!res.ok) {
    // A session that ended (timed out, signed out elsewhere) sends everyone back to sign-in
    if (data.signedOut && signedOutHandler && !path.startsWith('/api/auth/')) signedOutHandler();
    throw new ApiError(data.error || `Something went wrong (${res.status}). Please try again.`, res.status, Boolean(data.signedOut));
  }
  return data;
}
