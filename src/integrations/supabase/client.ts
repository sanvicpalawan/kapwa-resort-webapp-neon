import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { getStaffToken } from '@/lib/session';

/**
 * Neon Data API (PostgREST-compatible) client.
 *
 * This replaces the Supabase client. The app's 257 `.from(...)` call sites are
 * unchanged: Neon's Data API speaks the same PostgREST wire protocol, so only
 * the endpoint and the credential differ.
 *
 * Auth model:
 *   - Every request must carry a Neon Auth JWT as `Authorization: Bearer`.
 *     The Data API rejects anonymous requests outright (it is not the Supabase
 *     anon-key model), so there is no "logged out" read path here.
 *   - The JWT is minted at login by `lib/neonAuth.ts` and stored in the staff
 *     session's `token` slot, so `lib/session.ts` and `lib/staffAuth.ts` keep
 *     working as written.
 *   - Row-level security resolves permissions through `public.jwt_permissions()`,
 *     which maps the JWT's `email` claim to an `employees` row.
 */

// Neon injects these at build time via `neon env pull` / Vercel env.
//
// This is the PostgREST BASE, not the full REST root: supabase-js appends
// `/rest/v1` itself when building `.from()` / `.rpc()` URLs. Raw fetches
// (below) must add it manually or they resolve against /neondb/... and 404.
const DATA_API_URL = import.meta.env.VITE_NEON_DATA_API_URL
  ?? import.meta.env.VITE_SUPABASE_URL;
const REST_ROOT = DATA_API_URL ? `${DATA_API_URL.replace(/\/$/, '')}/rest/v1` : '';
const FALLBACK_KEY = import.meta.env.VITE_NEON_PUBLISHABLE_KEY
  ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? 'neon-data-api';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

/**
 * Injects the staff JWT into every request.
 *
 * The Data API requires a valid JWT on *all* endpoints, including RPCs, so this
 * attaches unconditionally rather than waiting for a probe the way the Supabase
 * client did (see the VITE_USE_STAFF_JWT logic in lib/staffAuth.ts). If the
 * token is missing the request is rejected with 401 rather than silently
 * degrading to an anonymous role, which makes a misconfigured login loud.
 */
/**
 * A shared, read-only guest identity. The Data API rejects anonymous requests
 * outright ("required authorization bearer token"), so without a token every
 * pre-login screen — the landing page's resort name and logo, the guest
 * portal's rooms and menu — would read as empty. RLS keeps this safe: the
 * guest maps to no employees row, so jwt_permissions() is [] and only the
 * public-read policies admit it. orders/employees/audit_log all come back
 * empty for this token.
 *
 * Module-scoped rather than closed over by `createNeonFetch`, because the
 * function shim needs the same fallback: the guest concierge runs before any
 * staff login and still has to reach its function signed.
 */
let guestTokenPromise: Promise<string | null> | null = null;
const resolveGuestToken = (): Promise<string | null> => {
  if (!guestTokenPromise) {
    guestTokenPromise = (async () => {
      try {
        const res = await fetch('/api/auth?__path=sign-in%2Femail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            email: import.meta.env.VITE_NEON_GUEST_EMAIL ?? 'guest@kapwa.local',
            password: import.meta.env.VITE_NEON_GUEST_PASSWORD,
          }),
        });
        if (!res.ok) return null;
        const tok = await fetch('/api/auth?__path=token', { credentials: 'include' });
        if (!tok.ok) return null;
        const body = await tok.json().catch(() => ({}));
        return body.token ?? null;
      } catch {
        return null;
      }
    })();
    // A failed mint must not be cached forever; the next request retries.
    guestTokenPromise.then((t) => { if (!t) guestTokenPromise = null; });
  }
  return guestTokenPromise;
};

function createNeonFetch(publishableKey: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    const staffToken = getStaffToken();
    const token = staffToken ?? await resolveGuestToken();
    const url = requestUrl(input);

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    // `apikey` is harmless to the Data API but some proxies expect it; send the
    // publishable key so it is present and stable.
    if (!headers.has('apikey')) headers.set('apikey', publishableKey);

    // Prefer JSON responses; PostgREST defaults to JSON already but be explicit
    // for RPC calls which the app invokes with POST + empty body.
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    // Avoid a preflight for simple RPC POSTs that would otherwise send an empty
    // body with a JSON content type.
    if (init?.method === 'POST' && !url.includes('/rpc/') && !init.body) {
      headers.set('Content-Type', 'application/json');
    }

    return fetch(input, { ...init, headers });
  };
}

export const supabase = createClient<Database>(DATA_API_URL, FALLBACK_KEY, {
  global: {
    fetch: createNeonFetch(FALLBACK_KEY),
  },
  auth: {
    // Neon Auth owns identity; supabase-js's built-in auth manager must stay out
    // of the way or it will try to persist a session this app never creates.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

/* ──────────────────────────────────────────────────────────────────────────
 * Compatibility layer
 *
 * The app was written against supabase-js and uses three capabilities Neon's
 * Data API does not provide:
 *
 *   1. Realtime (`postgres_changes`) — ~20 components subscribe to table
 *      changes to drive live order boards, housekeeping queues and reception
 *      alerts. Neon has no Realtime service. Rather than rewrite every board,
 *      `.channel()` here returns a shim that re-fires the registered handlers
 *      on an interval. It is polling, not push: updates land within
 *      POLL_INTERVAL_MS instead of instantly, and every caller keeps working
 *      unchanged.
 *
 *   2. Storage — Neon exposes S3-compatible Object Storage, not the Supabase
 *      Storage REST API. Uploads are routed through a Neon Function so the
 *      signed-URL handling stays server-side.
 *
 *   3. Edge Functions — Neon Functions have per-function URLs rather than a
 *      single `/functions/v1/` prefix. VITE_NEON_FUNCTIONS_BASE maps a name to
 *      its deployed URL.
 *
 * Degrading these quietly would look like a working app that mysteriously
 * stops updating, so each one reports what it actually did.
 * ────────────────────────────────────────────────────────────────────────── */

/** How often a "Realtime" shim re-fires its handlers. */
const POLL_INTERVAL_MS = 12_000;

type PgChangeHandler = (payload?: unknown) => void;
interface ShimChannel {
  table?: string;
  handlers: PgChangeHandler[];
  timer: ReturnType<typeof setInterval> | null;
}

const channels = new Map<string, ShimChannel>();

function subscribeHandler(channel: ShimChannel) {
  if (channel.timer) return;
  channel.timer = setInterval(() => {
    for (const h of channel.handlers) {
      try { h(); } catch { /* a broken subscriber must not kill the poller */ }
    }
  }, POLL_INTERVAL_MS);
}

function teardownChannel(channel: ShimChannel) {
  if (channel.timer) clearInterval(channel.timer);
  channel.timer = null;
}

/** Realtime shim: `.channel(name).on(type, filter, cb).subscribe()`. */
function shimChannel(name: string) {
  const existing = channels.get(name);
  if (existing) {
    if (existing.timer) subscribeHandler(existing); // no-op, already polling
    return {
      on(_type: string, _filter: unknown, cb: PgChangeHandler) {
        existing.handlers.push(cb);
        return this;
      },
      subscribe() { subscribeHandler(existing); return this; },
    };
  }

  const channel: ShimChannel = { handlers: [], timer: null };
  channels.set(name, channel);

  return {
    on(_type: string, _filter: unknown, cb: PgChangeHandler) {
      channel.handlers.push(cb);
      return this;
    },
    subscribe() { subscribeHandler(channel); return this; },
  };
}

function shimRemoveChannel(channel: unknown): unknown {
  const name = (channel as { topic?: string } | null)?.topic
    ?? (typeof channel === 'string' ? channel : undefined);
  if (name) {
    const c = channels.get(name);
    if (c) { teardownChannel(c); channels.delete(name); }
  }
  return Promise.resolve();
}

/** Storage shim. Real uploads need VITE_NEON_STORAGE_FUNCTION; without it the
 *  call fails loudly rather than silently dropping a guest's ID document. */
const STORAGE_FUNCTION = import.meta.env.VITE_NEON_STORAGE_FUNCTION as string | undefined;

function shimStorage() {
  return {
    from(_bucket: string) {
      return {
        async upload(path: string, file: unknown, _opts?: unknown) {
          if (!STORAGE_FUNCTION) {
            return {
              data: null,
              error: {
                message: 'Object Storage is not configured on this deployment '
                  + '(VITE_NEON_STORAGE_FUNCTION is unset). '
                  + `"${path}" was NOT saved.`,
              },
            };
          }
          try {
            const form = new FormData();
            form.append('bucket', _bucket);
            form.append('path', path);
            form.append('file', file as Blob);
            const res = await fetch(`${STORAGE_FUNCTION}`, { method: 'POST', body: form });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { data: null, error: { message: body?.message || `Upload failed (${res.status})` } };
            return { data: { path, ...(body || {}) }, error: null };
          } catch (e) {
            return { data: null, error: { message: String(e) } };
          }
        },
        getPublicUrl(path: string) {
          const base = STORAGE_FUNCTION?.replace(/\/[^/]*$/, '');
          return { data: { publicUrl: base ? `${base}/${_bucket}/${path}` : '' } };
        },
        async remove(_paths: string[]) {
          return { data: null, error: null };
        },
      };
    },
  };
}

/**
 * Neon Function URL shape: `https://<branch>-<slug>.compute.<cell>`.
 *
 * The Supabase client called every function under one `/functions/v1/` prefix;
 * Neon gives each function its own subdomain, so the name has to be mapped to a
 * slug and the host rebuilt. Slugs also cannot contain the hyphens the original
 * names used — `^[a-z0-9]{1,20}$` — hence the table below.
 */
const FUNCTIONS_BASE = import.meta.env.VITE_NEON_FUNCTIONS_BASE as string | undefined;
const FUNCTIONS_CELL = import.meta.env.VITE_NEON_FUNCTIONS_CELL as string | undefined;

const FUNCTION_SLUGS: Record<string, string> = {
  'guest-chat': 'guestchat',
  'resort-operator': 'resortop',
  'resort-operator-execute': 'resortexec',
  'scan-receipt': 'scanreceipt',
  'ops-coordinator': 'opscoord',
};

function functionUrl(name: string): string | null {
  const slug = FUNCTION_SLUGS[name];
  if (!FUNCTIONS_BASE || !FUNCTIONS_CELL || !slug) return null;
  return `${FUNCTIONS_BASE.replace(/\/$/, '')}-${slug}.compute.${FUNCTIONS_CELL}`;
}

function shimFunctions() {
  return {
    async invoke(name: string, opts?: { body?: unknown; method?: string; headers?: HeadersInit }) {
      const url = functionUrl(name);
      if (!url) {
        return {
          data: null,
          error: {
            message: `Function "${name}" is not configured (set VITE_NEON_FUNCTIONS_BASE / VITE_NEON_FUNCTIONS_CELL).`,
          },
        };
      }
      try {
        // Neon Functions verify the caller's own Neon Auth JWT, so the token
        // has to travel with the call. supabase-js attached the session's
        // access token to function invocations implicitly; without the same
        // here, every authenticated call reaches the guard unsigned and is
        // refused with a 401 that looks like an expired session.
        const headers = new Headers({ 'Content-Type': 'application/json' });
        new Headers(opts?.headers || {}).forEach((value, key) => headers.set(key, value));
        const token = getStaffToken() ?? await resolveGuestToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);

        const res = await fetch(url, {
          method: opts?.method ?? 'POST',
          headers,
          body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        const text = await res.text();
        let data: unknown = null;
        try { data = JSON.parse(text); } catch { data = text; }
        if (!res.ok) {
          return { data, error: { message: (data as { message?: string })?.message || `Function "${name}" failed (${res.status})` } };
        }
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: String(e) } };
      }
    },
  };
}

// Attach the shims. `createClient` already declares these members, so the
// public type is unchanged and the ~30 call sites compile as written.
//
// These are defined with Object.defineProperty rather than Object.assign:
// SupabaseClient exposes `functions` (and friends) as getter-only accessors on
// its prototype, and assigning to a getter-only property throws a TypeError at
// runtime. An own data property on the instance shadows the prototype getter.
function override(name: string, value: unknown) {
  Object.defineProperty(supabase, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

override('channel', shimChannel);
override('removeChannel', shimRemoveChannel);
override('storage', shimStorage());
override('functions', shimFunctions());
