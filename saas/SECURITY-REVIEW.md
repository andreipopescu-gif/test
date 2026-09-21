# Security review — SaaS MVP

Adversarial review of `saas/` on branch `saas`, against the code as committed plus the
uncommitted `scripts/seed-test-env.js` and `scripts/reset-test-env.js`, and read-only
probing of <https://it-inventory-saas-staging.onrender.com>.

Every finding below is backed by a file and line reference and a concrete attack.
`CONFIRMED` means the exploit was executed against a locally running instance (or, for
deployment facts, observed on staging). `SUSPECTED` means code reading only.

| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 5 |
| Medium | 8 |
| Low | 6 |

What was attacked and held up is in [What is solid](#what-is-solid). Nothing in that
section is a finding; it is there so the list above is not mistaken for the whole picture.

---

## Critical

### C1 — Hardcoded fallback JWT secret gives full cross-tenant authentication bypass

**Files:** `saas/src/auth.js:3`, `saas/src/server.js:24-26`
**Status:** CONFIRMED

`jwtSecret()` falls back to the literal string `dev-only-change-me` whenever
`SAAS_JWT_SECRET` is unset. The only guard is the boot check at `server.js:24`, which
tests `process.env.NODE_ENV === 'production'` exactly. Any deployment where `NODE_ENV`
is unset, or is `staging`, `prod`, `Production`, or anything else, starts happily and
signs and verifies tokens with a secret that is published in this repository.

Attack: knowing only a target organization's UUID and a member's user UUID (both are
returned to any member of that organization, and both are emitted by
`scripts/seed-test-env.js`), an attacker mints
`HS256({sub, org, role:'admin', exp})` with `dev-only-change-me` and has full admin
access to that tenant. No login, no password, no invitation.

Confirmed locally against a server started without `SAAS_JWT_SECRET`: a forged token
returned `200` from `GET /api/me` with the victim's user and organization.

Staging is currently not vulnerable — `render.yaml:28-33` sets `NODE_ENV=production`
and a generated `SAAS_JWT_SECRET` — but the safety of the entire authentication system
rests on one environment variable string comparison.

**Fix:** remove the fallback. `auth.js` should read the secret once at module load and
throw if it is missing or shorter than 32 bytes, regardless of `NODE_ENV`.

---

## High

### H1 — Rate limiting is bypassed by a client-supplied `X-Forwarded-For` header

**File:** `saas/src/server.js:881-898` (specifically `:882`)
**Status:** CONFIRMED

`enforceRateLimit` takes the **first** element of `X-Forwarded-For` as the client
identity. That element is whatever the client typed. Both Cloudflare and Render append
the real peer address to the end of the header rather than replacing it, so the first
element is attacker-controlled in production as well as locally.

Confirmed locally: 40 invalid logins from one address → 17 allowed, 23 blocked with
HTTP 429. 60 invalid logins with a rotating `X-Forwarded-For` → **60 allowed, 0
blocked**. I did not run a 20+ request burst against staging, to avoid abusing the live
instance; the header handling in the deployed code is identical.

This is not only a credential brute-force problem. The `auth` bucket is the only control
on `/api/auth/login`, `/api/auth/register` and `/api/invitations/accept`, and the
`upload` bucket is the only control on `/api/import/preview`. Removing it unlocks H2,
H3 and H5.

**Fix:** take the *last* untrusted hop (or `req.socket.remoteAddress`) unless a
`TRUSTED_PROXY_COUNT` is configured, and count from the right-hand side of the header.
Add a per-account counter on `/api/auth/login` in addition to the per-IP one.

### H2 — Quadratic CPU cost in the CSV import pipeline freezes the instance for every tenant

**Files:** `src/import/intune-mapper.js:148-161`, `src/import/csv-parser.js:46-52`,
`saas/src/server.js:610-616`
**Status:** CONFIRMED

`field()` calls `Object.entries(record)` on every lookup and then linearly scans that
array, running `normalizeKey()` (a `toLowerCase` plus a regex) on each candidate key.
`mapRow` performs roughly twenty `field()` calls with up to ten aliases each, per row.
Cost is therefore `rows × aliases × columns`, with a fresh entries array allocated each
time. The column count is entirely attacker-controlled: `parseCsv` creates one record
property per header cell, with no cap.

Measured, in-process:

| CSV | Size | `buildSaasImportPreview` |
| --- | --- | --- |
| 10 cols × 500 rows | 0.03 MB | 41 ms |
| 2 000 cols × 500 rows | 1.94 MB | 2 736 ms |
| 5 000 cols × 500 rows | 4.82 MB | 7 534 ms |
| 20 000 cols × 400 rows | 15.4 MB | 30 581 ms |

All of this runs synchronously on the single Node event loop. Confirmed end to end: with
one 4.81 MB upload in flight from organization *Attacker Inc*, a `GET /api/people` from
a different organization took **7 591 ms and then died with ECONNRESET**, against a
2 ms baseline. The instance is wedged for every tenant for the duration, and the 10 MB
default limit permits ~15 s of block per request.

Combined with H1 (no effective upload throttle) and H5 (anyone can obtain an `it` token
by registering), this is a sustained, anonymous, whole-service denial of service.

**Fix:** build the alias lookup once per file instead of per field — precompute a
`normalizeKey(header) → index` map after parsing and have `field()` do a map lookup.
Additionally cap header count (e.g. 256) and row count in `parseCsv`, and move the import
off the request path onto a worker thread or a queue.

### H3 — A malformed `SAAS_MAX_UPLOAD_MB` silently disables the upload limit and one request kills the process

**Files:** `saas/src/server.js:28`, `saas/src/http.js:94-107`, `saas/.env.example:7`
**Status:** CONFIRMED

`maxUploadBytes = Number(process.env.SAAS_MAX_UPLOAD_MB || 10) * 1024 * 1024`. If the
variable is set to anything non-numeric the result is `NaN`, and the guard in `readBody`
(`if (total > maxBytes)`) is `total > NaN`, which is always `false`. The size limit
disappears without any warning at boot.

`saas/.env.example:7` ships exactly such a value — the JWT secret placeholder has been
concatenated onto the upload line:

```
SAAS_MAX_UPLOAD_MB=10replace-with-a-long-random-secret
```

`Number("10replace-with-a-long-random-secret")` is `NaN`. Anyone who copies
`.env.example` to `.env` gets an instance with no upload ceiling.

Confirmed: with that exact value, a single 220 MB `POST /api/import/preview` was
accepted and the server died with a V8 out-of-memory abort. The health endpoint was dead
afterwards. On Render this is a container restart and dropped sessions for every tenant,
repeatable at will.

**Fix:** validate the parsed number at boot (`Number.isFinite` and `> 0`, otherwise
throw), and make `readBody` fail closed by defaulting `maxBytes` when it is not finite.
Fix `.env.example` — it also leaves `SAAS_JWT_SECRET` empty on line 4, which feeds C1.

### H4 — Pilot admin passwords are a deterministic function of the account e-mail, printed in cleartext, and documented in the repo

**Files:** `saas/scripts/seed-test-env.js:33-38` and `:210`, `saas/TEST-ENV.md:44-48`
**Status:** CONFIRMED (code and staging state; I did not attempt to log in as a seeded account)

Every seeded account is generated as:

```js
admin: { email: `admin-${lower}-${suffix}@pilot.test`, password: `Pilot-${suffix}-admin-${lower}` }
```

The password contains no secret material that is not already in the e-mail address. The
same `suffix` also appears in the organization name (`Pilot Alpha ${suffix}`), and
`TEST-ENV.md:44-48` publishes the derivation table. Anyone who learns one pilot e-mail
address — from a screenshot, a demo, a CI log, a support ticket, a shared browser — owns
the **admin** account of that organization on the live internet-facing instance.

`printSummary` (`:210`) then writes all six passwords to stdout in cleartext, so any CI
job or terminal scrollback that ran the seeder is a credential store.

This is made permanent by the API surface: there is no delete route for organizations,
users, memberships or invitations (`reset-test-env.js:26-40` says so explicitly), so
every seeded admin account that has ever been created against staging is still live and
still reachable.

**Fix:** generate each password from `randomBytes(24).toString('base64url')`,
independently of the e-mail; write credentials to a git-ignored file with mode `0600`
rather than stdout; remove the derivation table from `TEST-ENV.md`; rotate or delete
every account already seeded against staging.

### H5 — Self-service registration is open on the live EU staging instance

**Files:** `saas/src/server.js:27` and `:76-84`, `render.yaml:27-39`
**Status:** CONFIRMED

`allowRegistration` defaults to `true` (`!== 'false'`), and `render.yaml` never sets
`SAAS_ALLOW_REGISTRATION`. Confirmed against staging: `POST /api/auth/register` with an
empty payload returns `400 {"error":"orgName, email and password (min 8 chars) are
required"}`, not the `403` that the disabled path produces. Registration is live.

On its own this is an abuse and data-hygiene problem — unlimited tenant creation against
a free-tier Postgres with no deletion route, and no e-mail verification (see M8). Its
real weight is as a precondition: it hands any anonymous internet user an `admin` token
in one request, which is what turns H2 and H3 from "a malicious customer can" into "a
stranger can".

**Fix:** set `SAAS_ALLOW_REGISTRATION=false` on the staging service and drive pilot
onboarding through invitations. Flip the default in `server.js:27` to opt-in.

---

## Medium

### M1 — Login timing oracle enumerates registered accounts

**File:** `saas/src/server.js:256-258`
**Status:** CONFIRMED

`if (!user || !verifyPassword(...))` short-circuits: when the e-mail is unknown, the
~28 ms `scryptSync` never runs. Measured over 25 paired samples against a local
instance: **26.8 ms median for a registered address, 0.9 ms for an unknown one**. A 30×
difference is trivially readable over the network, and H1 removes the request ceiling.

An attacker can enumerate which e-mail addresses — and therefore which companies — are
customers, which is itself commercially sensitive for a pilot product.

**Fix:** always run the KDF. Keep a fixed dummy hash and verify against it when the user
row is missing.

### M2 — Internal error details are returned to the client

**Files:** `saas/src/http.js:70-74`, `saas/src/server.js:815-838`
**Status:** CONFIRMED

`sendError` returns `error.message` verbatim for every status, including 500. Confirmed
responses from a local instance:

- `GET /app.js%00.txt` → `500 {"error":"The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received '/Users/.../saas/public/app.js\x00.txt'"}` — the absolute server filesystem path, unauthenticated.
- `GET /%zz` → `500 {"error":"URI malformed"}` — `decodeURIComponent` at `server.js:816` is not guarded.
- Import with a bad `source` → `500 {"error":"CHECK constraint failed: source IN ('intune', 'jamf')"}` — raw schema disclosure (see M3).

On staging the null-byte request is rejected by Cloudflare before it reaches the app, so
that specific leak is not currently reachable there; the constraint-error leak is.

**Fix:** return a generic message plus a correlation id for any status ≥ 500 and log the
detail server-side. Wrap `decodeURIComponent` and reject undecodable paths with 400.

### M3 — Unvalidated `source` form field reaches a constrained column and bypasses source detection

**Files:** `saas/src/import-service.js:22`, `src/import/detect-source.js:22`,
`saas/src/server.js:610-633`, `saas/src/migrations.js:80`
**Status:** CONFIRMED

`detectSource` returns `requestedSource` verbatim for any value other than `auto`,
`import-service.js` then treats anything that is not `intune` as Jamf, and the value is
inserted into `import_batches.source`, which carries
`CHECK (source IN ('intune','jamf'))`. Confirmed: a multipart field `source=evil`
produced `500 CHECK constraint failed: source IN ('intune', 'jamf')`. The value never
reaches SQL text (it is a bound parameter), so this is not injection — it is unvalidated
input reaching the database and returning schema detail to the caller.

**Fix:** validate against the allow-list in `handleApi` before calling the import
service, and reject with 400.

### M4 — Personal data survives deletion; GDPR erasure cannot be satisfied through the product

**Files:** `saas/src/server.js:636-653` (import row storage), `:539-545` (`deletePerson`),
`:798-812` (audit), `saas/src/migrations.js:88-98`
**Status:** CONFIRMED

`createImportPreview` stores `JSON.stringify(row)` into `import_rows.data_json`. That
object contains the full person record mapped from the MDM export — first name, last
name, work e-mail, department, job title. `DELETE /api/people/:id` only touches the
`people` table.

Confirmed locally: imported `maria.ionescu@client.example`, deleted the person through
the API until `GET /api/people` returned `[]`, then read the database directly:

```
rows still in import_rows: 1
retained PII -> {"firstName":"Maria","lastName":"Ionescu","email":"maria.ionescu@client.example","department":"Finance","role":""}
```

There is no API route to delete an import batch, an import row, an audit entry, a
membership, a user or an organization. For an EU-targeted product handling employee data
from Intune and Jamf exports, an Article 17 erasure request currently requires manual SQL
against the production database, and there is no retention policy or expiry on
`import_rows` or `audit_logs` at all.

**Fix:** cascade person deletion into `import_rows` (or store only non-identifying keys
in the preview and re-read PII at apply time), add a retention job that drops preview
batches after N days, and add an organization-deletion endpoint so teardown does not
require database access.

### M5 — Real employees of a named company are hardcoded in the deployed bundle, and one of their rules still runs for every tenant

**Files:** `src/settings/defaults.js:9-40`, `src/import/excluded-users.js:49`,
`render.yaml:20-26`
**Status:** CONFIRMED

`defaults.js` contains nine real work e-mail addresses at `tchibo.ro`,
`tchibo.bg`, `tchibo.onmicrosoft.com` and `tchibo-external.com`, three full names with
their alias addresses, and `DEFAULT_EXCLUDED_NAME_RULES` — a list of six named
individuals flagged for exclusion. `render.yaml:20-26` includes `src/settings/**` in the
build filter, so this file is deployed to the multi-tenant host where other clients'
data lives. It is also in the git history of a repository that will be shared with
pilot clients.

`import-service.js:11-12` correctly opts out of these lists with `useDefaults: false`,
but `excluded-users.js:49` is a hardcoded regex that the opt-out does not clear:

```js
if (/(^|[\s,;@._-])notificari([\s,;@._-]|$)/.test(haystack)) return true;
```

Confirmed: importing a row for `notificari@othercompany.example` — an unrelated tenant —
silently produced `person: null`, so the device is imported with no owner and no warning.

**Fix:** move the defaults out of `src/settings/defaults.js` into single-tenant runtime
configuration and purge them from the history; delete the hardcoded `notificari` rule so
the `useDefaults: false` contract actually holds.

### M6 — No `.dockerignore`: the local database and any `.env` are baked into the image, which runs as root

**Files:** `saas/Dockerfile:9-12`, (missing) `.dockerignore`
**Status:** CONFIRMED (file state; the image was not built)

`COPY saas ./saas` copies the entire working directory. `saas/data/saas.sqlite` exists
(155 KB, containing user rows and scrypt password hashes from local development) and is
git-ignored but **not** docker-ignored, so it ships inside the image — as does any local
`.env` and the `node_modules` tree, which overwrites the `npm ci --omit=dev` layer and
reintroduces dev dependencies. There is no `USER` directive, so the container runs as
root.

Staging uses `runtime: node` (`render.yaml:12`), not this Dockerfile, so it is not the
current live exposure — but the Dockerfile is the documented path for any other
deployment.

**Fix:** add a `.dockerignore` covering `data/`, `.env*`, `node_modules`, `test/`; add
`USER node` before `CMD`.

### M7 — Invitation tokens travel in the URL query string

**Files:** `saas/src/server.js:377-386`, `:389-457`
**Status:** SUSPECTED (flow confirmed locally; log retention inferred)

The invitation link is `${protocol}://${host}/?invite=${token}`. Query strings are
recorded by Cloudflare and Render access logs, browser history and any intermediate
proxy. `Referrer-Policy: no-referrer` (`server.js:909`) blocks the referer leak, but not
the logs.

The token is a pure bearer capability: `acceptInvitation` takes only `token` and
`password`. If the invited e-mail has no account yet, whoever holds the link creates the
account and joins the organization with the invited role — including `admin`. Tokens are
valid for 7 days and are 32 random bytes, so guessing is not the issue; log exposure is.

`hostName` also comes from `req.headers.host` (`:379`) with no allow-list, so a Host
header injection poisons the link that the admin is shown.

**Fix:** deliver the token in the URL fragment (`/#invite=…`) or in a POST body, bind
acceptance to a confirmation of the invited address, shorten the lifetime, and build the
link from a configured `PUBLIC_BASE_URL` instead of the Host header.

### M8 — No e-mail verification: account and identity squatting

**Files:** `saas/src/server.js:207-251`, `:389-418`
**Status:** CONFIRMED (registration accepts arbitrary addresses; squatting consequence reasoned)

`register` creates a user for any address with no proof of control, and with open
registration (H5) that is anonymous. An attacker can claim `ceo@victim-client.com`.
Later, when a real organization invites that address, `acceptInvitation:407-410` demands
"the existing account password" — which only the squatter knows — so the legitimate
person is locked out of onboarding, while the squatter can accept any invitation sent to
that address if they obtain the link.

**Fix:** verify the address before the account becomes usable, and key invitation
acceptance to a freshly verified address rather than to a pre-existing password.

---

## Low

### L1 — scrypt parameters are at the floor, and hashing blocks the event loop

**File:** `saas/src/auth.js:6-18`
**Status:** CONFIRMED

`scryptSync(password, salt, 64)` uses Node's defaults (N=16384, r=8, p=1). Measured at
27.6 ms per call on this hardware — the minimum OWASP tolerates, and low for 2026. It is
also *synchronous*: every login, registration and invitation acceptance blocks the whole
server for ~28 ms, which with H1 is an easy secondary DoS lever.

**Fix:** switch to the async `scrypt` (or `argon2id`), raise N to 2¹⁷ with an explicit
`maxmem`, and record the parameters in the stored hash string so they can be migrated.

### L2 — `postgresSql()` rewrites `?` blindly — currently correct, structurally fragile

**File:** `saas/src/db.js:145-148`
**Status:** CONFIRMED clean today

`sql.replace(/\?/g, () => '$' + ++index)` has no awareness of string literals, quoted
identifiers, casts or Postgres JSON operators. I audited every SQL string in `saas/src`:
none contains a `?` other than as a placeholder, no query is built by interpolation
(`rg '\$\{'` over the SQL strings returns nothing), and `migrate()` routes DDL through
`exec()`, which skips the rewrite — so the plpgsql `$$` blocks in `migrations.js:155-171`
are untouched. There is no injection today.

The hazard is the next query. A literal `?` — a `LIKE '%?%'`, a JSON `?` containment
operator, a comment — shifts every subsequent parameter number and silently binds values
to the wrong columns. In an organization-scoped `WHERE`, that is a tenant isolation bug
that no test would obviously catch.

**Fix:** replace with a tokenizer that skips quoted regions, or drop the abstraction and
write `$n` directly with a small helper per dialect. Add a unit test asserting that
placeholder count equals parameter count for every query.

### L3 — `listAssets` joins `people` without an organization predicate

**File:** `saas/src/server.js:548-557` (`:553`)
**Status:** SUSPECTED

`LEFT JOIN people p ON p.id = a.person_id` has no `AND p.organization_id = a.organization_id`.
Today nothing can write a foreign `person_id`: `createAsset:566-571` validates it, and
both dialects enforce it with a trigger (`migrations.js:116-137`, `:154-170`). But the
query is the last line of defence and it is not scoped — if the trigger is ever dropped
in a migration, this endpoint starts returning another tenant's employee names.

**Fix:** add the predicate.

### L4 — Multipart parser: lenient boundary handling and unsanitised stored filename

**File:** `saas/src/http.js:13-58`
**Status:** CONFIRMED (behaviours), no exploit found

Verified against a local instance:

- Path traversal in `filename` is defeated — `originalName.split(/[/\\]/).pop()` at `:45` reduced `../../../../etc/cron.d/x.csv` to `x.csv`, and the buffer is never written to disk.
- `boundary=XB ` (trailing space) is accepted with the space as part of the marker; a degenerate `boundary=-` is accepted. Both are self-inflicted, not attacks.
- Size enforcement works when the limit is a valid number (12 MB → `413`). See H3 for when it is not.
- A `__proto__` field name does not pollute: `fields` is a plain object and the assigned value is a string, so the `__proto__` setter ignores it. Same for a `__proto__` CSV header in `csv-parser.js:46-52`. Both refuted.

The one real residue: `filename` is stored verbatim in `import_batches.file_name` and
echoed in the preview response. `<img src=x onerror=alert(1)>.csv` round-tripped
intact. The frontend never renders `fileName`, and CSP blocks inline handlers, so it is
not XSS today — but it is stored attacker input awaiting a future consumer.

**Fix:** validate `filename` against `^[\w.\- ]{1,120}$` and reject otherwise; trim the
boundary and require it to match `^[A-Za-z0-9'()+_,\-./:=? ]{1,70}$` per RFC 2046.

### L5 — `uniqueSlug` issues one query per name collision

**File:** `saas/src/server.js:862-870`
**Status:** SUSPECTED

The loop probes `slug`, `slug-2`, `slug-3`… one `SELECT` at a time. With open
registration and no working rate limit, registering N organizations all named "Acme"
makes registration N+1 issue N sequential round-trips to a free-tier database.

**Fix:** append a short random suffix on the first collision instead of counting.

### L6 — `/api/ready` hits the database unauthenticated and unthrottled

**File:** `saas/src/server.js:71-74`
**Status:** CONFIRMED reachable on staging

Every request runs `db.ping()`. There is no rate limit on this route. Against a free-tier
Postgres with `DATABASE_POOL_MAX=10`, a modest request flood consumes connections that
paying traffic needs. It also confirms the database dialect to anonymous callers.

**Fix:** cache the readiness result for a few seconds and rate-limit the route.

### Also worth fixing, without a standalone attack

- `DATABASE_SSL=false` (`render.yaml:39-40`) disables TLS to Postgres. Render's internal network makes this low-risk, but it means employee PII moves unencrypted between the two services, which is awkward to defend in an EU DPA.
- `detect-source.js:28` throws a Romanian-language message that is surfaced to end users of an English product: `500 {"error":"Nu pot detecta sursa CSV..."}`.
- `escapeHtml` (`saas/public/app.js:517-523`) does not escape `'`. Every current raw attribute interpolation uses double quotes and server-generated UUIDs, so it is safe today; add `&#39;` anyway.
- There is no member-removal endpoint, no password change and no token revocation list. A compromised token stays valid for its full 12 hours unless the membership row is deleted by hand.

---

## What is solid

These were actively attacked and behaved correctly. Listing them so the findings above
are read in proportion.

**Tenant isolation.** I walked all 37 SQL statements in `server.js`; every query that
touches tenant data carries an `organization_id` predicate, and the two lookups that do
not (`invitations` by `token_hash`, `users` by e-mail at login) are correct by design.
Executed with a valid organization-B admin token against organization-A resources:

| Attack | Result |
| --- | --- |
| `DELETE /api/people/<A's id>` | `404 Person not found` |
| `DELETE /api/assets/<A's id>` | `404 Asset not found` |
| `GET /api/people` | `[]` |
| `POST /api/assets` with A's `personId` | `400 Person does not belong to this organization` |
| `PUT /api/members/<A's admin>/role` | `404 Member not found` |
| `POST /api/auth/switch-organization` → org A | `401 User does not belong to that organization` |

The DELETE paths scope on `id AND organization_id` in a single statement
(`server.js:540-543`, `:598-601`) and use the affected-row count for the 404, so there is
no lookup-then-delete window. `applyImportBatch` re-scopes both the batch and its rows
(`:668-680`). Cross-organization person assignment is blocked in three independent
places: the handler check, a SQLite trigger and a Postgres trigger.

**JWT verification.** `verifyToken` (`auth.js:31-46`) ignores the header's `alg` and
always recomputes HMAC-SHA256, compares with `timingSafeEqual` after a length check, and
parses the payload only after the signature passes. Rejected with `401`: `alg=none` with
an empty signature, `alg=none` with a junk signature, `HS256` with an empty signature, a
real token with a tampered `org` claim, a validly signed token with no `exp`, a validly
signed token for a user in another organization, and a token signed with the default
secret when a real secret was configured. No algorithm confusion, no unverified
signature, no missing expiry check, no timing leak. C1 is about how the secret is
*chosen*, not about this code.

**Authorization.** Role is never trusted from the token. `requireSession`
(`server.js:183-197`) re-reads the membership row on every request and takes the role
from the database; the `role` claim in the JWT is decorative. Confirmed: promoting a
`readonly` member to `it` made their **existing** token able to create people
immediately (201), and demoting them made the same token fail immediately (403) — no
re-login in either direction. Deleting a membership invalidates every live token for
that organization. `requireRole` is present on every mutating route and on
`/api/members` and `/api/audit`; a `readonly` token got 403 on person creation, person
deletion, import preview, import apply, invitation creation, member listing and audit
listing.

**SQL injection.** No string-interpolated SQL anywhere in `saas/src`. Every value is a
bound parameter. See L2 for the latent `postgresSql()` hazard, which is a future risk,
not a present one.

**Static file serving.** All of `/../package.json`, `/%2e%2e/package.json`,
`/..%2f..%2fpackage.json`, `/%2e%2e%2f%2e%2e%2fsaas/package.json`, `/....//package.json`
and an overlong-UTF-8 variant returned the SPA fallback, not file contents. The
`normalize` + `startsWith(publicDir)` pair at `server.js:817-821` holds. Only the
null-byte variant misbehaves, and that is an error-message leak (M2), not traversal.

**Frontend XSS.** Every interpolation of server data into `innerHTML` in
`saas/public/app.js` goes through `escapeHtml` — person names, asset tags, serials,
models, organization names, member names and e-mails, audit rows, CSV-derived preview
cells, and the invite URL. The handful of unescaped interpolations (`:107`, `:184`,
`:239`, `:264`, `:292`, `:355`, `:434`) are all server-generated UUIDs inside
double-quoted attributes. CSP is `script-src 'self'` with no `unsafe-inline`
(`server.js:911-914`) and is present on staging responses. I found no XSS.

**Prototype pollution.** Refuted on three paths: a JSON body with `__proto__`, a
multipart field named `__proto__`, and a CSV column header named `__proto__`. In each
case the assigned value is a string, which the `__proto__` setter discards.
`Object.prototype` was unmodified afterwards.

**Body size limits** work as intended when configured with a valid number: a 12 MB upload
and a 2 MB JSON body both returned `413`.

**Security headers** are set on every response including static files, and were observed
on staging: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`, the CSP above, and HSTS behind `x-forwarded-proto: https`.

---

## What I could not test

- **PostgreSQL behaviour.** All dynamic testing ran against SQLite. The Postgres adapter,
  its trigger, and `postgresSql()` were reviewed by reading only. L2's conclusion that the
  rewrite is currently correct comes from a static audit of every query string, not from
  execution against Postgres.
- **Staging under load.** I did not run the H1 rate-limit bypass, the H2 import DoS or the
  H3 memory exhaustion against the live instance, per the brief. H1 and H2 are confirmed
  locally on identical code; the staging-side claim that Cloudflare and Render append
  rather than replace `X-Forwarded-For` is from vendor behaviour, not measured here.
- **Seeded pilot accounts.** I did not authenticate as any seeded account on staging, so
  H4 is confirmed from the generator and the documentation rather than by logging in.
- **Multi-instance rate limiting.** `rateLimits` is a per-process `Map`
  (`server.js:31`). On a single free-tier instance that is merely weak; if the service is
  ever scaled out, the effective limit multiplies by the instance count and resets on
  every deploy. Not testable on the current single-instance deployment.
- **Render platform configuration** — dashboard-level environment variables, log
  retention, database backups and access controls — is outside the repository and was not
  reviewed.
