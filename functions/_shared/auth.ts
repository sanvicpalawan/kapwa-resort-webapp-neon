// ─────────────────────────────────────────────────────────────────────────────
// Shared authorization for the Functions backend.
//
// Same three guards and same exported shapes as the Supabase originals, so the
// ported handlers are unchanged at their call sites:
//
//   requireStaff()    — a signed-in member of `employees`
//   requireAdmin()    — requireStaff() plus the `admin` permission
//   requireInternal() — the INTERNAL_FN_SECRET header (cron / server-to-server)
//
// The staff guard is rewritten rather than copied. The original verified an
// HS256 token minted in-process by the `employee-auth` edge function against a
// `STAFF_JWT_SECRET`. That whole mechanism is gone: staff now sign in through
// Neon Auth, so the browser holds a Neon Auth JWT and the secret no longer
// exists. Left as-is the guard would have returned `enforced: false` for every
// request — and since a Neon Function has a public HTTPS URL, that would have
// shipped an unauthenticated agent backend. The guard now verifies the caller's
// token against Neon Auth's published JWKS, then resolves their permissions
// through the same email → employee → permissions bridge the rest of the app
// uses, so `/admin` and these endpoints agree on who is who.
//
// `requireInternal` is unchanged in behaviour but no longer "inert when unset":
// an unset secret on a public URL would mean no gate at all, so it now rejects
// instead of admitting everyone.
// ─────────────────────────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { clientForToken } from "./db";
import { env } from "./env";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export const jsonHeaders = { "Content-Type": "application/json" };

export interface StaffClaims {
  employee_id: string;
  name: string;
  permissions: string[];
  is_admin: boolean;
  exp: number;
}

export type Guard =
  | { ok: true; enforced: boolean; claims: StaffClaims | null }
  | { ok: false; response: Response };

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, ...jsonHeaders },
  });
}

/** Standard OPTIONS preflight response. Return this before any guard runs. */
export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { headers: corsHeaders }) : null;
}

function bearer(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  // The Supabase JS client falls back to the publishable key when no session
  // exists. That is not a credential — treat it as absent.
  if (!token || token.startsWith("sb_publishable_") || token.startsWith("sb_secret_")) return null;
  return token;
}

/** Lazy so a branch without Neon Auth configured fails on first use, not import. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function verifier() {
  const url = env("NEON_AUTH_JWKS_URL");
  const base = env("NEON_AUTH_BASE_URL");
  if (!url || !base) throw new Error("NEON_AUTH_JWKS_URL / NEON_AUTH_BASE_URL are not set");
  if (!jwks) jwks = createRemoteJWKSet(new URL(url));
  // Neon Auth's issuer is the origin of the auth base (the path is a suffix).
  return { keys: jwks, issuer: new URL(base).origin };
}

/**
 * Verify a caller's Neon Auth token. Returns the payload, or null when the
 * token is absent, malformed, expired, or signed by anyone else. Never throws.
 */
export async function verifyNeonJwt(token: string): Promise<JWTPayload | null> {
  // A throttled JWKS fetch must not read as an expired session. jose caches a
  // failed fetch for its cooldown period, so retrying the same instance would
  // just re-hit the cached failure — the instance is dropped instead, which
  // forces the next attempt to fetch the keys again.
  //
  // Only a rejection jose makes deterministically is final. Expired tokens,
  // bad signatures and malformed claims return the same way every time and are
  // returned at once; anything else is given one more chance to succeed.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { keys, issuer } = verifier();
      const { payload } = await jwtVerify(token, keys, { issuer });
      return payload.sub ? payload : null;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "";
      const deterministic = code.startsWith("ERR_JWT_") || code.startsWith("ERR_JWS_");
      if (deterministic || attempt > 0) return null;
      jwks = null;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return null;
}

/**
 * Resolve a verified token to the caller's employee record and permissions.
 * Null when the identity is not a member of `employees` — a valid login is not
 * the same as being staff.
 */
async function resolveStaff(token: string): Promise<StaffClaims | null> {
  try {
    const supabase = await clientForToken(token);

    // The identity lookup is a POST, so it falls outside the idempotent retry
    // that db.ts applies to GETs — but it is a plain read, so re-issuing it is
    // safe. postgrest-js turns an empty 200 body into `data: null` with no
    // error, and `null` here would be read as "this valid login belongs to
    // nobody", turning a warm-up hiccup into a 403. An empty body is the only
    // result worth retrying: any other value is a real answer, including a
    // well-formed "not staff", and is returned as-is.
    let data: any = null;
    let error: { message?: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      ({ data, error } = await supabase.rpc("kapwa_my_identity"));
      if (error) {
        console.error(JSON.stringify({ stage: "resolveStaff", reason: "rpc_error", message: error.message }));
        return null;
      }
      if (data !== null && data !== undefined) break;
    }

    if (data === null || data === undefined) {
      console.error(JSON.stringify({ stage: "resolveStaff", reason: "empty_identity_after_retry" }));
      return null;
    }
    if (!data.employee_id) return null;
    return {
      employee_id: String(data.employee_id),
      name: String(data.name ?? ""),
      permissions: Array.isArray(data.permissions) ? data.permissions.map(String) : [],
      is_admin: data.is_admin === true,
      exp: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Require a signed-in staff member.
 *
 * Unlike the original, this is enforced from the first request: the credential
 * it checks is the one the app already hands every staff user, so there is no
 * staged cutover to protect. `enforced` is kept as true to preserve the shape
 * callers were written against.
 */
export async function requireStaff(req: Request): Promise<Guard> {
  const token = bearer(req);
  if (!token) {
    return {
      ok: false,
      response: json({ error: "Staff sign-in required.", code: "staff_token_missing" }, 401),
    };
  }

  const payload = await verifyNeonJwt(token);
  if (!payload) {
    return {
      ok: false,
      response: json(
        { error: "Your session has expired. Please sign in again.", code: "staff_token_invalid" },
        401,
      ),
    };
  }

  const claims = await resolveStaff(token);
  if (!claims) {
    return {
      ok: false,
      response: json(
        { error: "This account is not a staff member.", code: "not_staff" },
        403,
      ),
    };
  }

  return { ok: true, enforced: true, claims };
}

/** Require a staff JWT that carries the `admin` permission. */
export async function requireAdmin(req: Request): Promise<Guard> {
  const guard = await requireStaff(req);
  if (!guard.ok || !guard.enforced) return guard;

  const claims = guard.claims!;
  if (!claims.is_admin && !claims.permissions.includes("admin")) {
    return {
      ok: false,
      response: json({ error: "Admin permission required.", code: "admin_required" }, 403),
    };
  }
  return guard;
}

/**
 * Require the shared internal secret. Used by cron / server-to-server callers.
 *
 * Rejects when the secret is not configured rather than passing everyone
 * through: this endpoint is on a public URL, and an unset gate is no gate.
 */
export function requireInternal(req: Request): Guard {
  const secret = env("INTERNAL_FN_SECRET");
  if (!secret) {
    return {
      ok: false,
      response: json({ error: "Internal access is not configured.", code: "internal_secret_unset" }, 503),
    };
  }

  const supplied = req.headers.get("x-internal-secret");
  if (supplied !== secret) {
    return { ok: false, response: json({ error: "Forbidden", code: "internal_secret_invalid" }, 403) };
  }
  return { ok: true, enforced: true, claims: null };
}

/**
 * Accept either a staff JWT or the internal secret. For endpoints that serve
 * both the back office and an automated caller.
 */
export async function requireStaffOrInternal(req: Request): Promise<Guard> {
  const internal = requireInternal(req);
  if (internal.ok && internal.enforced) return internal;

  const staff = await requireStaff(req);
  if (staff.ok) return staff;

  // Neither credential validated. Surface the staff error — it is the one a
  // human is most likely looking at.
  return staff;
}
