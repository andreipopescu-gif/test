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

## Staging pilot

1. Deploy branch `saas` using the root `render.yaml`.
2. Check `GET /api/health` and `GET /api/ready`, or run:

   ```bash
   STAGING_URL=https://your-staging-host npm run check:staging
   ```

3. Create a test organization for the first client.
4. Invite one `it` user and one `readonly` user.
5. Import one recent Intune CSV and one Jamf CSV.
6. Compare counts and five random serial numbers with the source exports.
7. Confirm the read-only account cannot create, delete or import.
8. Delete or anonymize pilot data if the client does not continue.

## Exit criteria

- no cross-organization data is visible;
- import creates/updates expected devices without duplicates;
- all mutations appear in audit;
- readiness stays healthy;
- the client confirms the MVP workflow is usable.

Invoice import, PV DOCX, hosted MDM sync and billing remain out of scope.
