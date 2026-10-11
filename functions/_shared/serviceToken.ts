// ─────────────────────────────────────────────────────────────────────────────
// Service identity for the Functions backend.
//
// The Supabase originals opened their database client with
// `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` — a key that bypasses
// row-level security outright. Neon has no equivalent bearer credential for the
// Data API: it authenticates a request with a Neon Auth JWT whose `role` claim
// selects the Postgres role, and those JWTs are signed by a key the app never
// sees. Minting one directly is therefore not an option.
//
// Instead the Function signs in through Neon Auth's own public HTTP API, exactly
// as a browser would, using a dedicated service identity. That yields a session
// cookie (7 days) which is exchanged for a short-lived JWT (15 minutes) on each
// use. Both hops are plain HTTPS calls to the auth base Neon already injects.
//
// The resulting session runs as `role: authenticated`, so row-level security
// still applies — which is a stricter posture than the old service-role key.
// It is safe here because the service identity is a member of `employees` with
// the `admin` permission, and every policy in this schema funnels through
// `is_admin()` / `has_permission()`. Reads and writes the functions need are
// permitted; the guest's read-only identity, which has no employee row at all,
// still sees nothing.
//
// State is module-scoped and in-memory: an isolate is reused across many
// requests, so the cookie is fetched once and only re-minted when the JWT
// approaches expiry. Nothing here needs to survive eviction — a cold start just
// costs one extra sign-in.
// ─────────────────────────────────────────────────────────────────────────────

import { env } from "./env";

const AUTH_BASE = () => (env("NEON_AUTH_BASE_URL") ?? "").replace(/\/$/, "");

/**
 * A registered trusted domain. Neon Auth rejects a sign-in whose `Origin` is not
 * on the allowlist, and it also rejects any `X-Forwarded-Host` that is not its
 * own host — so this call goes to the auth base directly, with no forwarded
 * host, and simply names an already-trusted origin.
 *
 * A server has no browser enforcing `Origin`, so the header is ours to set.
 */
const TRUSTED_ORIGIN = () =>
  env("NEON_SERVICE_ORIGIN") ?? "https://kapwa-resort-webapp-three.vercel.app";

/** Signed-in session. The cookie outlives the JWT many times over. */
interface Session {
  cookie: string;
}

let session: Session | null = null;
/** Guards concurrent callers on the same isolate from racing a re-sign-in. */
let signingIn: Promise<Session> | null = null;

async function signIn(): Promise<Session> {
  const base = AUTH_BASE();
  if (!base) throw new Error("NEON_AUTH_BASE_URL is not set");

  const email = env("NEON_SERVICE_EMAIL");
  const password = env("NEON_SERVICE_PASSWORD");
  if (!email || !password) {
    throw new Error("NEON_SERVICE_EMAIL / NEON_SERVICE_PASSWORD are not set");
  }

  // A cold burst reaches several isolates at once and each one signs in
  // separately, so Neon Auth answers the surplus with 429 and the request that
  // carries it would otherwise fail outright. A rejected sign-in created no
  // session, so repeating it leaks nothing.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${base}/sign-in/email`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: TRUSTED_ORIGIN(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    const throttled = res.status === 429 || res.status >= 500;
    if (!throttled || attempt >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }

  // Multiple cookies are collapsed into one comma-joined header by `headers`,
  // which browsers (and this cookie header) reject — recover them one by one.
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");

  if (!res.ok || !cookie) {
    throw new Error(`Neon Auth sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return { cookie };
}

async function sessionOnce(): Promise<Session> {
  if (session) return session;
  if (!signingIn) {
    signingIn = signIn()
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        signingIn = null;
      });
  }
  return signingIn;
}

/** Expiry of the JWT currently cached, in epoch seconds. */
let tokenExpiry = 0;
let cachedToken: string | null = null;

/** Refresh this many seconds before the JWT actually expires. */
const REFRESH_MARGIN_SEC = 120;

/**
 * A Neon Auth JWT for the service identity, valid as a Data API bearer token.
 *
 * Cached per isolate and re-minted from the stored session shortly before
 * expiry. If the session itself has lapsed (sign-out, or longer than its 7-day
 * life) the token endpoint rejects it, so the session is dropped and re-created.
 */
export async function serviceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - REFRESH_MARGIN_SEC) return cachedToken;

  const base = AUTH_BASE();
  let s = await sessionOnce();

  const mint = async (): Promise<string | null> => {
    const res = await fetch(`${base}/token`, {
      redirect: "manual",
      headers: {
        Origin: TRUSTED_ORIGIN(),
        Cookie: s.cookie,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    return body?.token ?? null;
  };

  let token = await mint();

  if (!token) {
    // The stored session no longer authenticates — start a fresh one.
    session = null;
    s = await sessionOnce();
    token = await mint();
  }
  if (!token) throw new Error("Could not mint a Neon Auth token for the service identity");

  cachedToken = token;
  // Decode exp from the token itself rather than assuming a fixed lifetime.
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ) as { exp?: number };
    tokenExpiry = typeof payload.exp === "number" ? payload.exp : now + 600;
  } catch {
    tokenExpiry = now + 600;
  }

  return token;
}
