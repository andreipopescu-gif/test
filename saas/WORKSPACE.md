# SaaS workspace ownership

This Cursor Cloud environment (`andreipopescu-gif/test`, agent **It-inventory saas app**)
owns **SaaS** work from 2026-09-21 onward.

| Surface | Where to work | Git branch |
|---------|---------------|------------|
| Offline / Windows Server LAN app | **it-inventory** workspace | `local` |
| Multi-tenant cloud MVP | **this** workspace | `saas` |

Do not continue SaaS features in the it-inventory agent. Do not use this agent for
Windows service / PV / invoice / offline-only changes — cherry-pick shared import
fixes from `local` when both products need them.

## Canonical sources (already on branch `saas`)

| Path | Role |
|------|------|
| `saas/` | Cloud app (server, UI, tests, pilot scripts) |
| `saas/README.md` | Product scope and env |
| `saas/ROADMAP.md` | Phases 0–5; Phase 0 due before Postgres free-tier expiry **2026-10-21** |
| `saas/SECURITY-REVIEW.md` | Adversarial findings; tip of `saas` already fixed C1/H1/H3/registration gate |
| `saas/PILOT.md` / `TEST-ENV.md` | Pilot gate and seed credentials pattern |
| `render.yaml` | Render Blueprint (Frankfurt free web + free Postgres) |
| `SAAS.md` | Branch + workspace working agreement |
| `src/import/**`, `src/settings/**`, `src/utils/**` | Shared with offline app (SaaS relative imports) |

## Staging

- URL: https://it-inventory-saas-staging.onrender.com
- Service id: `srv-daofucbtqb8s73f6hjkg`
- Health: `GET /api/health`, ready: `GET /api/ready`
- Check: `STAGING_URL=https://it-inventory-saas-staging.onrender.com npm run check:staging`

## Local SaaS run

```bash
git checkout saas   # or a feature branch based on saas
cd saas
npm ci
SAAS_JWT_SECRET=$(openssl rand -hex 32) npm start
# http://127.0.0.1:8090
```

Requires Node **≥ 24** (Render uses 24.9.0).

## Immediate backlog (do not lose)

Spending is frozen until the product is complete, so the paid half of Phase 0
is deferred on purpose. What is left after the free-tier MVP:

1. **Before 2026-10-21** — the free database is deleted, not downgraded. Run
   `DATABASE_URL=<staging> npm run backup` and keep the dump off the provider.
2. **Email delivery** — invitations still return a link the admin has to copy;
   there is no password-reset mail. Needs a provider decision (and money).
3. Remaining items in `SECURITY-REVIEW.md` marked Open: M7, M8, L1, L4, L5.

**Done for the free MVP (do not redo):** CSV DoS hardening, auth side channels,
registration defaults, migration locking, CI on both databases, independent
backup + verified restore, device/account lifecycle + teardown, ImportPolicy
per request with per-organization settings, assignment history / external ids /
import meta, and durable rate limits in the database.

## Deploy notes already learned

- Postgres boots must **lazy-load** `node:sqlite` (commit `b46354c`); top-level sqlite import crashes Render.
- Free web instance sleeps; first request after idle is slow; seed scripts wait for `/api/ready`.
- `SAAS_TRUSTED_PROXIES=1` on Render so rate limits use the real client IP.
- Migration 3 adds `users.token_epoch`. Migration 4 adds organization settings,
  assignment history, external ids, import meta and the `rate_limits` table.
  Both are additive.
