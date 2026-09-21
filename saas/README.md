# IT Inventory SaaS (MVP)

Multi-client cloud experiment on branch `saas`.  
The offline Windows app stays on branch `local` (same repo).

## What this MVP includes

- Register → creates an **organization** + admin user
- Login → JWT session
- People + devices scoped by `organizationId`
- Health check

## What is not here yet

- Invoice PDF import, PV DOCX, advanced reports
- Microsoft/Google SSO
- Hosted Intune/Jamf sync
- Billing

## Run

```bash
cd saas
npm start
```

Open http://127.0.0.1:8090

Data file: `saas/data/saas.sqlite` (created automatically).

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8090` | HTTP port (8080 stays for local app) |
| `SAAS_DB_PATH` | `saas/data/saas.sqlite` | SQLite path |
| `SAAS_JWT_SECRET` | dev secret | Sign tokens (set in production) |

## Branch workflow

- `local` — offline server app (`src/`, `public/`, Windows deploy)
- `saas` — this folder + future cloud work

Cherry-pick fixes from `local` when import/domain bugs matter for both.
