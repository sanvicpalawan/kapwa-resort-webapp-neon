# KAPWA Hospitality OS setup — stand up a new Supabase for this deployment

This repo is a full-stack app (Vite + React + TypeScript + Supabase). The entire
backend is defined in-repo:

- `supabase/migrations/` — 79 SQL migrations (all tables, RLS, functions)
- `supabase/functions/` — 25 edge functions
- `supabase/config.toml` — Supabase project config
- `src/integrations/supabase/client.ts` — reads Supabase URL + key from env

⚠️ **Important:** out of the box this repo may still be pointed at the **previous**
Supabase project in `.env` and `supabase/config.toml`. For this deployment you want a
**new, separate** Supabase project. Importing the code alone does **not** auto-provision
one — the steps below tell the system to apply everything to that fresh project.

---

## Step 1 — Stand up a new Supabase project and apply migrations

1. Create a **new** Supabase project (not any existing one).
2. Apply **all** migrations in `supabase/migrations/` (79 files) to that new
   project, in filename order, so the full schema, tables, and RLS policies
   are created:
   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
3. Deploy every edge function in `supabase/functions/` (25 of them). Keep
   `verify_jwt = false` as set in `supabase/config.toml` — each function does its
   own authorization via `supabase/functions/_shared/auth.ts`.
4. Update `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
   `VITE_SUPABASE_PROJECT_ID`) and `supabase/config.toml` (`project_id`) to the
   new project's values.
5. Add the edge-function secrets (see Step 2).
6. Leave `VITE_USE_STAFF_JWT` unset/false for now — claim-based auth stays off
   until RLS is migrated on staging (see `docs/security/rls-migration.md`).

After that, confirm the new Supabase project URL and verify the tables and
functions are live.

## Step 2 — Set the secrets

In Supabase → Project Settings → Edge Functions → Secrets:

| Secret | Needed by | Where to get it |
|--------|-----------|-----------------|
| `INTERNAL_FN_SECRET` | admin-summary, guest-requests-api, concierge-ai, send-telegram | Generate a long random string |
| `STAFF_JWT_SECRET` | employee-auth (JWT login), every guarded function | Supabase → Settings → API → JWT Secret |
| `OPENROUTER_API_KEY` | all AI functions (guest-chat, concierge-ai, ops-coordinator, resort-operator, scan-receipt, …) | openrouter.ai |
| `TELEGRAM_BOT_TOKEN` | send-telegram, telegram-webhook | Telegram @BotFather |

Optional per-agent model overrides (default to the models in
`supabase/functions/_shared/modelGateway.ts`):

`GUEST_MODEL`, `OPERATOR_MODEL`, `OPS_COORDINATOR_MODEL`, `RESERVATIONS_MODEL`,
`CONCIERGE_MODEL`, `SCAN_RECEIPT_MODEL` (must be vision-capable).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by
Supabase to edge functions — do not set them by hand.

---

## Security notes (already applied in this repo)

- The old "Free Login" instant-admin button is removed.
- `employee-auth` `set-password` now requires admin re-authentication.
- `admin-summary` and `guest-requests-api` are fail-closed behind
  `INTERNAL_FN_SECRET` — set that secret or they return 403 (by design).
- A JWT-claims login layer exists but is **off** (`VITE_USE_STAFF_JWT=false`).
- The full database lockdown (RLS) is written but not yet applied — see
  `docs/security/rls-migration.md` and apply on staging first.
