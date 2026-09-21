# Local app vs SaaS — working agreement

| Branch | Purpose |
|--------|---------|
| `local` | Offline Windows / LAN app (`src/`, `public/`, `install/`) |
| `saas` | Multi-client cloud MVP (`saas/`) |

## Decisions

1. Work on a **branch** (not monorepo packages yet)
2. SaaS is a **multi-client product**
3. First cloud release is an **MVP** (auth + org + people + devices)

## Commands

```bash
# Local offline app (port 8080)
git checkout local
npm start

# SaaS MVP (port 8090)
git checkout saas
cd saas && npm start
```

## Next on `saas`

1. CSV import (Intune/Jamf) per organization
2. Invite members to an org
3. Move SQLite → Postgres when hosting
4. Later: invoices, PV DOCX, MDM sync, billing
