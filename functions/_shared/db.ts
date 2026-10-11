// ─────────────────────────────────────────────────────────────────────────────
// Database client for the Functions backend.
//
// The ported functions keep their original supabase-js query builders verbatim —
// the filter chains, foreign-key embeds, and `{ data, error }` result shape are
// exactly what Neon's Data API speaks. Rather than rewrite ~55 queries as raw
// SQL (and re-derive PostgREST semantics for embeds and `.or()` filters), the
// client is pointed at the Data API with the service token instead of a
// Supabase service-role key.
//
// supabase-js appends `/rest/v1` itself, so the base handed to `createClient`
// must NOT include it. Neon injects `NEON_DATA_API_URL`; depending on the
// account it arrives with or without that suffix, so both are normalised here.
// Hitting the base without the suffix resolves to /neondb/rpc/... and 404s,
// which in this codebase shows up as a permission list that quietly reads empty.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";
import { serviceToken } from "./serviceToken";

/** Base URL without the `/rest/v1` suffix supabase-js adds itself. */
export function dataApiBase(): string {
  const raw = (env("NEON_DATA_API_URL") ?? "").replace(/\/$/, "");
  if (!raw) throw new Error("NEON_DATA_API_URL is not set");
  return raw.replace(/\/rest\/v1$/, "");
}

/**
 * Wraps `fetch` so a 200 with an empty body is asked for again.
 *
 * The Data API answers that way while its connection pool is warming up, and
 * postgrest-js reads it as a success with no value — `if (body === "") {}`
 * leaves `data` null and `error` null. A null identity then looks exactly like
 * a valid login belonging to nobody, and a null select looks exactly like an
 * empty table, so the failure surfaces somewhere far from its cause.
 *
 * Only GET and HEAD are retried: those are idempotent by definition. A POST
 * that returns 200 has already committed whatever it did, so re-issuing it
 * would duplicate the write rather than repair the response.
 */
async function dataApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";

  const once = async (): Promise<{ res: Response; empty: boolean }> => {
    const res = await fetch(input, init);
    if (!res.ok || !retryable) return { res, empty: false };
    // `content-length: 0` settles it without touching the body. Otherwise the
    // length is unknown, so the response is cloned and the copy read — the
    // original stream is left untouched for supabase-js to parse.
    if (res.headers.get("content-length") === "0") return { res, empty: true };
    if (res.headers.get("content-length")) return { res, empty: false };
    try {
      const peeked = res.clone();
      return { res, empty: (await peeked.text()).length === 0 };
    } catch {
      return { res, empty: false };
    }
  };

  let out = await once();
  for (let attempt = 0; out.empty && attempt < 2; attempt++) out = await once();
  return out.res;
}

/**
 * A client acting as the service identity — the drop-in for the original
 * `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`.
 *
 * Auth is resolved per request, so a cached client picks up a rotated token
 * without the caller holding a reference.
 */
export async function serviceClient(): Promise<SupabaseClient> {
  return createClient(dataApiBase(), await serviceToken(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: dataApiFetch },
  });
}

/**
 * A client acting as a specific caller, for the rare case where a function must
 * act with the requesting user's own authority rather than the service one.
 */
export async function clientForToken(token: string): Promise<SupabaseClient> {
  return createClient(dataApiBase(), token, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: dataApiFetch },
  });
}
