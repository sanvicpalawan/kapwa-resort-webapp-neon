# Migrating off Supabase — preparation notes

The goal: this app should be movable off Supabase (to Neon, Cloudflare, or both)
without a rewrite, because the Postgres backend and domain should be owned
outright rather than rented through a hosting platform.

Nothing here needs to happen today. This document records what is coupled, what
is already portable, and the order to unpack it when the time comes.

## Coupling inventory (audited 2026-10-03)

| Area | Size | Coupling | Portable? |
|------|------|----------|-----------|
| SQL schema | 79 migrations / 3,143 lines | Plain Postgres + RLS | ✅ mostly — see "3 exceptions" below |
| Frontend data access | 30 files | supabase-js query builder (PostgREST) | ⚠️ one entry point, but PostgREST-shaped calls |
| Realtime | 38 subscriptions across 21 files | `postgres_changes` (Supabase Realtime) | ❌ biggest coupling |
| Edge functions | 25 functions / 23 import supabase-js | Deno `serve()` + Supabase runtime | ⚠️ ports cleanly to Workers |
| Auth | entire app | **custom** HS256 staff JWT (`employee-auth`) | ✅ no Supabase Auth at all |
| Storage | — | unused | ✅ |
| Browser client | 1 module | `src/integrations/supabase/client.ts` | ✅ swap in one file |

### What makes this easier than it looks

1. **Auth is already yours.** There are zero `supabase.auth.*` calls — staff
   login mints its own HS256 JWT (`supabase/functions/employee-auth`) with
   `STAFF_JWT_SECRET`. Supabase Auth is not in the picture.
2. **All frontend DB traffic funnels through one module**
   (`src/integrations/supabase/client.ts`). The 30 importer files all use the
   same `.from().select().eq()` chain, so a data-access layer swap is
   mechanical, not archaeological.
3. **Storage is unused** — nothing to migrate there.
4. **The schema is plain Postgres.** RLS policies, `is_staff()`,
   `has_permission()`, etc. run on any Postgres.

### The 3 real exceptions in the SQL

Only a handful of migrations touch Supabase-specific things:

1. **Roles** — `GRANT ... TO service_role` / `TO authenticated` and policies
   written `TO authenticated` (5 files, e.g. `20260707035810_*`,
   `20260707025328_*`, `20260707025244_*`). On plain Postgres: create roles with
   those names, or sed them to your role names before applying.
2. **`pg_cron` + `pg_net`** — one migration (`20260302*` window) does
   `create extension pg_net; perform net.http_post(...)` to call an edge
   function from a trigger. On Neon/Cloudflare this becomes a queue table +
   worker poll (the queue pattern already exists in `process-webhook-queue`).
3. **PostgREST session context** — `jwt_permissions()` reads the JWT claims
   PostgREST injects. Any replacement API layer must set the same session vars
   (`request.jwt.claims`) or the helper functions need a one-line change.

## Path A — Neon (bring your own Postgres)

1. Create a Neon project; apply all 79 migrations in filename order after
   resolving exception 1 (roles). `supabase db push` won't work — use
   `psql`/Drizzle/flattened SQL.
2. Put a thin API in front (Cloudflare Worker or Neon's own driver): the app
   needs an endpoint layer to replace PostgREST — this is the main work item.
   Wrap it behind the existing single-client module so the 30 files change at
   call-site level only.
3. Replace the `pg_net` trigger with a queue + poller.
4. Realtime: interim = poll on the existing `refetchInterval`s; target =
   SSE/broadcast channel from the API layer.

## Path B — Cloudflare ( Workers + D1 or Neon-via-Hyperdrive)

1. Frontend → Cloudflare Pages/Workers static (Vercel config already exists;
   add `wrangler.toml`).
2. The 25 edge functions are Deno `serve()` handlers — they port to Workers
   almost as-is; `supabase-js` service-role calls become direct SQL through
   Hyperdrive (Neon) or D1.
3. Realtime → Durable Object per live board, or SSE.
4. `whatsapp-bridge/` (Baileys) runs anywhere — it's already an external
   always-on service, not a Supabase feature.

## Recommended order when the time comes

```text
1. Data-access facade     (isolates PostgREST; app keeps running on Supabase)
2. Database move          (Neon/D1; schema is portable, dual-run then cutover)
3. Realtime replacement   (last — it's the only thing that must change together)
4. Edge functions → Workers
5. Point the domain       (DNS leaves Lovable here)
```

Each step is independently shippable; nothing forces a big-bang cutover.
