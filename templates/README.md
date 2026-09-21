Optional DOCX template for Tchibo handover documents.

If present, the app looks for:

- `pv-tchibo.docx`

Supported placeholders:

- `{{companyName}}`
- `{{title}}`
- `{{date}}`
- `{{dateFormatted}}`
- `{{dateLine}}`
- `{{introParagraph}}`
- `{{itOperator}}`
- `{{itOperatorIntro}}`
- `{{itOperatorRole}}`
- `{{itOperatorSignature}}`
- `{{personName}}`
- `{{personRole}}`
- `{{personSignature}}`
- `{{predatName}}`
- `{{primitName}}`
- `{{assetsTable}}` — full Word table XML with columns Tip, Model, IMEI / UDID / Tel., Serial No.
- `{{assetsText}}`
- `{{notes}}`

If the DOCX file is missing, the app generates the built-in Tchibo layout.

Extra table rows can be added from the PV form notes field:

- one line per extra item, e.g. `Card Securitate`
- or `Tip|Model|IMEI|Serial`, e.g. `Numar Vodafone||070000000|`
