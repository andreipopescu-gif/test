#!/usr/bin/env node
/**
 * Compare Intune CSV/ZIP (local file) against server inventory.
 * Usage:
 *   node install/diagnose-import-duplicates.js ./export.zip http://10.110.102.44:8080
 */
import { readFile } from 'node:fs/promises';
import { parseCsv } from '../src/import/csv-parser.js';
import { extractFirstCsvFromZip, isZip } from '../src/import/zip-reader.js';

const csvPath = process.argv[2];
const baseUrl = (process.argv[3] || 'http://localhost:8080').replace(/\/$/, '');

if (!csvPath) {
  console.error('Usage: node install/diagnose-import-duplicates.js <csv-or-zip-path> [server-url]');
  process.exit(1);
}

function field(record, names) {
  const wanted = names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [key, value] of Object.entries(record)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (wanted.includes(norm) && String(value ?? '').trim()) return String(value).trim();
  }
  return '';
}

let buffer = await readFile(csvPath);
let sourceName = csvPath;
if (isZip(buffer)) {
  const extracted = extractFirstCsvFromZip(buffer);
  buffer = extracted.buffer;
  sourceName = `${csvPath} → ${extracted.fileName}`;
}

const { records } = parseCsv(buffer);
const assets = await fetch(`${baseUrl}/api/assets`).then((r) => {
  if (!r.ok) throw new Error(`Server ${r.status}: ${r.statusText}`);
  return r.json();
});

const bySerial = new Map();
const byTag = new Map();
for (const a of assets) {
  if (a.serialNumber) bySerial.set(a.serialNumber.toLowerCase(), a);
  if (a.assetTag) byTag.set(a.assetTag.toLowerCase(), a);
}

const seenSerial = new Map();
const seenTag = new Map();
const issues = [];

for (const record of records) {
  const line = record.__line ?? '?';
  const serial = field(record, ['Serial number', 'Serial Number']);
  const tag = field(record, ['Device name', 'Device Name', 'Management name', 'Management Name']);
  if (!serial && !tag) continue;

  if (serial) {
    const key = serial.toLowerCase();
    if (seenSerial.has(key)) {
      issues.push({ line, type: 'CSV duplicate serial', serial, tag, detail: `also line ${seenSerial.get(key)}` });
    } else seenSerial.set(key, line);
  }

  if (tag) {
    const key = tag.toLowerCase();
    if (seenTag.has(key)) {
      issues.push({ line, type: 'CSV duplicate tag', serial, tag, detail: `also line ${seenTag.get(key)}` });
    } else seenTag.set(key, line);
  }

  if (serial && tag) {
    const bySn = bySerial.get(serial.toLowerCase());
    const byTg = byTag.get(tag.toLowerCase());
    if (bySn && byTg && bySn.id !== byTg.id) {
      issues.push({
        line,
        type: 'IMPORT COLLISION (tag vs serial on different devices)',
        serial,
        tag,
        detail: `tag→${byTg.assetTag} (serial ${byTg.serialNumber}) vs serial→${bySn.assetTag} — import fails with "exista deja"`
      });
    } else if (bySn && !byTg) {
      issues.push({ line, type: 'Serial in DB', serial, tag, detail: `will UPDATE ${bySn.assetTag}` });
    } else if (byTg && !bySn && byTg.serialNumber?.toLowerCase() !== serial.toLowerCase()) {
      issues.push({ line, type: 'Tag in DB, serial changes', serial, tag, detail: `DB serial was ${byTg.serialNumber}` });
    }
  } else if (serial && bySerial.has(serial.toLowerCase())) {
    issues.push({ line, type: 'Serial in DB', serial, tag, detail: `DB tag: ${bySerial.get(serial.toLowerCase()).assetTag}` });
  } else if (tag && byTag.has(tag.toLowerCase())) {
    const db = byTag.get(tag.toLowerCase());
    issues.push({ line, type: 'Tag in DB', serial, tag, detail: `DB serial: ${db.serialNumber}` });
  }
}

console.log(`Server: ${baseUrl}`);
console.log(`File: ${sourceName}`);
console.log(`Assets in DB: ${assets.length}`);
console.log(`CSV rows: ${records.length}`);

const critical = issues.filter((i) => i.type.includes('COLLISION') || i.type.includes('duplicate'));
const info = issues.filter((i) => !critical.includes(i));

if (!issues.length) {
  console.log('OK — no conflicts found.');
} else {
  if (critical.length) {
    console.log(`\nCRITICAL (${critical.length}) — these block import:`);
    for (const i of critical) {
      console.log(`  Line ${i.line} [${i.type}] serial=${i.serial} tag=${i.tag}`);
      console.log(`    ${i.detail}`);
    }
  }
  if (info.length) {
    console.log(`\nInfo (${info.length}) — existing devices that will be updated:`);
    for (const i of info.slice(0, 15)) {
      console.log(`  Line ${i.line} [${i.type}] serial=${i.serial || '-'} tag=${i.tag || '-'} — ${i.detail}`);
    }
    if (info.length > 15) console.log(`  ... and ${info.length - 15} more`);
  }
}
