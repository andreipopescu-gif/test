# IT Inventory SaaS (MVP)

Multi-client cloud experiment on branch `saas`.  
The offline Windows app stays on branch `local` (same repo).

## What this MVP includes

- Register → creates an **organization** + admin user
- Login → JWT session and organization switcher
- Roles: admin, IT and read-only
- Invitations with a 7-day acceptance link, member role changes and removal
- People + devices scoped by `organizationId`, with edit, assign, reassign and
  return-to-stock
- Intune/Jamf CSV preview + transactional apply per organization
- Audit log for mutations, assignments and imports
- Self-service password change that ends every other session
- Organization deletion that removes its data and orphaned accounts
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
| `SAAS_JWT_SECRET` | none | Sign tokens; the server refuses to start without it |
| `SAAS_ALLOW_REGISTRATION` | unset | Only `true` opens registration |
| `SAAS_REGISTRATION_TOKEN` | empty | When set, registration also requires this token |
| `SAAS_PUBLIC_URL` | empty | Base URL for invitation links; falls back to the Host header |
| `SAAS_TRUSTED_PROXIES` | `0` | Reverse proxies in front of the app; Render needs `1` |
| `SAAS_MAX_UPLOAD_MB` | `10` | Upload size limit |
| `SAAS_MAX_IMPORT_COLUMNS` | `256` | CSV column cap |
| `SAAS_MAX_IMPORT_ROWS` | `20000` | CSV data row cap |
| `DATABASE_URL` | empty | PostgreSQL connection URL |
| `DATABASE_SSL` | `false` | Enable TLS for an external PostgreSQL endpoint |

`SAAS_JWT_SECRET` is mandatory everywhere, not only in production: a shared
default would let anyone mint a token for any organization.

Registration is closed unless it is opened. With `NODE_ENV=production` and no
`SAAS_ALLOW_REGISTRATION`, the only way in is `SAAS_REGISTRATION_TOKEN`; with
neither, the endpoint is off.

## Tests

```bash
npm test                 # SQLite, plus the tenant isolation gate
npm run pilot:validate   # the isolation gate on its own
npm run test:postgres    # needs TEST_DATABASE_URL and DATABASE_URL
```

CI runs both on every push and pull request; see `.github/workflows/ci.yml`.

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
