# IT Inventory — ce repari azi între Entra și MDM

**O frază:** Vezi cine are ce device, ce nu se potrivește între Entra și Jamf/Intune, și ce trebuie reparat azi — fără încă un spreadsheet.

## Problema

Directory (Entra) spune una. MDM (Jamf / Intune) spune alta. Excel-ul spune a treia. Leavers rămân cu laptop assigned. Duplicate după fiecare export. Nimeni nu are un inbox comun „ce e stricat”.

## Ce face produsul

- **People** din Entra (live Graph sau CSV)
- **Devices** din Jamf / Intune / alte MDM (CSV sau live sync)
- **Issues inbox** după fiecare sync/import:
  - user activ fără device
  - device fără owner
  - cont disabled care încă ține device
  - stale check-in
  - missing from MDM
  - owner mismatch
  - posibile duplicate
- Assign / snooze / resolve / dismiss + audit
- Multi-tenant, roluri admin / IT / read-only, EU staging

**Nimic nu se scrie înapoi în Entra sau Jamf** — IT rămâne la control.

## Ce nu suntem (ca să nu ne confunde)

- **Virima / Lansweeper** — CMDB + discovery de infrastructură
- **Workwize / Firstbase** — logistics (cumpără / livrează / recuperează laptopuri)
- **Noi** — Issues între Entra și MDM (adevărul de ownership, azi)

Detalii: [COMPETITIVE.md](COMPETITIVE.md).

## Pilot 2 săptămâni

1. Conectezi Entra (sau un export users)
2. Importi un export Jamf sau Intune
3. Deschizi Issues și triați primele high/medium
4. Re-sync mid-week — Issues se închid singure când condiția dispare

**Succes:** mai puține întrebări „cine are Mac-ul ăsta?”, o listă Issues comună, leavers și ghost devices vizibile.

## Preț (manual invoice, fără card in-app)

| Plan | Devices | Preț |
|------|---------|------|
| Trial 14 zile | 50 | €0 |
| Starter | 100 | €79 / lună |
| Team | 500 | €199 / lună |
| Org | custom | negociat |

## Contact

Andrei Popescu · staging: https://it-inventory-saas-staging.onrender.com
