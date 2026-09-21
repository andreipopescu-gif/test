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

E-mail addresses follow a fixed shape; passwords do not. Each account gets
`Pilot!` plus 12 random bytes, generated per run and printed once by the script.
Nothing about a password can be derived from the address, so a seeded account
left running on staging is not an open door.

| Role | E-mail | Password |
| --- | --- | --- |
| admin | `admin-a-<suffix>@pilot.test` | random, printed by the run |
| it | `it-a-<suffix>@pilot.test` | random, printed by the run |
| readonly | `readonly-a-<suffix>@pilot.test` | random, printed by the run |

Organization B uses the same address pattern with `-b`. Capture the output when
the run finishes: the passwords are not stored anywhere and cannot be recovered.
These are still throwaway credentials for an instance holding sample CSV data.

When the target closes registration (any production host without
`SAAS_ALLOW_REGISTRATION=true`), pass the shared token:

```bash
SEED_REGISTRATION_TOKEN=<token from the host environment> \
  TARGET_URL=https://it-inventory-saas-staging.onrender.com npm run seed:test
```

## Teardown

```bash
cd saas
TARGET_URL=https://it-inventory-saas-staging.onrender.com \
  RESET_EMAIL=admin-a-<suffix>@pilot.test \
  RESET_PASSWORD=<password printed by the seed run> \
  npm run reset:test
```

Add `RESET_ORG_ID` when the account belongs to more than one organization. The
account must be an admin of the organization being removed.

Teardown is complete and needs no database access. `DELETE
/api/organizations/current` cascades through people, devices, invitations,
import batches, import rows and the audit log, and every member left without
another organization is deleted with it. Run it once per seeded organization —
`-a` and `-b` are separate.

To keep the organization and its members while emptying the inventory, set
`RESET_KEEP_ORGANIZATION=true`. That is the right mode between two import
tests on the same pilot tenant.

## Staging

- URL: <https://it-inventory-saas-staging.onrender.com>
- Render service `srv-daofucbtqb8s73f6hjkg`, Frankfurt, free plan, PostgreSQL.
- The free instance sleeps when idle, so the seed script waits up to two minutes
  for `/api/ready` before the first request.
