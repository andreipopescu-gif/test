# Deploy offline pe Windows Server 2025

Acest proiect este gandit pentru servere pe care este instalat doar Node.js. Nu necesita .NET, IIS, SQL Server, npm install sau acces la internet la runtime.

## 1. Crearea pachetului

Pe o masina de dezvoltare:

```bash
npm run package:windows
```

Copiaza folderul `dist/it-inventory-node` pe server, de exemplu in `C:\Apps\ItInventory`.

## 2. Instalare ca Windows Service

Pe Windows Server 2025, deschide PowerShell ca Administrator:

```powershell
cd C:\Apps\ItInventory
powershell -ExecutionPolicy Bypass -File install\Install-ItInventory.ps1
```

Scriptul:

- verifica daca `node.exe` exista in `PATH`
- creeaza folderul de date
- creeaza serviciul Windows `ItInventory`
- deschide portul TCP `8080` in Windows Firewall
- porneste aplicatia

Aplicatia va fi disponibila la:

```text
http://nume-server:8080
```

## 3. Acces din reteaua companiei

Laptopurile echipei IT trebuie sa poata rezolva `nume-server` prin DNS intern. Daca nu exista DNS intern, se poate folosi IP-ul serverului:

```text
http://192.168.x.x:8080
```

Aplicatia nu are autentificare. Recomandarea este sa limitati accesul prin firewall/VLAN doar la echipa IT.

## 4. Backup

Backup manual:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Apps\ItInventory\install\Backup-ItInventory.ps1
```

Backup-ul include:

- `data\app.db.json`
- `data\uploads` cu facturile PDF

Pentru backup recurent, creati un task in Task Scheduler care ruleaza comanda de mai sus saptamanal.

## 4.1 Import periodic din Intune si Jamf

Serverul poate ramane offline. Exporturile se fac pe un laptop IT care are acces la Intune/Jamf, apoi fisierele se incarca manual in pagina `Import`.

Pentru Intune:

- `Devices` > `All devices` > `Export`
- alegeti `Include all inventory data in the exported file`
- incarcati ZIP-ul descarcat direct in aplicatie

Pentru Jamf:

- creati un `Advanced Computer Search` salvat ca `Inventar IT Export`
- folositi campurile recomandate din `README.md`
- exportati rezultatul ca CSV si incarcati CSV-ul in aplicatie

Re-importul este sigur: dispozitivele existente se actualizeaza pe baza seriei si ID-ului extern, iar dispozitivele care lipsesc din CSV nu sunt sterse automat.

## 4.2 Procese verbale

Pagina `PV-uri` genereaza procese verbale DOCX de primire/predare din alocarile active existente. Documentul nu modifica statusul dispozitivelor si nu inchide alocari.

Operatorii IT disponibili in formular sunt `Andrei Popescu` si `Dan Istrate`.

Aplicatia genereaza DOCX cu layout-ul Tchibo (antet, tabel, semnaturi). Pentru un template Word personalizat, puneti fisierul:

- `templates\pv-tchibo.docx`

Placeholder-ele suportate sunt documentate in `templates\README.md`.

## 5. Upgrade offline

1. Opriti serviciul:

   ```powershell
   Stop-Service ItInventory
   ```

2. Faceti backup:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Apps\ItInventory\install\Backup-ItInventory.ps1
   ```

3. Copiati fisierele noi peste instalarea existenta, dar pastrati folderul `data`.

   Pentru update-ul cu PV-uri si filtre noi, copiati cel putin:

   - `src\store.js`
   - `src\server.js`
   - `src\documents`
   - `public\app.js`
   - `public\index.html`
   - `public\styles.css`
   - `templates`
   - `scripts\package-windows.js` doar in mediul de build, nu pe server

4. Porniti serviciul:

   ```powershell
   Start-Service ItInventory
   ```

### Update rapid (recomandat)

```powershell
# Din folderul aplicatiei pe server, dupa ce ati copiat un zip delta:
powershell -ExecutionPolicy Bypass -File .\scripts\update.ps1 -Source C:\temp\it-inventory-delta.zip -AppDir C:\invapp -ServiceName ItInventory
```

Scriptul opreste serviciul, copiaza fisierele (pastrand `data`), reporneste si verifica `/api/health` + `/api/dashboard`.

### Export MDM automat (optional, pe masina cu acces Graph/Jamf)

```bash
# Entra users + Intune devices → CSV
AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=... node scripts/download-graph-exports.js

# Jamf computers → CSV
JAMF_URL=https://... JAMF_CLIENT_ID=... JAMF_CLIENT_SECRET=... node scripts/download-jamf-exports.js
```

Importati CSV-urile din UI (Import). Backup DB din **Settings → Download database**.

## 6. Dezinstalare

```powershell
powershell -ExecutionPolicy Bypass -File C:\Apps\ItInventory\install\Uninstall-ItInventory.ps1
```

Scriptul elimina serviciul si regula de firewall. Datele nu sunt sterse automat.
