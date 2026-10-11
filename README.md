# KAPWA Hospitality OS

An agentic resort-operations platform: front desk, housekeeping, kitchen, bar, cashier,
tours, payroll, and inventory — plus an AI concierge for guests ("Tala") and an AI
operations operator that plans and executes day-to-day resort work.

**Live:** https://kapwa-resort-webapp.vercel.app

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite, React 18, TypeScript, Tailwind CSS, shadcn-ui / Radix UI |
| Routing / data | react-router-dom, TanStack Query, Zustand, react-hook-form + Zod |
| Backend | Supabase (Postgres, Auth, RLS, Edge Functions) |
| AI | OpenRouter via a single server-side gateway (`supabase/functions/_shared/modelGateway.ts`), with local Ollama support for the guest concierge |
| Integrations | Telegram / WhatsApp guest chat, Sirvoy PMS webhooks, receipt OCR |
| Voice | LiveKit voice agent in `voice-agent/` (Python) with its own React frontend |
| Server | Express proxy (`server/`) for the local agent runtime |
| Testing / CI | Vitest + Testing Library, ESLint, GitHub Actions (`.github/workflows/ci.yml`) |
| Deploy | Vercel (frontend), Supabase (backend) |

## Repository layout

```text
src/                  React app
  pages/              Routes: reception, kitchen, bar, housekeeping, cashier, admin, guest portal…
  components/         Role-based UI (admin, staff, service boards, rooms, guest, ui kit)
  lib/                Auth, permissions, audit log, orders, billing, inventory logic
  hooks/              Shared data hooks
supabase/
  migrations/         79 SQL migrations (schema + RLS)
  functions/          25 edge functions (AI agents, webhooks, staff APIs)
server/               Express agent proxy (npm run dev:server)
voice-agent/          LiveKit voice agent (Python + React, Docker)
docs/                 Setup, runtime, security, and planning docs
```

## Getting started

Requires Node.js 20+ and npm.

```sh
git clone https://github.com/digitalnativepalawan/kapwa-resort-webapp.git
cd kapwa-resort-webapp
npm install
cp .env.example .env   # fill in your Supabase values
npm run dev            # frontend on http://localhost:8080
```

Other scripts:

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server |
| `npm run dev:server` | Express agent proxy |
| `npm run build` | Production build |
| `npm test` | Vitest suite |
| `npm run lint` | ESLint |

Backend setup (Supabase project, migrations, edge-function secrets) is covered in
**[docs/SETUP.md](docs/SETUP.md)**.

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — provision a Supabase backend for this repo
- [docs/RESORT_OPERATOR_SETUP.md](docs/RESORT_OPERATOR_SETUP.md) — the agentic resort-operations runtime
- [docs/RESORT_OPERATOR_RUNTIME.md](docs/RESORT_OPERATOR_RUNTIME.md) — how the operator thinks and acts
- [docs/GUEST_REQUEST_CLOSED_LOOP.md](docs/GUEST_REQUEST_CLOSED_LOOP.md) — guest request lifecycle
- [docs/security/rls-migration.md](docs/security/rls-migration.md) — row-level-security cutover plan
- [docs/KAPWA-OS-COMMERCIAL-PILOT-PLAN.md](docs/KAPWA-OS-COMMERCIAL-PILOT-PLAN.md) — commercial pilot plan
