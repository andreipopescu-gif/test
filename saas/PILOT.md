# MVP pilot runbook

## Automated gate

Run before every pilot:

```bash
cd saas
npm run pilot:validate
```

The gate creates two temporary organizations and verifies:

- the same serial and asset tag can exist in both organizations;
- a person from one organization cannot be assigned in another;
- read-only members cannot mutate data;
- one account can select between multiple organizations;
- Intune import affects only organization A;
- Jamf import affects only organization B;
- import actions are present in the correct audit log.

Temporary data is deleted at the end.

## Scripted pilot environment

`npm run seed:test` provisions two organizations with admin, `it` and
`readonly` accounts, imports both CSV fixtures and re-checks isolation against a
running instance, local or staging. See [TEST-ENV.md](TEST-ENV.md) for the
credentials, the verification matrix and the teardown limits.

## Staging pilot

1. Deploy branch `saas` using the root `render.yaml`.
2. Check `GET /api/health` and `GET /api/ready`, or run:

   ```bash
   STAGING_URL=https://your-staging-host npm run check:staging
   ```

3. Create a test organization for the first client, or run
   `TARGET_URL=https://your-staging-host npm run seed:test` for a full
   two-organization sandbox.
4. Invite one `it` user and one `readonly` user.
5. Import one recent Intune CSV and one Jamf CSV.
6. Compare counts and five random serial numbers with the source exports.
7. Confirm the read-only account cannot create, delete or import.
8. Delete or anonymize pilot data if the client does not continue
   (`npm run reset:test`, plus the manual SQL it prints).

## Backup and tested restore

The hosting provider's snapshots are not the backup strategy: the free
PostgreSQL plan has none, and a provider-held snapshot disappears with the
account. Take an independent dump before anything that touches the database —
a plan change, a migration, or the end of a pilot.

```bash
cd saas
DATABASE_URL=<connection string> BACKUP_DIR=~/itinv-backups npm run backup
```

The script writes a compressed custom-format dump, refuses a suspiciously small
file, verifies the table of contents with `pg_restore --list`, and prunes dumps
older than `BACKUP_RETAIN_DAYS` (default 30).

An untested backup is not a backup. Restore into a scratch database and run the
suite against the restored copy:

```bash
createdb itinv_restore_check
pg_restore --dbname=postgresql://…/itinv_restore_check --no-owner <dump file>
cd saas
TEST_DATABASE_URL=postgresql://…/itinv_restore_check \
  DATABASE_URL=postgresql://…/itinv_restore_check npm run test:postgres
```

Last verified run, on a local PostgreSQL 16 with a freshly migrated schema:
dump 0.03 MB, restore 0.11 s, all four PostgreSQL tests green. Re-measure and
update this line once the database holds real pilot data — the restore time is
the number that matters during an incident.

## Exit criteria

- no cross-organization data is visible;
- import creates/updates expected devices without duplicates;
- all mutations appear in audit;
- readiness stays healthy;
- the client confirms the MVP workflow is usable.

Invoice import, PV DOCX, hosted MDM sync and billing remain out of scope.
