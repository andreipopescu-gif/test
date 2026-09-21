# IT Inventory SaaS (MVP)

Multi-client cloud experiment on branch `saas`.  
The offline Windows app stays on branch `local` (same repo).

## What this MVP includes

- Register → creates an **organization** + admin user
- Login → JWT session and organization switcher
- Roles: admin, IT and read-only
- Invitations with a 7-day acceptance link
- People + devices scoped by `organizationId`
- Intune/Jamf CSV preview + transactional apply per organization
- Audit log for mutations and imports
- SQLite locally; PostgreSQL on staging/production
- Health and database readiness checks

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

Data file: `saas/data/saas.sqlite` (created automatically). Set `DATABASE_URL`
to use PostgreSQL instead.

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8090` | HTTP port (8080 stays for local app) |
| `SAAS_DB_PATH` | `saas/data/saas.sqlite` | SQLite path |
| `SAAS_JWT_SECRET` | dev secret | Sign tokens (set in production) |
| `DATABASE_URL` | empty | PostgreSQL connection URL |
| `DATABASE_SSL` | `false` | Enable TLS for an external PostgreSQL endpoint |

`SAAS_JWT_SECRET` is mandatory when `NODE_ENV=production`.

## EU staging

The repository root contains `render.yaml`, a staging Blueprint with:

- web service in Frankfurt;
- managed PostgreSQL in Frankfurt;
- generated JWT secret;
- `/api/ready` deployment health check.

After pushing branch `saas` to a Git provider, create a Render Blueprint from
the repository. Then verify:

```bash
STAGING_URL=https://your-staging-host npm run check:staging
```

Publishing requires access to the chosen provider account; no credentials are
stored in this repository.

## Branch workflow

- `local` — offline server app (`src/`, `public/`, Windows deploy)
- `saas` — this folder + future cloud work

Cherry-pick fixes from `local` when import/domain bugs matter for both.
