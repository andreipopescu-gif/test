# Pilot pitch — IT Inventory SaaS

**One sentence:** See who has which device, what disagrees between Entra and your MDM, and what IT should fix today — without another spreadsheet.

## The problem pilots already feel

Directory (Entra) says one thing. Jamf / Intune says another. The asset sheet says a third. Offboarding leaves gear assigned. Duplicates pile up after every export. Nobody has a single inbox of “what is broken.”

## What the product does

| Area | What you get |
|------|----------------|
| **People directory** | Import from Entra (live Graph sync or CSV). Departments, status, UPN / Jamf usernames, merge duplicates. |
| **Devices** | Catalog of models, assign / reassign, serials, MDM presence, last seen. |
| **Issues inbox** | Automatic checks after every import or sync: active user with no device, device with no owner, disabled account still holding kit, stale check-in, missing from MDM, owner mismatch, possible duplicates. Assign, snooze, resolve, dismiss — with history. |
| **Connections** | Live **Microsoft Entra ID** (`User.Read.All`, client credentials). Demo connector for full issue demos. Jamf/Intune via CSV today; same pipeline when live sync lands. |
| **Import** | Intune / Jamf / Entra CSV or ZIP, preview before apply, model matching against the tenant catalog. |
| **Multi-tenant** | Each customer is an organization: isolated data, roles (admin / IT / read-only), invitations. |
| **Settings** | Issue rules & thresholds, editable catalog, options, encrypted connector credentials. |
| **Audit** | Mutations, assignments and imports are logged. |

Nothing in the Issues flow silently changes Entra or Jamf — IT stays in control.

## Why this is different

1. **Exception-first, not inventory-first.** Most tools show lists. This one answers “what do I fix today?” with severity, suggestion and workflow.
2. **One pipeline for file and live sync.** Entra Graph and CSV go through the same preview / apply / exception engine — no “sync said X, import said Y.”
3. **Directory ↔ MDM reconciliation out of the box.** Presence per source, last seen, owner mismatch and “missing from MDM” are first-class, not custom reports.
4. **Tenant-safe by design.** Organizations, roles and encrypted credentials — built for SaaS pilots, not a single-company Access DB on a share.
5. **Least privilege to Microsoft.** Application permission `User.Read.All` only; no admin passwords stored; connector secrets encrypted at rest (`SAAS_CONNECTOR_KEY`).
6. **Pilot-ready in days.** Staging tenants, invites, demo data seed, and a real Entra connection path — not a six-month SI project.

## Suggested 2-week pilot

1. Connect Entra (or drop a user export).  
2. Import one MDM export (Jamf or Intune CSV).  
3. Open **Issues** — triage the first high/medium items with IT.  
4. Invite read-only for a manager; IT for operators.  
5. Re-sync Entra mid-week; confirm issues open/close correctly.

**Success looks like:** fewer “who has this Mac?” chats, a shared Issues list, and confidence that disabled accounts and ghost devices surface without manual Excel.

## What we are honest about (roadmap, not blockers for a pilot)

- Live Jamf / Intune API sync still uses CSV (same UI path).  
- No lock / wipe / disable actions yet (by design until confirmed workflows).  
- MFA / licence / compliance checks come after live MDM connectors.

## Call to action

Start on staging with your Entra app registration, invite your IT lead as `it`, and run one sync + one MDM import. If Issues is empty, you are clean. If it is not — that is the work the pilot was meant to find.
