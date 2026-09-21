# Inventar IT

Aplicatie web offline pentru gestionarea obiectelor IT: laptopuri Lenovo/MacBook, telefoane iPhone/Samsung, persoane, alocari, istoric si facturi PDF.

## Cerinte

- Node.js 20 LTS sau mai nou
- Nu are dependinte npm externe
- Nu are nevoie de internet la rulare

## Pornire locala

```bash
npm start
```

Aplicatia porneste implicit pe `http://localhost:8080`.

## SaaS (branch `saas`)

Experiment multi-client pe branch-ul `saas`, folder `saas/` (port `8090`).  
Vezi [SAAS.md](./SAAS.md).

## Configurare

Variabile de mediu optionale:

- `PORT`: portul HTTP, implicit `8080`
- `HOST`: adresa de ascultare, implicit `0.0.0.0`
- `ITINV_DB_PATH`: calea catre baza JSON, implicit `data/app.db.json`
- `ITINV_UPLOAD_PATH`: folder facturi PDF, implicit `data/uploads`
- `ITINV_MAX_UPLOAD_MB`: limita upload PDF, implicit `20`

## Date stocate

- Catalogul de modele se initializeaza din `seed/models.json`
- Datele aplicatiei sunt in `data/app.db.json`
- Facturile PDF sunt in `data/uploads/invoices/`

## Functionalitati

- Dashboard cu totaluri, alocari recente si garantii care expira
- CRUD dispozitive si persoane
- Catalog predefinit Lenovo, MacBook, iPhone si Samsung
- Reasignare dispozitiv intre persoane cu inchidere automata a alocarii vechi
- Returnare dispozitiv in stoc
- Audit trail pentru creare, actualizare, alocare, reasignare si upload factura
- Upload/download PDF pentru facturi
- Export CSV inventar pentru Excel
- Import manual CSV/ZIP din Intune si CSV din Jamf, cu preview inainte de salvare

## Import Intune si Jamf

In aplicatie, deschide pagina `Import`, incarca fisierul si apasa `Previzualizeaza import`. Aplicatia detecteaza automat sursa, arata ce dispozitive vor fi create/actualizate/reasignate si importa doar dupa confirmare.

### Export Intune

1. Intra in Microsoft Intune admin center.
2. Mergi la `Devices` > `All devices`.
3. Apasa `Export`.
4. Alege `Include all inventory data in the exported file`.
5. Incarca direct ZIP-ul descarcat in aplicatie.

Coloane folosite: `Serial number`, `Device name`, `Management name`, `Manufacturer`, `Model`, `OS`, `OS version`, `IMEI`, `Primary user UPN`, `Primary user display name`, `Primary user email address`, `Device ID`, `Last check-in`.

### Export Jamf

1. In Jamf Pro, mergi la `Computers` > `Search Inventory` > `New Advanced Search`.
2. In tab-ul `Display`, selecteaza: `Computer Name`, `Serial Number`, `Make`, `Model`, `Model Identifier`, `Asset Tag`, `Username`, `Full Name`, `Email Address`, `Department`, `Position`, `Operating System`, `Operating System Version`, `Total RAM MB`, `Jamf Pro Computer ID`.
3. Salveaza cautarea ca `Inventar IT Export`.
4. Ruleaza cautarea si alege `Export` > `CSV`.
5. Incarca CSV-ul in aplicatie.

Re-importul aceluiasi fisier nu creeaza duplicate. Matching-ul se face pe `Serial number`, apoi pe ID-ul extern Intune/Jamf.

## Pachet Windows

```bash
npm run package:windows
```

Rezultatul este in `dist/it-inventory-node` si poate fi copiat pe Windows Server.
