# Privacy & GDPR (product notes)

What the product does for GDPR on a **zero extra cost** path, and what remains
outside the free tier.

## Built into the product

- **EU hosting ready:** reference staging uses Render Frankfurt.
- **Tenant isolation:** every business table is scoped by `organization_id`;
  covered by `npm run pilot:validate`.
- **Person erasure (Art. 17):** `DELETE /api/people/:id` removes the person and
  scrubs residual PII in import rows, issues, manager e-mails, asset
  source-presence, settings identity lists, and audit detail values.
- **Organization erasure:** `DELETE /api/organizations/current` (typed name)
  cascades tenant data and deletes orphaned login accounts.
- **Portability / exit:** `GET /api/organizations/current/export` (admin) —
  also **Settings → Privacy → Download JSON export**. Connector secrets are
  never exported.
- **Retention:** per-org settings + `POST /api/privacy/retention/run` or
  `npm run retention:cleanup` (free cron / laptop).
- **Invite tokens:** delivered in the URL fragment (`/#invite=…`) so they are
  less likely to appear in proxy access logs.
- **Member removal audit:** stores e-mail domain only, not the full address.
- **Documents:** `docs/DPA.md`, `docs/SUBPROCESSORS.md` (templates).

## Defaults

| Item | Default |
|------|---------|
| Preview import batches | 7 days |
| Applied / cancelled batches | 30 days |
| Audit logs | 365 days |
| Applied import `data_json` | scrubbed to keys on cleanup |

## Explicitly not claimed on free tier

- Formal legal review of the DPA
- Paid log retention / SIEM, e-mail delivery of invites, or automated breach
  paging
- Soft-delete grace window before organization cascade
- Guarantees about Render free-tier backup durability (run `npm run backup`
  yourself against Postgres when you care)

## Operator checklist

1. Keep `SAAS_PUBLIC_URL` set to the real HTTPS origin.
2. Keep `SAAS_CONNECTOR_KEY` set in any environment that stores live credentials.
3. Schedule `npm run retention:cleanup` daily if the app is used continuously.
4. Fill `docs/DPA.md` party names before a paid customer signs.
