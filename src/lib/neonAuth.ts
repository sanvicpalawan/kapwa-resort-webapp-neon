/**
 * Neon Auth login bridge.
 *
 * The app's original login was `employee-auth` (a Supabase Edge Function):
 * staff entered a NAME + PIN, and the function minted an HS256 JWT carrying
 * `employee_id`, `permissions` and `is_admin`.
 *
 * Neon Auth replaces that with email + password and issues an EdDSA JWT that
 * carries `email` but *no custom claims*. Rather than rewrite the 254 RLS
 * policies that read those claims, `public.jwt_permissions()` was re-pointed to
 * resolve the JWT's `email` to an `employees` row (see the bridge migration).
 * This module is the client half of that bridge: it authenticates against Neon
 * Auth, mints the Data API JWT, and returns the session shape the rest of the
 * app already expects.
 */

import { getStaffToken, isStaffTokenExpired, setStaffToken } from './session';

const AUTH_BASE = import.meta.env.VITE_NEON_AUTH_URL as string;

/**
 * Build an auth URL. The target route travels in a query parameter rather than
 * the path: Vercel's filesystem catch-all for this project only ever matched a
 * single segment, so `/api/auth/sign-in/email` fell through to a 404. Passing
 * the route explicitly matches regardless of how many segments it has.
 */
const authUrl = (route: string) =>
  `${AUTH_BASE}?__path=${encodeURIComponent(route)}`;

// Neon's Data API base. supabase-js appends `/rest/v1` itself, but these raw
// fetches bypass it, so the REST root has to be built here — hitting the base
// without it resolves to /neondb/rpc/... and 404s on preflight, which leaves
// the permission list empty and the login gate denying access.
const DATA_API_URL = import.meta.env.VITE_NEON_DATA_API_URL as string;
const REST_ROOT = DATA_API_URL ? `${DATA_API_URL.replace(/\/$/, '')}/rest/v1` : '';

export interface NeonLoginResult {
  ok: boolean;
  error?: string;
  /** EdDSA JWT accepted by the Neon Data API. Stored in the staff session. */
  token?: string;
  name?: string;
  email?: string;
  employeeId?: string;
  permissions?: string[];
  isAdmin?: boolean;
}

/** Neon Auth validates browser origins; these are the registered domains. */
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';

const authHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(ORIGIN ? { Origin: ORIGIN } : {}),
});

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    return j.message || j.error_description || j.code || text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

/** Sign in with email + password, then mint the Data API JWT. */
export async function neonSignIn(email: string, password: string): Promise<NeonLoginResult> {
  if (!AUTH_BASE) {
    return { ok: false, error: 'VITE_NEON_AUTH_URL is not configured' };
  }

  // 1. Authenticate. Neon Auth sets the session as a Secure, HttpOnly cookie
  //    on its own origin.
  // credentials: 'include' is load-bearing. Neon Auth and the app are on
  // different origins, and fetch defaults to same-origin cookies — without it
  // the Set-Cookie from this response is silently dropped by the browser, so
  // the /token call below arrives with no session and answers 401.
  const res = await fetch(authUrl('sign-in/email'), {
    method: 'POST',
    headers: authHeaders(),
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const msg = await readError(res);
    const friendly =
      /Invalid origin|INVALID_ORIGIN/i.test(msg) ? 'This domain is not authorised for sign-in.'
      : /INVALID_EMAIL|VALIDATION/i.test(msg) ? 'Enter a valid email address.'
      : /password/i.test(msg) ? 'Incorrect email or password.'
      : msg;
    return { ok: false, error: friendly };
  }

  // Neon Auth signs the session as a `__Secure-`/`__Host-` prefixed cookie.
  // `Cookie` is a forbidden header name in browsers, so the header cannot be
  // replayed manually the way a Node client would — the browser attaches the
  // cookie itself, and only when credentials: 'include' is set.
  const tokRes = await fetch(authUrl('token'), {
    headers: authHeaders(),
    credentials: 'include',
  });

  if (!tokRes.ok) {
    return { ok: false, error: `Session established but JWT mint failed (${tokRes.status}).` };
  }

  const tokBody = await tokRes.json().catch(() => ({}));
  const token: string | undefined = tokBody.token ?? tokBody?.data?.token;
  if (!token) return { ok: false, error: 'Neon Auth returned no JWT.' };

  // 3. Resolve staff identity + permissions from Postgres, now that we hold a
  //    JWT RLS will accept. This is what makes `getHomeRoute(permissions)` work.
  let name = '';
  let employeeId: string | undefined;
  let permissions: string[] = [];
  let isAdmin = false;

  try {
    const r = await fetch(`${REST_ROOT}/employees?select=id,name,display_name,email,active&email=eq.${encodeURIComponent(email)}&limit=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (r.ok) {
      const rows = await r.json();
      const emp = rows?.[0];
      if (emp) {
        employeeId = emp.id;
        name = emp.display_name || emp.name || email;
      }
    }
  } catch {
    // Identity lookup is best-effort; RLS still gates every table read.
  }

  // Permissions come from the same bridge RLS uses, so the UI and the database
  // always agree on what this user may see.
  try {
    const r = await fetch(`${REST_ROOT}/rpc/kapwa_my_permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
    if (r.ok) {
      const perms = await r.json();
      if (Array.isArray(perms)) {
        permissions = perms.map(String);
        isAdmin = permissions.includes('admin');
      }
    }
  } catch {
    // Fall through with empty permissions; RLS still applies.
  }

  return { ok: true, token, name: name || email, email, employeeId, permissions, isAdmin };
}

/** End the Neon Auth session server-side. */
export async function neonSignOut(): Promise<void> {
  if (!AUTH_BASE) return;
  try {
    // Always attempt the server-side sign-out. The Neon Auth session cookie is
    // `__Secure-`/HttpOnly, so `document.cookie` cannot see it — a presence
    // check there is permanently false and would skip revocation every time,
    // leaving a valid 7-day server session behind after the user logs out.
    await fetch(authUrl('sign-out'), { method: 'POST', headers: authHeaders(), credentials: 'include' });
  } catch {
    // Local session clearing is what actually gates the UI; ignore network errors.
  }
}

/**
 * Mint a fresh Data API JWT from the still-live Neon Auth session cookie.
 *
 * `/token` issues a **15-minute** JWT, but the session cookie behind it lasts
 * **7 days**. An app that mints only during sign-in therefore stops being able
 * to talk to the database 15 minutes later, while the user is still visibly
 * signed in — every request401s until they log in again. Re-minting here keeps
 * a long-lived tab working without a re-login.
 */
export async function refreshStaffToken(): Promise<string | null> {
  if (!AUTH_BASE) return null;
  try {
    const res = await fetch(authUrl('token'), { headers: authHeaders(), credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const token: string | undefined = body.token ?? body?.data?.token;
    if (!token) return null;
    setStaffToken(token);
    return token;
  } catch {
    return null;
  }
}

/**
 * The token a request should carry: the stored one when it is still valid,
 * otherwise a newly minted one. Falls back to the stored token when minting
 * fails, so the caller gets the server's own 401 rather than a silent empty
 * header that would be indistinguishable from being signed out.
 */
export async function ensureStaffToken(): Promise<string | null> {
  const current = getStaffToken();
  // No stored staff session means this caller is a guest; minting would only
  // send a request Neon Auth is guaranteed to refuse.
  if (!current) return null;
  if (!isStaffTokenExpired()) return current;
  return (await refreshStaffToken()) ?? current;
}
