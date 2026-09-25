# Pricing (manual invoicing)

Payments stay out of the product for the first customers. This document is the
price list and entitlement contract the app already enforces.

## Metric

**Managed devices** = rows in `assets` whose status is not `retired`.

Seats (admin / IT / readonly) are not metered. Imports that would exceed the
limit still apply; the preview surfaces the overage so finance can invoice it.
Manual `POST /api/assets` returns **402** when the org is at its limit.

## Plans

| Plan | Managed devices | Monthly | Yearly |
|------|-----------------|---------|--------|
| Trial (14 days) | 50 | €0 | €0 |
| Starter | 100 | €79 | €790 |
| Team | 500 | €199 | €1 990 |
| Organization | custom (default catalog 2 000) | custom | custom |

Source of truth: `saas/src/plans.js` (`PLANS`, `listPublicPlans()`).

Public JSON: `GET /api/plans`. Authenticated usage: `GET /api/billing`.

## Org fields

On `organizations` (migration 8):

- `plan` — `trial` | `starter` | `team` | `org`
- `status` — `trial` | `active` | `past_due` | `suspended`
- `device_limit` — integer cap (defaults from the plan)
- `trial_ends_at` — ISO timestamp; when past and status is still `trial`,
  reads normalize to `past_due` (not auto-`suspended`)
- `billing_email` — who receives the invoice

`subscriptions` exists for a future Stripe webhook landing place; unused now.

## Status behaviour

| Status | Reads / export | Mutations |
|--------|----------------|-----------|
| `trial` / `active` / `past_due` | yes | yes (device create still respects limit) |
| `suspended` | yes (GET + CSV export) | **402 Payment Required** |

Never block export for non-payment.

## Operator: change a plan

```bash
cd saas
# Local sqlite
SAAS_DB_PATH=./data/saas.sqlite node scripts/set-plan.js --slug acme-it --plan starter --status active

# Staging / Postgres
DATABASE_URL=postgres://… node scripts/set-plan.js --email billing@client.com --plan team --status active --limit 500
```

Invoice outside the product (email / Wise / bank transfer). After payment,
run `set-plan` and tell the customer to refresh.

## Stripe later

Add Checkout + webhooks that write `subscriptions` and update
`organizations.plan` / `status` / `device_limit`. Entitlement checks already
read those columns — no write-path refactor.
