# SaaS roadmap — from staging MVP to first paying customers

Status at time of writing: MVP deployed on Render Frankfurt
(`https://it-inventory-saas-staging.onrender.com`), free web instance + free
PostgreSQL. The free database **expires 2026-10-21** and has no backups.

Phases are ordered by dependency, not by appetite. Phase 0 is time-boxed by the
database expiry. Estimates are dev-days for one developer, including tests.

## Spending freeze

No money goes into hosting until the product is complete and working, so every
Phase 0 item that needs a paid plan is deferred by decision. What that changes:

- the free database still expires **2026-10-21** and is deleted, not
  downgraded. `npm run backup` is the only copy that survives it, so take a
  dump before that date even if nothing else happens;
- staging holds sample and anonymised data only. No client inventory goes onto
  a free instance with no backups;
- rate limiting stays best-effort: the free web instance sleeps, which resets
  the in-memory counters;
- everything in Phase 0 that is code or configuration is **done**: the
  migration advisory lock, the registration default, `SAAS_PUBLIC_URL` for
  invitation links, the backup script and its verified restore. What remains
  is the plan upgrade itself, `DATABASE_SSL`, and splitting staging from
  production — all of which start costing money on the day they are done.

Phase 1 work that is free has been pulled forward: CI on every push and pull
request, with a second job that runs the database tests against a real
PostgreSQL service.

| Phase | Goal | Days |
|-------|------|------|
| 0 | Infrastructure survival: paid Postgres, backups, safe migrations, domain | 3 |
| 1 | Operational baseline: CI, email, error tracking, uptime, logs | 7 |
| 2 | Per-organization settings without process-global import state | 8 |
| 3 | Data-model parity: catalog, assignments, external ids, import meta | 13 |
| 4 | Entitlements and billing | 7 |
| 5 | Documents, PV DOCX, invoices (after first paying customer) | 12 |

Phases 0–4 ≈ 38 dev-days to a product that can be sold and invoiced.

---

## Phase 0 — Infrastructure survival (3 days)

**Goal:** staging stops being a throwaway that deletes itself. Everything here
must land before 2026-10-21.

### Work items

- `render.yaml`: move `it-inventory-saas-staging-db` from `plan: free` to
  `plan: basic-256mb` (or `basic-1gb`), keep `region: frankfurt`. Free Postgres
  is deleted at expiry, not downgraded — there is no grace period and no export.
- `render.yaml`: move the web service off `plan: free` to `plan: starter`. The
  free instance sleeps, and sleeping resets the in-memory `rateLimits` map in
  `saas/src/server.js`, so rate limiting currently has undefined behaviour in
  production.
- `render.yaml`: set `DATABASE_SSL` to `"true"` and add `PGSSL_REJECT_UNAUTHORIZED`
  explicitly. `saas/src/db.js` already reads both; today the blueprint ships
  `"false"`.
- Add a second blueprint (or a `previews`/env split) so staging and production
  are separate services with separate databases. Right now there is one
  environment and it is both.
- Migration safety: `migrate()` in `saas/src/db.js` runs inside the web process
  on boot. With more than one instance, two processes can run migration N
  simultaneously; `CREATE TABLE IF NOT EXISTS` survives that but `ALTER TABLE`
  and backfills (Phase 3) will not. Wrap the Postgres path in
  `SELECT pg_advisory_lock(hashtext('it_inventory_migrations'))` before reading
  `schema_migrations` and release after the loop.
- Migration safety, part two: every future migration must be additive and
  deployable while the old code is running (add column → backfill → switch reads
  → drop later). No destructive DDL inside the boot path.
- Backups: Render `basic` plan gives daily snapshots and PITR; additionally add a
  `scripts/backup.js` cron job (`type: cronjob` in the blueprint) that runs
  `pg_dump` to an EU object store (Scaleway/OVH S3, Frankfurt/Paris) so recovery
  does not depend on a single provider. Retain 30 days.
- Document a tested restore: `pg_restore` into a scratch database, run
  `npm run pilot:validate` against it, record the wall-clock time in `PILOT.md`.
  An untested backup is not a backup.
- Secrets: `SAAS_JWT_SECRET` is `generateValue: true`, which is fine, but there
  is no rotation path — rotating it logs everyone out silently. Add
  `SAAS_JWT_SECRET_PREVIOUS` and have `verifyToken()` in `saas/src/auth.js`
  accept either, sign with the current one only.
- Set `SAAS_ALLOW_REGISTRATION=false` in the production environment. The default
  in `saas/src/server.js` is `true`, so today anyone can create an organization
  on the live host.
- Real domain: `inventory.<company>.eu` with the Render-managed certificate,
  `SAAS_PUBLIC_URL` env var, and use it in `createInvitation()` instead of
  deriving the invite link from `req.headers.host` (host-header injection into
  invitation URLs).

### Migrations

- none (infrastructure only), but the advisory-lock change to `migrate()` must
  ship before Phase 3.

### Tests before ship

- `saas/test/smoke.test.js` extended with a migration-idempotency test: open the
  same database twice, assert `schema_migrations` has no duplicate versions;
- a test that `openDatabase()` against Postgres applies migrations concurrently
  from two connections without error (skipped unless `TEST_DATABASE_URL` is set);
- `npm run check:staging` passes against the new production host over HTTPS.

### Risks

- the free database can be deleted before the paid plan is created; take a
  `pg_dump` today and keep it, not after the plan change;
- switching `DATABASE_SSL` to `true` with `rejectUnauthorized` on can break the
  connection if Render's internal endpoint is used — verify on staging first;
- moving off the free web plan changes the egress IP; nothing depends on it yet,
  but a future client firewall allowlist would.

---

## Phase 1 — Operational baseline (7 days)

**Goal:** the product can be operated by one person who is not watching Render
logs. No client-visible features.

### Work items

- Email delivery. Pick one EU-hosted transactional provider with a DPA
  (Postmark EU, or Scaleway TEM in Paris; Resend routes through us-east by
  default and would need the EU region explicitly). Add `saas/src/mailer.js` with
  a single `sendEmail({ to, subject, text, html })` and env vars
  `SAAS_MAIL_PROVIDER`, `SAAS_MAIL_API_KEY`, `SAAS_MAIL_FROM`. Log every send to
  `audit_logs` as `email.send` with the template name only, never the body.
- Wire invitations: `createInvitation()` currently returns `inviteUrl` to the
  caller and nothing is sent. Send the mail, keep returning the URL for admins
  who want to copy it.
- Password reset: new table `password_resets`, endpoints
  `POST /api/auth/password-reset/request` and
  `POST /api/auth/password-reset/confirm`, both behind the existing
  `enforceRateLimit(req, 'auth', …)`. Reuse the `hashToken()` + `expires_at`
  pattern from `invitations`; 1-hour expiry, single use, always return 200 to
  avoid email enumeration.
- Password change while logged in: `PUT /api/me/password`. Because JWTs are
  stateless and `requireSession()` only revalidates membership, a stolen token
  survives a password change for up to 12 hours. Add
  `users.token_epoch INTEGER NOT NULL DEFAULT 0`, put it in the JWT claims, and
  compare in `requireSession()`; bump it on password change and reset. This also
  gives a working logout-everywhere.
- Store password hash parameters. `hashPassword()` in `saas/src/auth.js` writes
  `salt:hash` with implicit scrypt defaults, so the cost can never be raised
  without breaking every existing login. Move to
  `scrypt$N$r$p$salt$hash`, verify both formats, rehash on next successful login.
- CI: `.github/workflows/ci.yml` (or the Render-side equivalent if the repo stays
  on origin.cursor.com) running on every push and PR:
  `node --test` at the repo root, `cd saas && npm ci && npm test`, and
  `cd saas && npm run pilot:validate`. `node:sqlite` needs Node 24, which
  `engines` already pins. Add a second job with a Postgres service container and
  `TEST_DATABASE_URL` so the Postgres branch of `saas/src/db.js` is exercised —
  today only SQLite is ever tested, and `postgresSql()`'s `?` → `$n` rewrite is
  untested against a real server.
- Error tracking: Sentry with `region: de` (EU data residency), initialised in
  `saas/src/server.js` around the `createServer` catch and the `sendError` path.
  Scrub `authorization` headers, request bodies and the `data_json` of import
  rows. `beforeSend` must drop anything that looks like an email address.
- Request logging: one structured JSON line per request (method, path, status,
  duration, `organizationId`, `userId`) to stdout. Render retains logs for 7
  days on paid plans; that is enough for now.
- Uptime monitoring: external check on `/api/health` every minute and `/api/ready`
  every 5 minutes (Better Stack / Uptime Kuma on a small EU VM). `/api/ready`
  hits the database, so do not poll it aggressively.
- Move rate limiting out of process memory. Either a `rate_limits` table with a
  `(bucket, ip, window_start)` primary key, or accept single-instance deployment
  and document it. The current `Map` silently allows N× the limit on N instances.

### Migrations

```
version 3 (both dialects)
  CREATE TABLE password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_password_resets_user ON password_resets(user_id);
  ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
```

### Tests before ship

- reset flow: request → token → confirm → old password fails, new works;
- reset token is single-use and expires;
- request for an unknown email returns 200 and creates no row;
- `token_epoch` bump invalidates a previously issued JWT on the next request;
- both password hash formats verify, and a legacy hash is upgraded after login;
- mailer is injectable and the test suite uses a fake transport (no network);
- CI is green on both the SQLite and Postgres jobs.

### Risks

- email deliverability: invitations landing in spam looks like a broken product;
  set SPF/DKIM/DMARC on the new domain before the first invite goes out;
- the token-epoch change is a breaking auth change — all existing tokens must
  keep working if the claim is absent, otherwise the pilot org is logged out;
- Sentry is a processor with access to request context; it must be in the
  subprocessor list (Phase 3 GDPR work) before any client data flows to it.

---

## Phase 2 — Per-organization settings (8 days)

**Goal:** each organization owns its exclusion lists, identity alias groups and
model overrides, with no possibility of one organization's configuration
affecting another's import.

This is the highest-priority correctness item after Phase 0. It must ship
*before* Phase 3, because the import rewrite in Phase 3 would otherwise be
written against the broken interface and then rewritten.

### The actual problem

`src/import/excluded-users.js` and `src/import/known-person-aliases.js` hold
their configuration in module-level `let` bindings
(`runtimeExcludedEmails`, `runtimeExcludedNameRules`, `runtimeIdentityGroups`)
mutated by `setRuntimeExcludedUsers()` / `setRuntimeIdentityGroups()`. In the
local single-tenant app that is correct: `InventoryStore.applyRuntimeSettings()`
sets them once from `db.settings`.

In the SaaS process there is one module instance for the whole server.
`saas/src/import-service.js` works around it by clearing both lists once at
import time (`useDefaults: false`). That is safe only because the lists stay
empty forever. The moment per-organization settings exist, the obvious
implementation — "load org settings, call `setRuntime*`, run the import" — is a
cross-tenant data leak: two concurrent `POST /api/import/preview` requests from
different organizations interleave at every `await`, and whichever request
called `setRuntime*` last decides which people get excluded and which identities
get merged for *both*. It would be intermittent, invisible in tests that run one
import at a time, and would corrupt person records.

Patching it with a mutex or `AsyncLocalStorage` is not acceptable: it keeps a
global as the source of truth for tenant-scoped policy, and any new call site
that forgets the wrapper reintroduces the bug silently.

### Design: explicit import policy object

- introduce `ImportPolicy` — a plain, frozen, per-request value:
  `{ excludedEmails, excludedNameRules, identityGroups, modelOverrides, mtrRules }`;
- convert the shared modules to pure functions that take it as the first
  argument: `shouldSkipImportedUser(policy, person)`,
  `getIdentityGroups(policy)`, `findKnownPersonIdentityGroup(policy, email)`,
  `emailsAreKnownSamePerson(policy, a, b)`, `preferKnownCanonicalEmail(policy, a, b)`,
  `preferredIdentityNames(policy, email)`, `personEmailsInKnownGroup(policy, person, email)`,
  and the same for `src/utils/person-email-alias.js`, which is the largest
  consumer;
- thread `policy` through `mapIntuneRows(records, filter, policy)`,
  `mapJamfRows(...)`, `mapEntraUserRows(...)`, `resolveModel(catalog, row, policy)`
  and `buildImportPreview` / `buildSaasImportPreview`;
- keep `setRuntimeExcludedUsers()` / `setRuntimeIdentityGroups()` as a thin
  deprecated shim over a module-level *default* policy so the local app on
  branch `local` keeps working unchanged during the transition, then delete them
  (Phase 3 of the code-sharing plan below);
- forbid regression with a lint rule or a test that greps the shared import
  modules for `^let ` at module scope.

### Work items

- `organization_settings` table, one row per organization, created lazily on
  first read with empty lists (never with `src/settings/defaults.js` values —
  those are one company's data and must never reach another tenant);
- `GET /api/settings` (admin, it) and `PUT /api/settings` (admin) in
  `saas/src/server.js`, validating the same shapes as
  `InventoryStore.updateSettings()`: `excludedEmails[]`,
  `excludedNameRules[{id,tokens[]}]`, `identityGroups[{emails[],firstName,lastName}]`,
  `modelOverrides{serial→modelId}`;
- `loadImportPolicy(organizationId)` helper, called at the start of
  `createImportPreview()` and `applyImportBatch()`, result passed explicitly;
- persist the policy snapshot used by a preview in
  `import_batches.policy_json` so an apply cannot use a different policy than
  the preview the admin approved;
- audit `settings.update` with a before/after diff;
- settings screen in `saas/public/app.js` (a `renderSettings()` alongside
  `renderMembers()`), admin-only, three textarea-style editors — no design work.

### Migrations

```
version 4 (both dialects)
  CREATE TABLE organization_settings (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    excluded_emails_json TEXT NOT NULL DEFAULT '[]',
    excluded_name_rules_json TEXT NOT NULL DEFAULT '[]',
    identity_groups_json TEXT NOT NULL DEFAULT '[]',
    model_overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  ALTER TABLE import_batches ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
```

### Tests before ship

- unit: `shouldSkipImportedUser()` with two different policies returns different
  answers for the same person, in the same process, with no reset between calls;
- concurrency: two organizations post `/api/import/preview` with interleaved
  timing, org A excluding `x@a.test` and org B not; assert org B still gets the
  person and org A does not. This test must fail against the current
  `setRuntime*` implementation — write it first;
- identity groups configured in org A do not merge people in org B;
- `modelOverrides` set in org A are not applied to org B's identical serial;
- default exclusion lists from `src/settings/defaults.js` never appear in a new
  organization's settings;
- readonly member gets 403 on `PUT /api/settings`;
- the local app's existing import tests on branch `local` still pass with the
  shim (run the root `node --test` in CI).

### Risks

- this touches `src/utils/person-email-alias.js`, `src/store.js` and every
  mapper — it is a wide refactor of the code both products depend on, and the
  local app has no import test coverage for some paths;
- doing it as a `setRuntime*`-with-a-lock patch is tempting and cheaper by ~4
  days; that choice guarantees a tenant-isolation incident later;
- policy snapshotting into `import_batches` grows that table; cap the stored
  policy to the fields actually used.

---

## Phase 3 — Data-model parity and import fidelity (13 days)

**Goal:** the SaaS import produces the same outcome as the local app: catalogued
models, an assignment history with `reassign`, stable external ids, and
"missing from the last MDM export" detection.

### Sequencing decision: after the first pilot, in two slices

Do **not** block the first pilot on this phase. The pilot's purpose is to
validate tenant isolation, the invite flow and CSV mapping against real exports
(`saas/PILOT.md`), and the current model — `assets.model_name` as text,
`assets.person_id` as the single assignment — is sufficient to check serials and
counts.

But split the phase so the cheap, additive half lands *before* the pilot:

- **3a, before the pilot (3 days):** `assets.external_ids_json`,
  `assets.import_meta_json`, and the `asset_assignments` table, written by the
  import but not yet surfaced in the UI. These are pure additions with no
  backfill, and writing them from day one means the pilot accumulates real
  assignment history instead of a `person_id` snapshot that cannot be
  reconstructed later. Retrofitting history onto months of pilot data is
  impossible; retrofitting a catalog is merely tedious.
- **3b, done on branch `cursor/saas-tenant-options-e694`:** tenant-editable
  catalog (archive/sort, reset-defaults), broad default seed without MTR,
  org options (status/department/location with `countsAs`), custom fields,
  multi-MDM presets + column mapping + import profiles, and Settings UI.
  Intune/Jamf/Entra paths are unchanged; new presets sit alongside them.

### Work items — 3a

- migration adding `external_ids_json`, `import_meta_json` to `assets` and the
  `asset_assignments` table;
- `applyImportBatch()` in `saas/src/server.js`: write
  `external_ids_json` as `{ intuneDeviceId | jamfComputerId }` from
  `row.externalId`, and `import_meta_json` as
  `{ source, lastImportedAt, lastImportFile, missingFromLastImport: false }`,
  mirroring `InventoryStore.upsertImportAsset()`;
- asset matching order in `findAssetForImport` parity: match on external id
  first, then serial, then asset tag. Currently `applyImportBatch()` matches on
  `LOWER(serial_number)` only, so a device whose serial changes in the export
  creates a duplicate;
- open an `asset_assignments` row on assign, close the previous one
  (`ended_at`, `end_reason = 'Import <source>'`) on reassign — the logic in
  `InventoryStore.applyImportRows()` lines around `createImportAssignment()`;
- keep `assets.person_id` in sync as a denormalised "current assignee" so the
  existing `listAssets()` query and SPA keep working; add a test asserting it
  always equals the open assignment.

### Work items — 3b

- catalog tables `catalog_categories`, `catalog_brands`, `catalog_models`,
  scoped by `organization_id`, matching the local shape
  (`{ id, categoryId, brandId, name, generation, deviceType }`);
- seed a new organization's catalog from a shared, non-client-specific baseline —
  `InventoryStore.seedCatalog()` / `seedMissingCatalog()` need to be extracted
  into a data file in the shared package, not copied;
- `assets.model_id` added next to `assets.model_name`; backfill by running the
  resolver over existing rows, keep `model_name` as the fallback label for
  unresolved rows, do not drop it;
- integrate `src/import/model-resolver.js` (with the Phase 2 policy argument)
  into `buildSaasImportPreview()`; add the `needsReview` action and
  `intendedAction` that the local `previewRow()` produces, plus the `reassign`
  action that `saas/src/import-service.js` currently cannot express;
- extend the `import_rows.action` CHECK constraint to
  `('create','update','reassign','skip','needsReview')`;
- manual model selection in the preview UI (`renderImport()` in
  `saas/public/app.js`) writing to `organization_settings.model_overrides_json`,
  the SaaS equivalent of `store.setModelOverride()`;
- missing-from-MDM: after a successful apply, run the equivalent of
  `markMissingFromLastImport()` as a single `UPDATE` over
  `assets WHERE organization_id = ? AND import_meta_json->>'source' = ?`
  excluding touched serials and excluding `status IN ('retired','lost','stolen')`;
  audit each transition as `asset.missing_from_import`;
- `GET /api/assets?missingFromLastImport=true` and a filter in the SPA;
- `CREATE INDEX idx_assets_org_missing` on the extracted missing flag — this is
  the one place where a generated column beats JSON:
  `ALTER TABLE assets ADD COLUMN missing_from_last_import BOOLEAN NOT NULL DEFAULT FALSE`
  as a real column rather than reading it out of `import_meta_json`;
- the write endpoints the pilot will ask for anyway and that do not exist today:
  `PUT /api/people/:id`, `PUT /api/assets/:id`, `POST /api/assets/:id/reassign`,
  `POST /api/assets/:id/unassign`;
- decide on JSON storage: `TEXT` holding JSON keeps the SQLite/Postgres adapter
  in `saas/src/db.js` symmetric, `JSONB` would need dialect branching in
  `migrations.js` and in every query. Recommendation: `TEXT` for
  `external_ids_json` / `import_meta_json`, real columns for anything queried or
  indexed (`missing_from_last_import`, `model_id`, `intune_device_id`,
  `jamf_computer_id`).

**Status (tenant-options follow-up):** migration 6 adds archive/sort on the
catalog, `org_options`, `custom_field_defs`, `import_profiles`,
`assets.location_key` / `custom_json`, and widens `import_batches.source`.
Admins edit catalog/options/custom fields in Settings; import supports
additional MDM presets with a column-mapping fallback and saved profiles.
Intune, Jamf and Entra keep their existing mappers.

### Migrations

```
version 5 (3a, both dialects)
  ALTER TABLE assets ADD COLUMN external_ids_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE assets ADD COLUMN import_meta_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE assets ADD COLUMN intune_device_id TEXT;
  ALTER TABLE assets ADD COLUMN jamf_computer_id TEXT;
  ALTER TABLE assets ADD COLUMN missing_from_last_import BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE asset_assignments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL,
    ended_at TEXT,
    reason TEXT,
    end_reason TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_assignments_asset ON asset_assignments(asset_id, assigned_at);
  CREATE INDEX idx_assignments_person_open
    ON asset_assignments(organization_id, person_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX idx_assignments_one_open_per_asset
    ON asset_assignments(asset_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX idx_assets_org_intune ON assets(organization_id, intune_device_id)
    WHERE intune_device_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_assets_org_jamf ON assets(organization_id, jamf_computer_id)
    WHERE jamf_computer_id IS NOT NULL;
  CREATE INDEX idx_assets_org_missing ON assets(organization_id, missing_from_last_import);

version 6 (3b, both dialects)
  CREATE TABLE catalog_categories (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL,
    UNIQUE (organization_id, name));
  CREATE TABLE catalog_brands (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE, category_id TEXT NOT NULL
    REFERENCES catalog_categories(id) ON DELETE CASCADE, name TEXT NOT NULL,
    UNIQUE (organization_id, category_id, name));
  CREATE TABLE catalog_models (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE, category_id TEXT NOT NULL,
    brand_id TEXT NOT NULL REFERENCES catalog_brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL, generation TEXT NOT NULL DEFAULT 'Standard',
    device_type TEXT NOT NULL DEFAULT 'Laptop',
    UNIQUE (organization_id, brand_id, name, generation));
  ALTER TABLE assets ADD COLUMN model_id TEXT REFERENCES catalog_models(id);
  -- import_rows.action CHECK is recreated (SQLite: new table + copy;
  -- Postgres: DROP CONSTRAINT / ADD CONSTRAINT)
```

The `import_rows.action` CHECK constraint change is the first migration that is
not a plain `ADD COLUMN`. On SQLite it requires the 12-step table rebuild; on
Postgres it is a constraint swap. This is where the Phase 0 advisory lock and
the "additive, backward-compatible" rule start to matter, and it is a good
argument for deleting `import_rows` older than 30 days first (see GDPR below) so
the rebuild is cheap.

### Tests before ship

- import the same Intune CSV twice: second run creates nothing, updates
  everything, opens no new assignment;
- import with a changed primary user: produces action `reassign`, closes the old
  `asset_assignments` row with `end_reason`, opens exactly one new one, and
  `assets.person_id` matches the open row;
- a device present in export 1 and absent from export 2 gets
  `missing_from_last_import = true`, is audited once, and is not re-flagged on a
  third import;
- a retired device absent from the export is *not* flagged;
- missing-detection is scoped per source: a Jamf import does not flag Intune
  devices, and a Jamf import in org A does not flag anything in org B;
- external id match wins over serial match when the serial changed;
- unresolved model produces `needsReview`, apply refuses the batch, manual
  override resolves it and is persisted in `organization_settings`;
- the unique partial index rejects two open assignments for one asset;
- `npm run pilot:validate` extended to cover reassign and missing-device
  isolation across the two test organizations;
- migration 5 and 6 applied against a `pg_dump` of the live staging database in
  CI, not only against an empty schema.

### Risks

- the missing-from-MDM flag on a partial export (an admin uploads a filtered
  CSV) mass-flags real devices as missing; require the preview to show the
  would-be-missing count and make the apply refuse if it exceeds ~30% of the
  organization's devices for that source unless explicitly confirmed;
- `applyImportBatch()` already does per-row queries inside one transaction; with
  catalog resolution added, a 5 000-row export will hold a write transaction for
  a long time on a `basic-256mb` instance. Batch the reads (one `SELECT` for all
  serials up front) before this phase, not after the first complaint;
- catalog seeding per organization duplicates a few hundred rows per tenant; it
  is the right trade for tenant-editable catalogs, but it makes the seed data a
  migration concern (new iPhone model → every organization needs it).

---

## Phase 4 — Entitlements and billing (7 days)

**Goal:** an organization has a plan, limits are enforced, and money can be
collected without a developer in the loop.

### Options

- **manual invoicing.** Contract, bank transfer, accountant handles VAT and
  reverse charge. Zero payment code; only plan/limit columns and enforcement.
  Fits EU B2B buyers who expect a PO, an invoice and a DPA, and who will not put
  a card into a form.
- **Stripe Billing.** Hosted Checkout + Customer Portal, per-seat or
  per-managed-device tiers, webhooks into a `subscriptions` table. Stripe
  supports EU VAT and reverse charge via Stripe Tax but the company stays the
  merchant of record and files OSS itself.
- **Paddle / Lemon Squeezy (merchant of record).** They take VAT registration,
  invoicing and OSS filing off the table entirely, at a higher percentage and
  with much less control over invoice layout and dunning. Attractive for
  self-serve, awkward for negotiated B2B contracts.

### Recommendation

Ship enforcement now, payments later. Concretely: implement the entitlement
layer in Phase 4 and invoice the first three to five customers manually; add
Stripe Billing once there are more than five paying organizations or the first
self-serve signup arrives.

Reasoning: at one to five customers, payment automation returns nothing — the
finance work is three invoices a quarter — while Stripe integration, webhook
idempotency, dunning and tax configuration is a week that produces no product.
The part that *is* expensive to retrofit is entitlement plumbing, because it
touches every write path; doing it now means billing later is an additive
integration rather than a refactor. Prefer per-managed-device pricing over
per-seat: it tracks the value the product delivers (devices under management),
it is a number the product already knows, and IT teams have few seats and many
devices, so per-seat pricing would underprice large tenants.

### Work items

- `organizations`: add `plan`, `status` (`trial`, `active`, `past_due`,
  `suspended`), `device_limit`, `trial_ends_at`, `billing_email`;
- `assertWithinPlan(session)` called from `createAsset()`, `createPerson()` and
  `applyImportBatch()`; on breach return 402 with the current count and limit,
  and in the import case allow the apply but surface the overage in the preview
  summary — silently truncating an import is worse than billing an overage;
- `status = 'suspended'` makes `requireSession()` allow only `GET` requests and
  the organization export endpoint. Never block data export for non-payment;
- `GET /api/billing` returning plan, usage (`SELECT COUNT(*) FROM assets`),
  limit and `trial_ends_at`; a usage banner in `saas/public/app.js`;
- a `subscriptions` table created now but unused, so the Stripe webhook has a
  landing place;
- price list and plan definitions in one module, not scattered constants.

### Migrations

```
version 7 (both dialects)
  ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial';
  ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'trial';
  ALTER TABLE organizations ADD COLUMN device_limit INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE organizations ADD COLUMN trial_ends_at TEXT;
  ALTER TABLE organizations ADD COLUMN billing_email TEXT;

  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    current_period_end TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, provider_subscription_id)
  );
```

### Tests before ship

- an organization at `device_limit` cannot create an asset (402) but can still
  list and export;
- an import that would exceed the limit reports the overage in the preview and
  still applies;
- `status = 'suspended'` blocks every mutation and allows `GET` and export;
- expired trial moves to `past_due` and not to `suspended` in the same step;
- limits are per organization: filling org A's quota does not affect org B.

### Risks

- hard limits on import are a support burden; the overage-not-truncation choice
  above is deliberate;
- `device_limit` counted over all assets including retired ones will feel unfair;
  count non-retired only, and write that into the price list;
- any later change of pricing metric (devices → seats) invalidates signed
  contracts. Decide the metric before the first contract, not after.

---

## Phase 5 — Documents, PV DOCX, invoices (12 days, after the first paying customer)

**Goal:** close the remaining gap to the local app for features clients will
actually ask for, once someone is paying for them.

Deliberately last, and deliberately not detailed here: `handoverDocuments`,
`personDocuments`, `invoices` and the PV DOCX generation
(`renderHandoverDocx`, `templates/pv-tchibo.docx`) all require object storage
(the local app writes to a local `uploads/` tree, which a multi-instance web
service cannot do), per-tenant document templates instead of one hard-coded
Tchibo DOCX, and a virus-scanning decision for client uploads. The invoice PDF
parsers in `src/import/invoice-template-parsers.js` are vendor-specific to one
company's suppliers and are close to worthless for a new tenant without
retraining, so this is a per-client services conversation, not a product
feature yet. Estimate is a placeholder pending a real client requirement.

---

## GDPR and EU data residency

This targets EU clients and processes employee personal data (names, corporate
emails, UPNs, departments, device assignments). The company is a **processor**;
each client is the controller. Required before the first paid contract, folded
into Phases 0–3:

- all infrastructure in the EU: Render Frankfurt (web + Postgres) is already
  correct; keep it, and pick EU regions for every added service (Sentry `de`,
  Postmark EU / Scaleway TEM, backup object storage in Frankfurt or Paris);
- a DPA template with a subprocessor list (Render/AWS, the mail provider, Sentry,
  the backup storage provider) and a commitment to notify on changes;
- retention: `import_rows.data_json` currently stores the **raw MDM export row
  per device, forever**, including UPNs and display names, for every preview
  including previews that were never applied. Add a daily job deleting
  `import_rows` and `import_batches` older than 30 days (previews older than 7
  days), and drop `data_json` on batches already applied. This is the single
  largest unnecessary personal-data store in the system;
- retention for `audit_logs`: 12 months rolling, configurable per organization,
  documented in the DPA;
- `GET /api/organizations/current/export` producing a complete JSON export
  (portability, and a defensible answer to "what if you disappear");
- `DELETE /api/organizations/current` (admin, with a typed confirmation) doing a
  real delete — the `ON DELETE CASCADE` chain in `saas/src/migrations.js`
  already covers every tenant table, which makes erasure genuinely cheap; add a
  30-day soft-delete window before the cascade fires, and a test that asserts no
  orphan rows remain for any table with an `organization_id`;
- per-person erasure: `DELETE /api/people/:id` exists but leaves the person's
  name inside `audit_logs.details_json` and `import_rows.data_json`. Add an
  anonymisation pass over both for that person id, or accept and document
  audit-log retention as a legitimate-interest exception;
- breach process: a one-page runbook (who is notified, within 72 hours, what
  evidence Sentry and the Render logs provide);
- records of processing and a short security description (encryption in transit,
  scrypt password hashing, role enforcement revalidated per request, per-org
  isolation tested by `npm run pilot:validate`) — clients' security
  questionnaires will ask, and answering from the existing tests is cheap.

---

## Code sharing: `local` branch vs `saas` branch

### Current state

`local` is a strict ancestor of `saas`: five commits ahead, and the only changes
to shared code are the `useDefaults` flags added to
`src/import/excluded-users.js` and `src/import/known-person-aliases.js`. The
SaaS app imports the local app's modules by relative path
(`import { parseCsv } from '../../src/import/csv-parser.js'` in
`saas/src/import-service.js`), which works only because both live in one
checkout. `render.yaml`'s `buildFilter` already lists `src/import/**`,
`src/settings/**` and `src/utils/**` as SaaS build inputs. There is no drift
today, and the README's "cherry-pick fixes from `local`" workflow has not yet
been exercised.

### Recommendation: converge the repository, keep two deployables

Merge `saas` into a single trunk now and delete the long-lived branch split.
Restructure to `apps/local/`, `apps/saas/` and `packages/inventory-core/` (the
import pipeline, `src/settings`, `src/utils/person-email-alias.js`, the model
resolver and the domain vocabulary), consumed through npm workspaces so the
relative-path coupling becomes a real dependency with a real public API. Keep
two separately deployed applications — do not try to make the local offline app
a client of the SaaS backend.

Reasoning: the two branches are not actually diverging codebases, they are one
codebase with a directory that only exists on one branch, so the merge is nearly
free **today** and gets monotonically more expensive with every commit. The
branch split also buys nothing that directories do not: both products already
build from the same tree, and cherry-picking import fixes between branches is
manual work that will silently fail the first time the two copies of
`person-email-alias.js` differ. Full convergence onto one running product is the
wrong extreme, because the local app's value is that it is offline,
single-tenant and file-backed, and porting it to Postgres and organization
scoping is a larger project than the SaaS roadmap above.

The Phase 2 policy refactor is the natural moment to do it: that phase already
rewrites the interface of every shared module, and a shared package with an
explicit `ImportPolicy` argument is exactly the boundary that makes the
process-global state impossible to reintroduce. Budget 3 dev-days for the
restructure inside Phase 2, plus updating `render.yaml` `buildCommand`,
`buildFilter` and the CI workflow paths.

Concretely, in order:

1. merge `saas` into trunk, rename the default branch, keep `local` as a tag for
   the last offline release;
2. `packages/inventory-core` with an explicit `index.js` export surface; both
   apps import from it, no relative paths across app boundaries;
3. do the Phase 2 policy refactor inside the package, with the `setRuntime*`
   shim kept only until `apps/local` is converted;
4. delete the shim and the `src/settings/defaults.js` company-specific constants
   from the package — move them into `apps/local` seed data, where they belong.

---

## Product direction: IT issues inbox

The commercial value is the list of things to fix, not the inventory table.
Phases after Phase 3b follow that:

1. **Exceptions and inbox — done.** Migration 7 (presence per source,
   `last_seen_at`, `exceptions`, `exception_events`, rule settings,
   `connections`), seven rules computed from imported data, Issues tab,
   dashboard cards, person/device overview, rule settings.
2. **Live connectors — Entra, Intune and Jamf computers done.** Graph users /
   managed devices and Jamf Classic computers sync through
   `saas/src/connectors/{entra,intune,jamf}.js` into the import + exception
   pipeline. Next: scheduled sync, Jamf mobile devices, and Entra
   `signInActivity` for stale accounts.
3. **Confirmed actions.** Start with "account disabled → device still
   assigned → alert → IT approves → mark for recovery / reassign", then
   Jamf lock or unassign behind an explicit confirmation, a dry-run view and
   an audit entry. No destructive action without a human approval.
4. **Deeper checks** once live data exists: MFA registration, licence
   assignment vs. active users, Jamf/Intune compliance state.

## Sequencing summary

- **now → 2026-10-21:** Phase 0. Non-negotiable, the database expires.
- **Phase 3a** (3 days) folded in before the pilot so assignment history exists
  from the first real import.
- **pilot** per `saas/PILOT.md`, with Phase 1's email work done so invitations
  are not copy-pasted by hand.
- **Phase 2** immediately after the pilot, before any second organization is
  onboarded with its own settings.
- **Phase 3b** (tenant catalog, options, multi-MDM import) is implemented;
  remaining Phase 3 polish is optional before **Phase 4**.
- **Phase 5** only against a paying customer's written requirement.
