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

1. **Phase 0** — paid Postgres/web before **2026-10-21**, SSL, backups, migration advisory lock, close open registration on prod, `SAAS_PUBLIC_URL`
2. Remaining security items in `SECURITY-REVIEW.md` (H2 CSV cost, M-series, etc.)
3. Phase 2 ImportPolicy (kill process-global import settings) before multi-client production data
4. API gaps: member remove, password reset, people/device update/reassign, full teardown

## Deploy notes already learned

- Postgres boots must **lazy-load** `node:sqlite` (commit `b46354c`); top-level sqlite import crashes Render.
- Free web instance sleeps; first request after idle is slow; seed scripts wait for `/api/ready`.
- `SAAS_TRUSTED_PROXIES=1` on Render so rate limits use the real client IP.
