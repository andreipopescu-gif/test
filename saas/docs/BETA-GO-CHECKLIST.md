# Beta GO checklist (internal)

Gate before Wave 1 (3 testers). Staging:
`https://it-inventory-saas-staging.onrender.com`.

Run the automated gate first:

```bash
cd saas
npm run beta:gate
```

---

## 1. Status by category

| Zone | Status | Notes |
|------|--------|--------|
| Security | **PASS** (with residual XSS model) | HttpOnly session, Origin CSRF for cookies, RBAC on API, tenant filters, rate limit, AES-GCM secrets, SSRF denylist, headers, escapeHtml, `npm audit` clean. XSS can still drive same-origin requests while logged in. |
| Multi-tenancy | **PASS** | Covered by `pilot:validate`, `seed:test`, exception/lifecycle tests. Manual IDOR still required once on staging. |
| Auth / users | **PASS** | Login/register/invite/logout/password+epoch. Manual matrix below. |
| Sync Entra/Jamf/Intune | **PASS** (connectors live; load test manual) | Live connectors + CSV path. Scale 1k+ users not automated. |
| Data integrity | **PASS** basic | Idempotent import/sync tested in unit/integration; deletion behaviour defined (person erase / org cascade when GDPR branch merged). |
| UX / core flows | **PASS** for desktop MVP | Empty/loading/error states present; mobile not polished. |
| Observability | **GAP — recommended** | No request IDs / Sentry. Only `console.error` on 500s. Add before Wave 3 if possible. |
| Performance | **Basic PASS** | Free Render sleeps; first hit slow. OK for 10–15 testers. |
| Documentation | **PASS minimal** | This pack + PILOT.md + TEST-ENV.md. |
| Backup / restore | **PARTIAL** | `npm run backup` + documented restore. Free Render Postgres has **no** provider backup. Re-run restore check before Wave 1 with current staging dump. |

---

## 2. RBAC matrix (API truth)

Any authenticated member can **view** dashboard, people, devices, issues, reports, device CSV export.

| Action | Admin | IT | Readonly |
|--------|:-----:|:--:|:--------:|
| View dashboard / people / devices / issues | ✅ | ✅ | ✅ |
| Import CSV / apply import | ✅ | ✅ | ❌ |
| Save MDM credentials | ✅ | ❌ | ❌ |
| Sync connector | ✅ | ✅ | ❌ |
| Edit / delete person or device | ✅ | ✅ | ❌ |
| Assign / resolve / snooze exception | ✅ | ✅ | ❌ |
| Invite user / change role / remove member | ✅ | ❌ | ❌ |
| Delete organization | ✅ | ❌ | ❌ |
| Settings (import rules, catalog categories/brands) | ✅ | ❌* | ❌ |
| Catalog models create | ✅ | ✅ | ❌ |

\* IT can create catalog **models**; categories/brands/reset are admin-only.

Always verify with **API calls**, not only hidden UI buttons.

---

## 3. Manual regression before Wave 1

### A. Authentication (30 min)

- [ ] Wrong password → 401, no session cookie  
- [ ] Unknown e-mail → 401, similar timing  
- [ ] Rapid login attempts → 429  
- [ ] Logout clears session; Back button does not restore app data  
- [ ] Change password → old session 401; new password works  
- [ ] Second browser: after password change, old browser loses access  
- [ ] Logout in browser A: browser B still works until password change / expiry (cookie logout bumps epoch → **both** die after logout on current code)

### B. Multi-tenancy (45 min) — **test #1**

Seed with `npm run seed:test` against staging. As Org A admin:

- [ ] `GET/PUT/DELETE /api/assets/{idFromB}` → 404  
- [ ] `GET/PUT/DELETE /api/people/{idFromB}` → 404  
- [ ] `GET/PATCH /api/exceptions/{idFromB}` → 404  
- [ ] `GET /api/assets/{idFromB}` detail / overview-style routes if any → 404  
- [ ] Guess sequential ids if any non-UUID leftovers → 404  
- [ ] Confirm response bodies never include Org B fields  

### C. RBAC (20 min)

For admin / it / readonly from seed: hit import, connections PUT, sync, invite, org delete. Expect the matrix above (403 where ❌).

### D. Product exceptions (30 min)

```bash
TARGET_URL=https://it-inventory-saas-staging.onrender.com \
  SEED_REGISTRATION_TOKEN=… npm run seed:demo
```

Confirm Issues shows examples of all seven rules. Walk OPEN → understand → ASSIGN → RESOLVE once.

### E. CSV toxicity (20 min)

Import (as IT) against a throwaway org: empty, 1-row, unicode/Romanian, quoted commas, `=CMD(...)` in a name cell. Confirm UI/DB show escaped/literal text, not executed formulas. Large file near `SAAS_MAX_UPLOAD_MB` → clean reject or success.

### F. Backup

- [ ] `DATABASE_URL=… npm run backup`  
- [ ] Restore to scratch DB + `npm run test:postgres`  
- [ ] Update “Last verified” line in `PILOT.md`

---

## 4. Wave plan

| Wave | People | Goal |
|------|--------|------|
| 1 | 3 (IT admin, helpdesk, product-newbie) | Watch everything; fix P0/P1 |
| 2 | +5 | Spot repeated confusion |
| 3 | +5–7 | Activation → sync → exception → resolve → return |

Give only [BETA-TEST-PACK.md](./BETA-TEST-PACK.md). Do not narrate clicks.

**GO for Wave 1** when: `npm run beta:gate` green, manual A–C checked on staging, one successful `seed:demo`, backup restore re-verified, no open P0.

**NO-GO** if: cross-tenant data leak, auth broken, sync destroys data, or restore unknown.

---

## 5. Observability minimum (Wave 3)

Before scaling past ~10 concurrent humans, add at least:

- structured request log: time, method, path, status, duration, `organizationId`, `userId` (never secrets)  
- error tracker (Sentry `de`) or Render log alerts on 5xx  

Until then, watch Render logs during Wave 1 sessions live.
