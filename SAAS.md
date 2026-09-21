# Local app vs SaaS — working agreement

| Branch | Purpose | Cursor workspace |
|--------|---------|------------------|
| `local` | Offline Windows / LAN app (`src/`, `public/`, `install/`) | **it-inventory** |
| `saas` | Multi-client cloud MVP (`saas/`) | **this repo / SaaS cloud agent** |

See [saas/WORKSPACE.md](./saas/WORKSPACE.md) for the SaaS handoff and ownership rules.

## Decisions

1. Work on a **branch** (not monorepo packages yet)
2. SaaS is a **multi-client product**
3. First cloud release is an **MVP** (auth + org + people + devices)
4. **Workspace split (2026-09-21):** continue the local server app in the it-inventory
   workspace; continue SaaS only here. Cherry-pick shared `src/import|settings|utils`
   fixes across branches when both products need them.

## Commands

```bash
# Local offline app (port 8080) — primary work: it-inventory workspace
git checkout local
npm start

# SaaS MVP (port 8090) — primary work: this workspace
git checkout saas
cd saas && SAAS_JWT_SECRET=$(openssl rand -hex 32) npm start
```

## Status on `saas` (supersedes the old “Next” checklist)

Already landed: per-org Intune/Jamf CSV import, invitations, Postgres on Render staging,
registration gate, JWT-secret required, trusted-proxy rate limits.

Next priority: **Phase 0** in [saas/ROADMAP.md](./saas/ROADMAP.md) (paid DB before
**2026-10-21**), then remaining items in [saas/SECURITY-REVIEW.md](./saas/SECURITY-REVIEW.md).
