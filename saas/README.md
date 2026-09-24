# IT Inventory SaaS (MVP)

One place for IT to see who has which device, what state it is in, and what
disagrees between the directory (Microsoft Entra ID) and the MDM (Jamf,
Intune). The product answers "what do I need to fix today", not only "here is
the data".

Multi-client cloud experiment on branch `saas`.  
The offline Windows app stays on branch `local` (same repo).

## Issues: what needs fixing

After every import, connector sync or manual change, each organization is
re-checked against these rules. Results land in the **Issues** tab and on the
dashboard; each one says what is wrong and what to do next.

| Rule | Severity | Fires when |
|------|----------|------------|
| Active user without a device | low | A user present and enabled in the directory has no device assigned |
| Device without an owner | medium | An MDM device has no owner but is still checking in or reports a user |
| Disabled account still holds a device | high | The directory disabled the account, the device is still assigned |
| Stale check-in | medium (high at 2× the threshold) | Last MDM check-in older than the threshold (30 days by default) |
| Missing from MDM | medium | The device was not in the latest export from its MDM |
| Owner mismatch | medium | The MDM reports a different user than the inventory assignment |
| Possible duplicate | low / medium | Two records share an MDM id, or one person holds several devices of one category |

IT can assign an issue, snooze it, resolve or dismiss it with a note; every
step is kept in the issue history and the audit log. An issue closes itself
when the condition disappears and reopens if it comes back; a dismissed issue
stays dismissed. Admins tune thresholds and switch rules off in
**Settings → Issue rules**. Nothing in this flow changes Entra or Jamf.

Connections (**Settings → Connections**) share one interface: a provider
returns records shaped like its CSV export, and they go through the same
preview and apply as an upload. Today only the demo provider syncs; Microsoft
Entra (`User.Read.All`, admin consent) and Jamf Pro (API client with a
read-only role) are declared with their minimum permissions and will sync once
a test tenant is available. Credentials are encrypted with
`SAAS_CONNECTOR_KEY`.

`npm run seed:demo` fills an organization with demo Entra users and Jamf Macs
so every rule has an example.

## What this MVP includes

- Register → creates an **organization** + admin user
- Login → JWT session and organization switcher
- Roles: admin, IT and read-only
- Invitations with a 7-day acceptance link, member role changes and removal
- People + devices scoped by `organizationId`, with edit, assign, reassign and
  return-to-stock
- Device detail with hardware fields, external ids and assignment history
- Hardware catalog (categories, brands, models) seeded per organization on
  first access from `saas/seed/catalog-default.json` (broad multi-brand defaults,
  no client-specific MTR entries). Admins manage the tree in Settings → Catalog
  (add, rename, archive, restore missing defaults)
- Tenant-editable options: statuses (with dashboard `countsAs`), departments,
  locations, plus custom fields on devices and people
- Dashboard: device and people breakdowns (status buckets honor `countsAs`),
  warranty windows, recent assignments
- CSV reports (stock, per department, warranty 30/90, people without a device,
  missing from the last MDM import, devices by category) and a full device export
- People merge that moves devices, assignment history and alternate addresses
- Intune/Jamf CSV **or ZIP** preview + transactional apply per organization,
  including catalog model resolution, owner changes and a flag for devices the
  MDM stopped reporting
- Additional MDM device presets (Kandji, Mosyle, Workspace ONE, ChromeOS,
  JumpCloud, NinjaOne, ManageEngine, Hexnode, Addigy, SOTI, generic) and user
  presets (Google Workspace, Okta, JumpCloud) with column mapping, saved import
  profiles and inline model fixes for `needs_review` rows
- Entra / Intune user CSV import for the people directory
- Audit log for mutations, assignments and imports
- Self-service password change that ends every other session
- Organization deletion that removes its data and orphaned accounts
- SQLite locally; PostgreSQL on staging/production
- Health and database readiness checks

## What is not here yet

- Invoice PDF import, PV DOCX handover documents, JSON backup/restore
- Microsoft/Google SSO
- Live Entra / Jamf / Intune sync (the connector layer and demo provider are
  in place; CSV/ZIP import covers the same data meanwhile)
- Actions that change Entra or Jamf (lock, revoke, reassign) — planned behind
  explicit confirmation
- MFA, licence and compliance checks (need the live connectors)
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
| `SAAS_CONNECTOR_KEY` | empty | Encrypts connector credentials; without it credentials cannot be saved |

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
