# Scripted test environment

`npm run seed:test` provisions a complete pilot environment against any running
instance through the public API only. It creates two organizations, invites and
accepts one `it` and one `readonly` member per organization, imports the Intune
CSV into organization A and the Jamf CSV into organization B, then verifies
tenant isolation and role enforcement before printing every credential.

## Run it

```bash
cd saas
TARGET_URL=https://it-inventory-saas-staging.onrender.com npm run seed:test
```

`TARGET_URL` defaults to `http://localhost:3000`. Against a local server start
it first with `npm run dev`.

Organization names and e-mail addresses carry a suffix derived from the current
time, so repeated runs never collide. Set `SEED_SUFFIX` to pin it, which is only
useful when a run fails halfway and you want to inspect what it left behind.

Any non-2xx response aborts the run with the method, path, status and body. The
script exits non-zero if a verification check fails.

## What it verifies

| Check | Expected |
| --- | --- |
| organization B lists organization A people | 200, no shared ids |
| organization B lists organization A assets | 200, no shared ids |
| organization B deletes an organization A person | 404 |
| `readonly` creates a person | 403 |
| `readonly` previews an import | 403 |
| `readonly` applies an import | 403 |
| `it` applies an import | 200 |
| each audit log | 200, only that organization's members |

## Seeded accounts

Each run prints its own credentials. The shape is fixed:

| Role | E-mail | Password |
| --- | --- | --- |
| admin | `admin-a-<suffix>@pilot.test` | `Pilot-<suffix>-admin-a` |
| it | `it-a-<suffix>@pilot.test` | `Pilot-<suffix>-it-a` |
| readonly | `readonly-a-<suffix>@pilot.test` | `Pilot-<suffix>-ro-a` |

Organization B uses the same pattern with `-b`. These are throwaway pilot
credentials for a staging instance holding only sample CSV data; do not reuse
the pattern for anything that matters.

## Teardown

```bash
cd saas
TARGET_URL=https://it-inventory-saas-staging.onrender.com \
  RESET_EMAIL=admin-a-<suffix>@pilot.test \
  RESET_PASSWORD=Pilot-<suffix>-admin-a \
  npm run reset:test
```

Add `RESET_ORG_ID` when the account belongs to more than one organization.

Teardown is deliberately partial. The API exposes `DELETE /api/people/:id` and
`DELETE /api/assets/:id` and nothing else, so the script empties both tables and
stops there. Organizations, users, memberships, invitations, import batches,
import rows and audit logs have no delete route and stay behind; the script
prints the SQL for the manual step:

```sql
DELETE FROM organizations WHERE id = '<organization id>';
DELETE FROM users u WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
```

Every tenant table references `organizations(id)` with `ON DELETE CASCADE`, so
the first statement removes the rest. Run it from the Render dashboard shell of
`it-inventory-saas-staging-db`.

## Staging

- URL: <https://it-inventory-saas-staging.onrender.com>
- Render service `srv-daofucbtqb8s73f6hjkg`, Frankfurt, free plan, PostgreSQL.
- The free instance sleeps when idle, so the seed script waits up to two minutes
  for `/api/ready` before the first request.
