# GTM outreach — IT Inventory (stadiu MVP / pilot)

Tot ce trebuie ca să pornești vânzarea în stadiul actual.
Owner: Andrei Popescu.

## Ce e gata

| Fișier | Rol |
|--------|-----|
| [PIPELINE.md](PIPELINE.md) | Tracker cei 10 prospecti + status |
| [ONE-PAGER.md](ONE-PAGER.md) | One-pager de atașat / lipit în email |
| [emails/](emails/) | 10 drafturi personalizate (RO) |
| [linkedin/](linkedin/) | Mesaje scurte LinkedIn |
| [FOLLOW-UPS.md](FOLLOW-UPS.md) | Secvență D+3 / D+7 / D+14 |
| [COMPETITIVE.md](COMPETITIVE.md) | Virima / Workwize / Korvini — ce spunem |
| `../../scripts/send-outreach.js` | Trimite via Resend când ai API key |

## Cum trimiți (3 variante)

### A) Copy-paste (0 setup)

1. Deschide `emails/01-everfast.md` … `10-*.md`
2. Copiază Subject + Body în Gmail/Outlook
3. Bifează în `PIPELINE.md`

### B) Script Resend (recomandat)

```bash
cd saas
export RESEND_API_KEY=re_xxx
export SALES_FROM_EMAIL="Andrei Popescu <andrei@domeniul-tau>"
export SALES_REPLY_TO="andrei@domeniul-tau"
# dry-run (afişează payload, nu trimite):
node scripts/send-outreach.js --dry-run
# trimite unul:
node scripts/send-outreach.js --only everfast
# trimite toate:
node scripts/send-outreach.js --all
```

### C) LinkedIn

Folosește `linkedin/*.md` pe company page sau persoana potrivită (IT / Modern Workplace / Owner).

## Staging pentru demo

- URL: https://it-inventory-saas-staging.onrender.com  
- Seed demo: `TARGET_URL=… SEED_REGISTRATION_TOKEN=… npm run seed:demo`  
- Pitch: [PILOT-PITCH.md](../../PILOT-PITCH.md)

## Reguli

- Nu trimite de pe email corporat extern (ex. client) — folosește domeniu propriu.
- Nu scriem înapoi în Entra/Jamf — menține asta în fiecare mesaj.
- Primii 3: Everfast → MEM.Zone → ProActiv.
